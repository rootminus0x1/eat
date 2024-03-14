import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, MaxUint256, ZeroAddress, getAddress } from 'ethers';

import { parseArg } from './friendly';
import { SuffixMatch } from './graph';

const sourceDir = './eat-source';

import { IBlockchainAddress, BlockchainAddress, addTokenToWhale, getSigner, whale, getSignerAt } from './Blockchain';
import {
    Link,
    backLinks,
    contracts,
    links,
    readerTemplates,
    nodes,
    users,
    Role,
    roles,
    GraphNode,
    resetGraph,
    localNodes,
} from './graph';
import { getConfig, getFormatting, stringCompare, writeFile } from './config';
import { log, withLogging } from './logging';
import { ReaderTemplate, ReadingValue, callReader, makeReader } from './read';

const _dig = async (stack: string, loud: boolean = false) => {
    // we reset the graph (which is a set of global variables)
    resetGraph();
    type Address = { address: string; follow: number /* 0 = leaf 1 = twig else depth */; config?: boolean };
    const depth = getConfig().depth || 5; // don't go deeper than this, from any of the specified addresses
    const roots = getConfig().root?.map((a) => {
        return { address: a, follow: depth, config: true };
    });
    const twigs = getConfig().twig?.map((a) => {
        return { address: a, follow: 1, config: true };
    });
    const leafs = getConfig().leaf?.map((a) => {
        return { address: a, follow: 0, config: true };
    });
    const done = new Set<string>(getConfig().prune || []); // ensure addresses are only visited once and the pruned one no times

    // the addresses to search
    const addresses = roots || twigs || leafs;
    // the bounds of the search
    const limits = new Map<string, Address>();
    [...(twigs || []), ...(leafs || [])].forEach((a) => {
        limits.set(a.address, a);
    });

    const tempNodes = new Map<string, GraphNode>();
    while (addresses && addresses.length > 0) {
        addresses.sort((a, b) => b.follow - a.follow); // biggest follow first
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address.address)) {
            done.add(address.address);
            const blockchainAddress = digOne(address.address);
            if (blockchainAddress) {
                const dugUp = await digDeep(blockchainAddress);
                if (loud) {
                    const contractName = await blockchainAddress.contractName();
                    const logicName = await blockchainAddress.implementationContractName();
                    const tokenSymbol = await blockchainAddress.erc20Symbol();
                    const tokenName = await blockchainAddress.erc20Name();
                    let line: string[] = [`${address.address} :`];
                    if (tokenName || tokenSymbol) line.push(`${tokenSymbol} (${tokenName})`);
                    if (logicName) {
                        line.push(`"${contractName}"->"${logicName}"`);
                    } else {
                        line.push(`"${contractName}"`);
                    }
                    log(line.join(' '));
                }
                tempNodes.set(
                    address.address,
                    Object.assign(
                        {
                            address: address.address,
                            name: await blockchainAddress.contractNamish(),
                            leaf: address.follow == 0,
                            suffix: dugUp.suffix,
                        },
                        blockchainAddress,
                    ),
                );
                // add the readers to the contract
                readerTemplates.set(address.address, dugUp.readerTemplates);

                const addAddress = (address: string, follow: number) => {
                    // need to merge them as the depth shoud take on the larger of the two
                    const actualFollow = Math.max(follow - 1, 0);
                    const comingUp = addresses.findIndex((a, i) => a.address === address);
                    if (comingUp !== -1) {
                        // update the one that was coming up
                        // make it the longer depth, unless it's a config item
                        if (!addresses[comingUp].config)
                            addresses[comingUp].follow = Math.max(addresses[comingUp].follow, actualFollow);
                    } else {
                        // add a new one but within the config limits
                        const limited = limits.get(address);
                        addresses.push({
                            address: address,
                            follow: limited ? Math.min(actualFollow, limited.follow) : actualFollow,
                            config: limited ? true : false,
                        });
                    }
                };

                const addLinks = (nodeAddress: string, _toAdd: Link[], follow: number) => {
                    // only add an address if it has not been pruned
                    const toAdd = _toAdd.filter((a) => !getConfig()?.prune || !getConfig()?.prune?.includes(a.address));

                    // process the links
                    links.set(nodeAddress, (links.get(address.address) ?? []).concat(toAdd));
                    // and consequent backlinks and nodes
                    toAdd.forEach((link) => {
                        backLinks.set(
                            link.address,
                            (backLinks.get(link.address) ?? []).concat({ address: nodeAddress, name: link.name }),
                        );
                        addAddress(link.address, follow);
                    });
                };

                // follow the roles and the links, unless its a leaf
                if (address.follow) {
                    if (dugUp.roles.length) {
                        dugUp.roles.forEach((role: Role) =>
                            addLinks(
                                address.address,
                                role.addresses.map((a) => ({ address: a, name: role.name })),
                                address.follow,
                            ),
                        );
                        roles.set(address.address, dugUp.roles);
                    }
                    addLinks(address.address, dugUp.links, address.follow);
                }
            }
        }
    }

    const lookupContractName = async (address: string) => {
        const c = new BlockchainAddress(address);
        return c?.contractNamish() || undefined;
    };

    // make node names unique and also javascript identifiers
    const nodeNames = new Map<string, string[]>();
    for (const [address, node] of tempNodes) {
        // augment the name with the extraNameAddress, if we ca find it
        if (node.suffix) {
            let extraNames: string[] = [];
            for (const [name, addresses] of node.suffix) {
                if (addresses.length) {
                    for (const [i, a] of addresses.entries()) {
                        extraNames.push(
                            tempNodes.get(a)?.name || (await lookupContractName(a)) || `\$${name}_at_${i}\$`,
                        );
                    }
                } else {
                    extraNames.push(`\$${name}\$`);
                }
            }
            if (extraNames.length) {
                node.name = `${node.name}__${extraNames.join('_')}`;
            }
        }
        // make it javascript id
        // replace multiple whitespaces with underscores
        node.name = node.name.replace(/\s+/g, '_');
        // replace invalid characters with a dollar sign
        node.name = node.name.replace(/[^a-zA-Z0-9$_]/g, '$');
        // ensure the identifier doesn't start with a digit
        if (/^\d/.test(node.name)) node.name = '$' + node.name;

        // then add it to the list for uniqueness check below
        nodeNames.set(node.name, (nodeNames.get(node.name) ?? []).concat(address));
    }

    // now find duplicates
    for (const [name, addresses] of nodeNames) {
        if (addresses.length > 1) {
            log(`name ${name} has more than one address`);
            // find the links to get some name for them
            let unique = 0;
            for (const address of addresses) {
                const node = tempNodes.get(address);
                if (node) {
                    const backLinksForAddress = backLinks.get(address);
                    let done = false;
                    if (backLinksForAddress && backLinksForAddress.length == 1) {
                        const index = backLinksForAddress[0].name.match(/\[(\d+)\]$/);
                        if (index && index.length == 2) {
                            node.name += `_at_${index[1]}`;
                            done = true;
                        }
                    }
                    if (!done) {
                        node.name += `__${unique}`;
                        unique++;
                    }
                }
            }
        }
    }

    // sort the nodes by name
    // TODO: find out why
    const sort = <K, V>(unsorted: Map<K, V>, field: (v: V) => string) =>
        Array.from(unsorted.entries()).sort((a, b) => stringCompare(field(a[1]), field(b[1])));

    sort(tempNodes, (v) => v.name).forEach(([k, v]) => nodes.set(k, v));

    // set up the graph contracts and users for executing the actions
    for (const [address, node] of nodes) {
        const contract = await node.getContract(whale);
        if (contract) {
            // get an owner signer
            const contractRoles = roles.get(contract.address);
            // first try the "owner" field
            let ownerAddress: string | undefined = undefined;
            // look up the owner property of address
            try {
                ownerAddress = await contract['owner']();
            } catch (any) {
                // or look up the DEFAULT_ADMIN_ROLE role
                const ownerAddresses = contractRoles
                    ?.filter((r) => r.name === 'DEFAULT_ADMIN_ROLE')
                    .flatMap((role) => role.addresses);
                if (ownerAddresses && ownerAddresses.length) ownerAddress = ownerAddresses[0];
            }

            const richContract = Object.assign(contract, {
                name: node.name,
                // contractType: node.contractName,
                ownerSigner: ownerAddress ? await getSignerAt(ownerAddress) : undefined,
                roles: contractRoles,
            });
            contracts[node.name] = richContract;
            contracts[address] = richContract;
            // write out source file(s)
            // TODO: one file per contract type?
            const sourceCodeText = await node.getSourceCode();
            // TODO: handle vyper code
            if (sourceCodeText !== undefined) {
                const dir = `${sourceDir}/${getConfig().configName}/${node.name}`;
                if (sourceCodeText.length == 0 || sourceCodeText[0] !== '{') {
                    // it's text (some older contracts are this)
                    // handle vyper & solidity code
                    let extension = '.txt';
                    if (sourceCodeText.match(/(^|\n)\@external\s\n/)) {
                        extension = '.vy';
                    } else {
                        extension = '.sol';
                    }
                    writeFile(`${dir}${extension}`, sourceCodeText);
                } else {
                    // else it's probably json
                    let json = undefined;
                    try {
                        json = JSON.parse(sourceCodeText.slice(1, -1)); // remove spurious { & }
                        Object.entries(json.sources).forEach(([filePath, file]) => {
                            writeFile(`${dir}/${filePath}`, (file as any).content);
                        });
                    } catch (e: any) {
                        console.log(`error in ${node.name} source code: ${e}`);
                    }
                }
            }
        } else {
            users[node.name] = await ethers.getImpersonatedSigner(address);
            users[address] = users[node.name];
        }
    }
};
export const dig = withLogging(_dig);

