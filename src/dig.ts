import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, MaxUint256, ZeroAddress, formatEther, getAddress } from 'ethers';

import { parseArg } from './friendly';
import { SuffixMatch } from './graph';

import { IBlockchainAddress, BlockchainAddress, addTokenToWhale, getSigner, whale, getSignerAt } from './Blockchain';
import {
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
import { Field, ReaderTemplate, Reading, ReadingValue, makeReading } from './read';
import { sep } from 'path';

export const digOne = (address: string): IBlockchainAddress<Contract> | null => {
    if (address === ZeroAddress) return null;
    const local = localNodes.get(address);
    if (local) return local;
    return new BlockchainAddress(address);
};

const digDeep = async (
    address: IBlockchainAddress<Contract>,
): Promise<{ readerTemplates: ReaderTemplate[]; roles: Role[] }> => {
    const roles: Role[] = [];

    const readerTemplates: ReaderTemplate[] = [];
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
            let it = false;
            if (func.name === 'getReceivers') {
                it = true;
                log(`>>>${func.name}`);
            }
            // TODO: expand this to work with all arg types and all arg numbers for general use
            const argTypes = func.inputs.length == 1 ? [func.inputs[0].type] : undefined;
            // get all the functions that return a numeric or address or arrays of them
            for (const outputIndex of func.outputs.reduce((indices, elem, index) => {
                // TODO:  add bool, bytes1 .. bytes32, and enums?
                if (elem.type === 'address' || elem.type === 'address[]' || /^u?int\d+(\[\])?$/.test(elem.type)) {
                    if (it) log(`output[${index}]=${elem.type}`);
                    indices.push(index);
                }
                return indices;
            }, [] as number[])) {
                const _contract = await address.contractNamish();
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
                if (it) log(`${JSON.stringify(readerTemplate)}`);
            }
            if (it) log('<<<');
        }
    }
    return { readerTemplates: readerTemplates, roles: roles };
};
//const digDeep = withLogging(_digDeep);

type DigAddress = {
    address: string;
    follow: number;
    config: boolean;
};

