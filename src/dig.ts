import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, MaxUint256, ZeroAddress } from 'ethers';

const sourceDir = './eat-source';

import { IBlockchainAddress, BlockchainAddress, addTokenToWhale, getSignerAt, getSigner, whale } from './Blockchain';
import {
    Link,
    backLinks,
    contracts,
    links,
    readers,
    nodes,
    users,
    triggers,
    Role,
    roles,
    GraphNode,
    resetGraph,
    localNodes,
} from './graph';
import { Reader, callReaderBasic, callToName } from './delve';
import { ConfigFormatApply, getConfig, parseArg, stringCompare, writeEatFile, writeFile } from './config';
import { withLogging } from './logging';

const _dig = async (stack: string) => {
    // we reset the graph (which is a set of global variables)
    resetGraph();
    type Address = { address: string; follow: number /* 0 = leaf 1 = twig else depth */; config?: boolean };
    const done = new Set<string>(); // ensure addresses are only visited once
    const depth = getConfig().depth || 10; // don't go deeper than this, from any of the specified addresses
    const addresses: Address[] = [
        ...(getConfig().root
            ? getConfig().root.map((a) => {
                  return { address: a, follow: depth, config: true };
              })
            : []),
        ...(getConfig().twig
            ? getConfig().twig.map((a) => {
                  return { address: a, follow: 1, config: true };
              })
            : []),
        ...(getConfig().leaf
            ? getConfig().leaf.map((a) => {
                  return { address: a, follow: 0, config: true };
              })
            : []),
    ];

    const tempNodes = new Map<string, GraphNode>();
    while (addresses && addresses.length) {
        addresses.sort((a, b) => b.follow - a.follow); // biggest follow first
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address.address)) {
            done.add(address.address);
            const blockchainAddress = digOne(address.address);
            if (blockchainAddress) {
                tempNodes.set(
                    address.address,
                    Object.assign(
                        { name: await blockchainAddress.contractNamish(), leaf: address.follow == 0 },
                        blockchainAddress,
                    ),
                );
                // add the readers to the contract

                const dugUp = await digDeep(blockchainAddress);
                readers.set(address.address, dugUp.readers);
                // process the roles - add them as addresses, even if they are on leaf addresses
                const addAddress = (address: string, follow: number) => {
                    // need to merge them as the depth shoud take on the larger of the two
                    const actualFollow = Math.max(follow - 1, 0);
                    const found = addresses.findIndex((a, i) => a.address === address);
                    if (found !== -1) {
                        // update the original
                        // make it the longest depth, unless it's a config item
                        if (!addresses[found].config)
                            addresses[found].follow = Math.max(addresses[found].follow, actualFollow);
                    } else {
                        addresses.push({ address: address, follow: actualFollow });
                    }
                };

                const addLinks = (nodeAddress: string, toAdd: Link[], follow: number) => {
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

                // follow the roles (even on a leaf)
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

                // and the links, unless its a leaf
                if (address.follow) {
                    addLinks(address.address, dugUp.links, address.follow);
                }
            }
        }
    }

    // make node names unique and also javascript identifiers
    const nodeNames = new Map<string, string[]>();
    for (const [address, node] of tempNodes) {
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
    for (const [name, addresses] of nodeNames) {
        if (addresses.length > 1) {
            //console.log(`name ${name} has more than one address`);
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
            const richContract = Object.assign(contract, {
                name: node.name,
                // contractType: node.contractName,
                ownerSigner: await getSignerAt(address, 'owner'),
                roles: roles.get(contract.address),
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
                    } catch (e: any) {
                        console.log(`error in ${node.name} source code: ${e}`);
                    }
                    Object.entries(json.sources).forEach(([filePath, file]) => {
                        writeFile(`${dir}/${filePath}`, (file as any).content);
                    });
                }
            }
        } else {
            users[node.name] = await ethers.getImpersonatedSigner(address);
            users[address] = users[node.name];
        }
    }

    // add in the users from the config
    if (getConfig().users) {
        const holdings = new Map<string, Map<string, bigint>>(); // username to {contractname, amount}
        const totalHoldings = new Map<string, bigint>(); // contractname to total amount
        for (const user of getConfig().users) {
            const signer = await getSigner(user.name);
            // The next two operations are safe to do multiply
            users[user.name] = signer; // to be used in actions
            // add them to the graph, too
            nodes.set(signer.address, Object.assign({ name: user.name, signer: signer }, digOne(signer.address)));
            if (user.wallet) {
                const userHoldings = new Map<string, bigint>();
                for (const holding of user.wallet) {
                    const contract = holding.contract;
                    const amount = parseArg(holding.amount) as bigint;
                    userHoldings.set(contract, userHoldings.get(contract) ?? 0n + amount);
                    totalHoldings.set(contract, totalHoldings.get(contract) ?? 0n + amount);
                }
                holdings.set(user.name, userHoldings);
            }
        }
        // now we've added the users, we can fill their wallets
        for (const [contract, amount] of totalHoldings) {
            await addTokenToWhale(contract, amount);
        }
        for (const [userName, userHoldings] of holdings) {
            // fill the wallet
            // TODO: use setBalance to set ETH holdings
            for (const [tokenName, amount] of userHoldings) {
                // just add enough to make it to at least the holding
                const currentHolding = await contracts[tokenName].balanceOf(users[userName].address);
                if (currentHolding < amount) {
                    if (
                        !(await contracts[tokenName]
                            .connect(whale)
                            .transfer(users[userName].address, amount - currentHolding))
                    ) {
                        throw Error(`could not transfer ${tokenName} from whale to ${userName}`);
                    }
                }
                // find all the contracts this user interacts with and allow them to spend there
                if (getConfig().triggers) {
                    for (const contract of getConfig()
                        .triggers.filter((a) => a.user && a.user === userName)
                        .map((a) => a.contract)) {
                        // allow the wallet to be spent
                        if (
                            !(await contracts[tokenName]
                                .connect(users[userName])
                                .approve(contracts[contract].address, MaxUint256))
                        ) {
                            throw Error(
                                `could not approve ${contracts[contract].name} to use ${userName}'s ${contracts[tokenName]}`,
                            );
                        }
                    }
                }
            }
        }
    }
    // set up the triggers
    if (getConfig().triggers) {
        getConfig().triggers.forEach((ue) => {
            // TODO: add a do function to call doUserEvent - look at removing doUserEvent, and also substituteArgs?
            const copy = Object.assign({ ...ue });
            console.log(`user trigger: ${ue.name}`);
            triggers[ue.name] = copy;
        });
    }
};