export const digOne = (address: string): IBlockchainAddress<Contract> | null => {
    if (address === ZeroAddress) return null;
    const local = localNodes.get(address);
    if (local) return local;
    return new BlockchainAddress(address);
};

// TODO: put this in friedly?
const outputName = (func: FunctionFragment, outputIndex: number, arrayIndex?: number): string => {
    let result = func.name;
    if (func.outputs.length > 1) {
        result = `${result}.${func.outputs[outputIndex].name === '' ? outputIndex : func.outputs[outputIndex].name}`;
    }
    if (arrayIndex !== undefined) {
        result = `${result}[${arrayIndex}]`;
    }
    return result;
};

//const regexpEscape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const digDeep = async (
    address: IBlockchainAddress<Contract>,
): Promise<{ readerTemplates: ReaderTemplate[]; links: Link[]; roles: Role[]; suffix: SuffixMatch }> => {
    const roles: Role[] = [];
    const links: Link[] = [];
    const readerTemplates: ReaderTemplate[] = [];
    let suffix: SuffixMatch = undefined;
    // would like to follow also the proxy contained addresses
    // unfortunately for some proxies (e.g. openzeppelin's TransparentUpgradeableProxy) only the admin can call functions on the proxy
    const contract = await address.getContract();
    if (contract) {
        // TODO: do something with constructor arguments and initialize calls (for logics)
        // set up the name suffix (in the order given by config)
        const contractType = await address.contractNamish();
        for (const match of getConfig().suffix || []) {
            if (match.contract === contractType) {
                suffix = new Map(match.fields.map((f) => [f, []]));
                break; // just the first one.
            }
        }
        let functions: FunctionFragment[] = [];
        let roleFunctions: string[] = [];
        contract.interface.forEachFunction((func) => {
            // so we can call the functions async in a loop later
            functions.push(func);
            // all uppercase with the word role in it (this is just a convention)
            if (
                func.inputs.length == 0 &&
                func.outputs.length == 1 &&
                func.outputs[0].type === 'bytes32' &&
                /^[A-Z_]*_ROLE[A-Z_]*$/.test(func.name)
            ) {
                roleFunctions.push(func.name);
            }
        });

        // get the role names
        let roleNames = new Map<bigint, string>();
        for (const rolefn of roleFunctions) {
            const role = await contract[rolefn]();
            roleNames.set(role, rolefn);
        }

        // get roles granted by this contract
        if (contract.filters.RoleGranted) {
            const grantedEvents = await contract.queryFilter(contract.filters.RoleGranted()); //, 0xaf2c74, 0xb4d9f4);
            for (const event of grantedEvents) {
                const parsedEvent = contract.interface.parseLog({
                    topics: [...event.topics],
                    data: event.data,
                });
                if (parsedEvent) {
                    const role = parsedEvent.args.role;
                    const account = parsedEvent.args.account;
                    // does this account still have this role?
                    //this is the openzeppelin access manager
                    if (await contract.hasRole(role, account)) {
                        const index = roles.findIndex((r) => r.id === role);
                        if (index == -1) {
                            let name = roleNames.get(role) || role;
                            roles.push({ id: role, name: name, addresses: [getAddress(account)] });
                        } else {
                            roles[index].addresses.push(getAddress(account));
                        }
                    }
                }
            }
        }

        // Explore each parameterless, or single address parameter, view (or pure) functions in the contract's interface
        for (const func of functions.filter(
            (f) =>
                (f.stateMutability === 'view' || f.stateMutability === 'pure') &&
                (f.inputs.length == 0 || (f.inputs.length == 1 && f.inputs[0].type === 'address')),
        )) {
            // TODO: expand this to work with all arg types and all arg numbers for general use
            const argTypes = func.inputs.length == 1 ? [func.inputs[0].type] : undefined;
            // get all the functions that return a numeric or address or arrays of them
            for (const outputIndex of func.outputs.reduce((indices, elem, index) => {
                // TODO:  add bool, bytes1 .. bytes32, and enums?
                if (elem.type === 'address' || elem.type === 'address[]' || /^u?int\d+(\[\])?$/.test(elem.type)) {
                    indices.push(index);
                }
                return indices;
            }, [] as number[])) {
                const _contract = contractType;
                const _field =
                    func.outputs.length != 1 ? { name: func.outputs[outputIndex].name, index: outputIndex } : undefined;
                const _type = func.outputs[outputIndex].type;
                const readerTemplate: ReaderTemplate = {
                    address: contract.address,
                    contract: _contract,
                    function: func.name,
                    field: _field,
                    argTypes: func.inputs.length == 1 ? ['address'] : [],
                    type: _type,
                    read: async (...args: any[]): Promise<ReadingValue> => await contract[func.name](...args),
                    formatting: getFormatting(_type, _contract, func.name, _field),
                };
                readerTemplates.push(readerTemplate);

                // now add the data into links
                if (func.outputs[outputIndex].type.startsWith('address') && func.inputs.length == 0) {
                    const addLink = (name: string, address: string) => {
                        // all links are searched for possible name suffixes
                        links.push({ name: name, address: getAddress(address) });
                        if (suffix) {
                            suffix.get(readerTemplate.function)?.push(address);
                        }
                    };
                    // need to execute the function
                    try {
                        const result = await callReader(makeReader(readerTemplate));
                        if (result.value === undefined) throw Error(`failed to read ${result.error}`);
                        if (Array.isArray(result.value)) {
                            for (let i = 0; i < result.value.length; i++) {
                                addLink(outputName(func, outputIndex, i), result.value[i] as string);
                            }
                        } else {
                            addLink(outputName(func, outputIndex), result.value as string);
                        }
                    } catch (err) {
                        console.error(`linking - error calling ${address} ${func.name} ${func.selector}: ${err}`);
                    }
                }
            }
        }
    }
    return { readerTemplates: readerTemplates, links: links, roles: roles, suffix: suffix };
};
//const digDeep = withLogging(_digDeep);