const _dig = async (stack: string, loud: boolean = false) => {
    // we reset the graph (which is a set of global variables)
    resetGraph();
    type Address = { address: string; follow: number /* 0 = leaf 1 = twig else depth */; config?: boolean };
    const depth = getConfig().depth || 5; // don't go deeper than this, from any of the specified addresses
    const roots: DigAddress[] | undefined = getConfig().root?.map((a) => {
        return { address: a, follow: depth, config: true };
    });
    const twigs: DigAddress[] | undefined = getConfig().twig?.map((a) => {
        return { address: a, follow: 1, config: true };
    });
    const leafs: DigAddress[] | undefined = getConfig().leaf?.map((a) => {
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
    const pendingReaderTemplates = new Map<string, ReaderTemplate>();
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

                    let line: string[] = [`${address.address}:`];

                    const addressType = (a: string) => {
                        let line: string[] = [];
                        if (getConfig()?.leaf && getConfig()?.leaf?.includes(a)) line.push('leaf');
                        if (getConfig()?.twig && getConfig()?.twig?.includes(a)) line.push('twig');
                        if (getConfig()?.root && getConfig()?.root?.includes(a)) line.push('root');
                        if (getConfig()?.prune && getConfig()?.prune?.includes(a)) line.push('PRUNED');
                        return line.join('-');
                    };
                    line.push(addressType(address.address));

                    if (backLinks.get(address.address) !== undefined) {
                        const sources = backLinks.get(address.address)!;
                        line.push(`<${sources![0].address}(${sources![0].name}) ${addressType(sources![0].address)}`);
                    }

                    if (tokenName || tokenSymbol) line.push(`${tokenSymbol} (${tokenName})`);
                    if (logicName) {
                        line.push(`"${contractName}"->"${logicName}"`);
                    } else {
                        line.push(`"${contractName}"`);
                    }
                    log(line.join(' '));
                }

                // set up the name suffix (in the order given by config)
                let suffix: SuffixMatch = undefined;
                const contractType = await blockchainAddress.contractNamish();
                for (const match of getConfig().suffix || []) {
                    if (match.contract === contractType) {
                        suffix = new Map(match.fields.map((f) => [f, []]));
                        break; // just the first one.
                    }
                }

                // add the readers to the contract
                readerTemplates.set(address.address, dugUp.readerTemplates);

                // function to add an address to be explored
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
                        // add a new address to be processed but within the config limits
                        const limited = limits.get(address);
                        addresses.push({
                            address: address,
                            follow: limited ? Math.min(actualFollow, limited.follow) : actualFollow,
                            config: limited ? true : false,
                        });
                    }
                };

                // function to add a link and explore it (calls addAddress, above)
                const addLink = (
                    nodeAddress: string,
                    follow: number,
                    linkAddress: string,
                    funcName: string,
                    field?: Field,
                    arrayIndex?: number,
                ) => {
                    // only add an address if we are following and that address has not been pruned
                    if (follow && !(getConfig()?.prune && getConfig()?.prune?.includes(linkAddress))) {
                        let name = funcName;

                        if (field !== undefined) {
                            name = `${name}.${field.name === '' ? field.index : field.name}`;
                        }
                        if (arrayIndex !== undefined) {
                            name = `${name}[${arrayIndex}]`;
                        }
                        // process the links
                        log(`adding link from ${nodeAddress} to ${linkAddress} as ${name}`);
                        links.set(
                            nodeAddress,
                            (links.get(nodeAddress) ?? []).concat({
                                name: name,
                                address: getAddress(linkAddress),
                            }),
                        );
                        // and consequent backlinks and nodes
                        backLinks.set(
                            linkAddress,
                            (backLinks.get(linkAddress) ?? []).concat({ address: nodeAddress, name: name }),
                        );
                        addAddress(linkAddress, follow);
                    }
                };

                // follow the roles unless it's a leaf
                if (address.follow && dugUp.roles.length) {
                    dugUp.roles.forEach((role: Role) =>
                        role.addresses.forEach((roleHolderAddress: string) => {
                            log(`add link for role ${role.name}`);
                            addLink(address.address, address.follow, roleHolderAddress, role.name);
                        }),
                    );
                    roles.set(address.address, dugUp.roles);
                }

                // create links by executing the returned readers that return more address(es) only adding them if we are following
                // also get the suffix addresses for this node name (which are looked up later as the suffix addresses may also have suffixes)
                let results: { nodeAddress: string; follow: number; reading: Reading }[] = [];
                for (const readerTemplate of dugUp.readerTemplates.filter((rt) => rt.type.startsWith('address'))) {
                    if (readerTemplate.argTypes.length == 0) {
                        // zero parameters
                        results.push({
                            nodeAddress: address.address,
                            follow: address.follow,
                            reading: await makeReading(readerTemplate),
                        });
                    } else if (readerTemplate.argTypes.length == 1 && readerTemplate.argTypes[0] === 'address') {
                        // one address parameter
                        // run the reader against all the known addresses
                        // for (const knownAddress of tempNodes.keys()) {
                        //     results.push({
                        //         nodeAddress: address.address,
                        //         follow: address.follow,
                        //         reading: await makeReading(readerTemplate, knownAddress),
                        //     });
                        // }
                        // // also save the reader so that it can be run against all future addresses as they come through the main loop
                        // pendingReaderTemplates.set(address.address, readerTemplate);
                    }
                }
                for (const result of results) {
                    // function to add a suffix
                    const addSuffix = (value: string) => {
                        if (suffix && result.reading.argTypes.length == 0) {
                            if (suffix.get(result.reading.function) !== undefined) {
                                log(
                                    `add suffix for ${address.address}, results from ${result.reading.function} = ${value}`,
                                );
                                suffix.get(result.reading.function)?.push(value);
                            }
                        }
                    };

                    if (result.reading.value === undefined)
                        throw Error(
                            `failed to add link (${result.reading.function}) for ${result.nodeAddress}: ${result.reading.error}`,
                        );
                    // need to work for functions that return scalars or vectors
                    if (Array.isArray(result.reading.value)) {
                        // TODO: check against readerTemplate.type.endsWith("[]")
                        for (let i = 0; i < result.reading.value.length; i++) {
                            log(`add link for ${result.reading.function}[${i}] = ${result.reading.value[i] as string}`);
                            addLink(
                                address.address,
                                address.follow,
                                result.reading.value[i] as string,
                                result.reading.function,
                                result.reading.field,
                                i,
                            );
                            addSuffix(result.reading.value[i] as string);
                        }
                    } else {
                        log(`add link for ${result.reading.function}= ${result.reading.value as string}`);
                        addLink(
                            address.address,
                            address.follow,
                            result.reading.value as string,
                            result.reading.function,
                            result.reading.field,
                        );
                        addSuffix(result.reading.value as string);
                    }
                }

                tempNodes.set(
                    address.address,
                    Object.assign(
                        {
                            address: address.address,
                            contract: await blockchainAddress.contractNamish(),
                            name: await blockchainAddress.contractNamish(), // will be updated later removing dups
                            leaf: address.follow == 0,
                            suffix: suffix,
                        },
                        blockchainAddress,
                    ),
                );
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
                    extraNames.push(`\$${name}\$`); // this is an error condition really
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
        } else {
            users[node.name] = await ethers.getImpersonatedSigner(address);
            users[address] = users[node.name];
        }
    }
};
export const dig = withLogging(_dig);