export const digOne = (address: string): IBlockchainAddress<Contract> | null => {
    if (address === ZeroAddress) return null;
    const local = localNodes.get(address);
    if (local) return local;
    return new BlockchainAddress(address);
};

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

const getFormatting = (reader: Reader) => {
    if (getConfig().format) {
        let mergedFormat: ConfigFormatApply = {};
        for (const format of getConfig().format) {
            // TODO: could some things,
            // like timestamps be represented as date/times
            // or numbers
            // merge all the formats that apply
            if (
                (!format.type || reader.type === format.type) &&
                (!format.reading || callToName(reader) === format.reading) &&
                (!format.contract || reader.contract === format.contract)
            ) {
                // is it a highest priority no-format spec
                if (format.unit === undefined && format.precision === undefined) {
                    return {}; // this overrides any formatting specified previously
                }

                // merge the formatting but don't override
                if (format.unit !== undefined && mergedFormat.unit === undefined) {
                    mergedFormat.unit = format.unit;
                }
                if (format.precision !== undefined && mergedFormat.precision === undefined) {
                    mergedFormat.precision = format.precision;
                }
                // got a full format? if so we're done
                if (mergedFormat.unit !== undefined && mergedFormat.precision !== undefined) return mergedFormat; // got enough
            }
        }
        if (mergedFormat.unit !== undefined || mergedFormat.precision !== undefined) {
            return mergedFormat;
        }
    }
    return undefined;
};

const digDeep = async (
    address: IBlockchainAddress<Contract>,
): Promise<{ readers: Reader[]; links: Link[]; roles: Role[] }> => {
    const roles: Role[] = [];
    const links: Link[] = [];
    const readers: Reader[] = [];
    // would like to follow also the proxy contained addresses
    // unfortunately for some proxies (e.g. openzeppelin's TransparentUpgradeableProxy) only the admin can call functions on the proxy
    const contract = await address.getContract();
    if (contract) {
        // TODO: do something with constructor arguments and initialize calls (for logics)

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
                            roles.push({ id: role, name: name, addresses: [account] });
                        } else {
                            roles[index].addresses.push(account);
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
                const reader: Reader = {
                    address: contract.address,
                    contract: await address.contractNamish(),
                    function: func.name,
                    field:
                        func.outputs.length != 1
                            ? { name: func.outputs[outputIndex].name, index: outputIndex }
                            : undefined,
                    argTypes: func.inputs.length == 1 ? ['address'] : [],
                    type: func.outputs[outputIndex].type,
                    read: async (...args: any[]): Promise<any> => await contract[func.name](...args),
                };
                reader.formatting = getFormatting(reader);
                readers.push(reader);

                // now add the data into links
                if (func.outputs[outputIndex].type.startsWith('address') && func.inputs.length == 0) {
                    // need to execute the function
                    try {
                        const result = await callReaderBasic(reader);
                        if (result.value === undefined) throw Error(`failed to read ${result.error}`);
                        if (Array.isArray(result.value)) {
                            // TODO: should against reader.type.endsWith('[]')
                            for (let i = 0; i < result.value.length; i++) {
                                links.push({
                                    name: outputName(func, outputIndex, i),
                                    address: result.value[i] as string,
                                });
                            }
                        } else {
                            links.push({ name: outputName(func, outputIndex), address: result.value as string });
                        }
                    } catch (err) {
                        console.error(`linking - error calling ${address} ${func.name} ${func.selector}: ${err}`);
                    }
                }
            }
        }
    }
    return { readers: readers, links: links, roles: roles };
};

export const dig = withLogging(_dig);