const _digUsers = async () => {
    // add in the users from the config
    if (getConfig().users) {
        const holdings = new Map<string, Map<string, bigint>>(); // username to {token, amount}
        const approve = new Map<string, string[]>(); // username to contracts
        const totalHoldings = new Map<string, bigint>(); // token to total amount
        for (const user of getConfig().users) {
            const signer = await getSigner(user.name);
            // The next two operations are safe to do multiply
            users[user.name] = signer; // to be used in actions
            users[signer.address] = signer;
            // add them to the graph, too
            nodes.set(
                signer.address,
                Object.assign({ address: signer.address, name: user.name, signer: signer }, digOne(signer.address)),
            );
            if (user.wallet) {
                const userHoldings = new Map<string, bigint>();
                for (const holding of user.wallet) {
                    const token = holding.token;
                    const amount = parseArg(holding.amount) as bigint;
                    userHoldings.set(token, userHoldings.get(token) ?? 0n + amount);
                    totalHoldings.set(token, totalHoldings.get(token) ?? 0n + amount);

                    // find all the contracts this user interacts with and allow them to spend there
                    (user.approve || []).forEach((c) =>
                        approve.set(user.name, (approve.get(user.name) ?? []).concat(c)),
                    );
                }
                holdings.set(user.name, userHoldings);
            }
        }
        // now we've added the users, we can fill their wallets
        for (const [contract, amount] of totalHoldings) {
            //log(`whale stealing ${formatEther(amount)} of ${contract}`);
            await addTokenToWhale(contract, amount);
        }
        for (const [userName, userHoldings] of holdings) {
            // fill the wallet
            // TODO: use setBalance to set ETH holdings
            for (const [tokenName, amount] of userHoldings) {
                // just add enough to make it to at least the holding
                const currentHolding: bigint = await contracts[tokenName].balanceOf(users[userName].address);
                if (currentHolding < amount) {
                    if (
                        !(await contracts[tokenName]
                            .connect(whale)
                            .transfer(users[userName].address, amount - currentHolding))
                    ) {
                        throw Error(`could not transfer ${tokenName} from whale to ${userName}`);
                    }
                    // and allow contracts to spend their money
                    for (const contract of approve.get(userName) || []) {
                        if (
                            !(await contracts[tokenName]
                                .connect(users[userName])
                                .approve(contracts[contract].address, MaxUint256))
                        ) {
                            throw Error(`could not approve ${contract} to use all ${userName}'s ${tokenName}`);
                        }
                        //log(`approved ${contract} to use all ${userName}'s ${tokenName}`);
                    }
                }
            }
        }
    }
    /*
    // set up the triggers
    if (getConfig().triggers) {
        getConfig().triggers.forEach((ue) => {
            // TODO: add a do function to call doUserEvent - look at removing doUserEvent, and also substituteArgs?
            const copy = Object.assign({ ...ue });
            console.log(`user trigger: ${ue.name}`);
            triggerTemplate.set(ue.name, copy);
        });
    }
    */
};

export const digUsers = withLogging(_digUsers);