//const regexpEscape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
                    userHoldings.set(token, (userHoldings.get(token) || 0n) + amount);
                    totalHoldings.set(token, (totalHoldings.get(token) || 0n) + amount);
                    //log(`total holdings of ${token} now ${totalHoldings.get(token)}`);
                    // find all the contracts this user interacts with and allow them to spend there
                    (user.approve || []).forEach((c) =>
                        approve.set(user.name, (approve.get(user.name) ?? []).concat(c)),
                    );
                }
                holdings.set(user.name, userHoldings);
            }
        }
        // now we've added the users, we can fill their wallets
        for (const [tokenName, amount] of totalHoldings) {
            log(`whale stealing ${formatEther(amount)} of ${tokenName}`);
            await addTokenToWhale(tokenName, amount);
        }
        for (const [userName, userHoldings] of holdings) {
            // fill the wallet
            // TODO: use setBalance to set ETH holdings
            for (const [tokenName, amount] of userHoldings) {
                // just add enough to make it to at least the holding
                const currentHolding: bigint = await contracts[tokenName].balanceOf(users[userName].address);
                if (currentHolding < amount) {
                    //log(`${userName} getting ${formatEther(amount)} of ${tokenName}`);
                    if (
                        !(await contracts[tokenName]
                            .connect(whale)
                            .transfer(users[userName].address, amount - currentHolding))
                    ) {
                        throw Error(`could not transfer ${tokenName} from whale to ${userName}`);
                    }
                    // and allow contracts to spend their money
                    for (const contract of approve.get(userName) || []) {
                        //log(`${tokenName} approving ${contract} to use ${userName}'s`);
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

export const digSource = async () => {
    for (const [address, node] of nodes) {
        const contract = await node.getContract(whale);
        if (contract && (await node.contractNamish()) !== 'GnosisSafe') {
            // log(`writing source for ${await node.contractName()}`);
            // write out source file(s)
            const sourceCodeText = await node.getSourceCode();
            if (sourceCodeText !== undefined) {
                const dir = `${getConfig().sourceCodeRoot}/${getConfig().configName}/${node.name}`;
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
                    let json: any = {};
                    try {
                        json = JSON.parse(sourceCodeText.slice(1, -1)); // remove spurious { & }
                        Object.entries(json.sources).forEach(([filePath, file]) => {
                            //const logger = new Logger(filePath);
                            const source = ((file as any).content as string).replace(
                                // imports from an absolute path
                                //import { AccessControlUpgradeable } from "@openzeppelin/contracts-upgradeable-v4/access/AccessControlUpgradeable.sol";

                                /import\s+({[^}]*}\s+from\s+)?['"]([^.][^'"]+)['"]\s*;/g,
                                (importMatch: string, importThings: string, importPath: string): string => {
                                    // Calculate the relative path from filePath to importPath
                                    /*
                                    const from = `${filePath}`;
                                    const to = `${importPath}`;
                                    log(`${dir}/${filePath}:`);
                                    log(`   ${from} -> ${to}`);
                                    const relativePath: string = relative(to, from);

                                    const absoluteImportPath = resolve(dirname(filePath), importPath);

                                    // Now, calculate the relative path from the source file directory to the imported file
                                    // For the purpose of demonstration, we'll just return the absolute path
                                    // Replace this with the correct base directory as needed
                                    const relativePath = relative(dirname(filePath), absoluteImportPath);
                                    */
                                    const directories: string[] = filePath.split(sep);
                                    // Exclude any empty strings resulting from leading or trailing slashes
                                    const filteredDirectories: string[] = directories.filter(
                                        (directory) => directory !== '',
                                    );
                                    const depth: number = filteredDirectories.length;

                                    const relativePath = ('..' + sep).repeat(depth - 1) + importPath;

                                    if (importThings === undefined) importThings = '';
                                    const replacement = `import ${importThings}'${relativePath}';`;
                                    // log(`   ${importMatch} => ${replacement}`);
                                    return replacement;
                                },
                            );
                            //logger.done();
                            writeFile(`${dir}/${filePath}`, source);
                        });
                    } catch (e: any) {
                        console.log(`error in ${node.name} source code: ${e}`);
                    }
                }
            }
        }
    }
};
