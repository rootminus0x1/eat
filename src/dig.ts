import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { FunctionFragment, MaxUint256, ZeroAddress } from 'ethers';

const sourceDir = './eat-source';

import { BlockchainAddress, addTokenToWhale, getSignerAt, getSigner, whale } from './Blockchain';
import {
    Link,
    Measure,
    MeasureOnAddress,
    backLinks,
    contracts,
    links,
    measures,
    measuresOnAddress,
    nodes,
    users,
    events,
    parseArg,
    Role,
    roles,
} from './graph';
import { getConfig, writeEatFile, writeFile } from './config';
import { mermaid } from './mermaid';

export const dig = async () => {
    console.log('digging...');
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
    while (addresses && addresses.length) {
        addresses.sort((a, b) => b.follow - a.follow); // biggest follow first
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address.address)) {
            done.add(address.address);
            const blockchainAddress = digOne(address.address);
            if (blockchainAddress) {
                nodes.set(
                    address.address,
                    Object.assign(
                        { name: await blockchainAddress.contractNamish(), leaf: address.follow == 0 },
                        blockchainAddress,
                    ),
                );
                // add the measures to the contract

                const dugUp = await digDeep(blockchainAddress);
                measures.set(address.address, dugUp.measures);
                measuresOnAddress.set(address.address, dugUp.measuresOnAddress);
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
                    dugUp.roles.forEach((role) =>
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
    for (const [address, node] of nodes) {
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
                const node = nodes.get(address);
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

    // set up the graph contracts and users for executing the actions
    for (const [address, node] of nodes) {
        const contract = await node.getContract(whale);
        if (contract) {
            const richContract = Object.assign(contract, {
                name: node.name,
                contractType: node.contractName,
                ownerSigner: await getSignerAt(address, 'owner'),
                roles: roles.get(contract.address),
            });
            contracts[node.name] = richContract;
            contracts[address] = contracts[node.name];
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
            contracts[address] = users[node.name];
        }
    }

    // add in the users from the config
    if (getConfig().users) {
        const holdings = new Map<string, Map<string, bigint>>(); // username to {contractname, amount}
        const totalHoldings = new Map<string, bigint>(); // contractname to total amount
        for (const user of getConfig().users) {
            const signer = await getSigner(user.name);
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
                if (!(await contracts[tokenName].connect(whale).transfer(users[userName].address, amount))) {
                    throw Error(`could not transfer ${tokenName} from whale to ${userName}`);
                }
                // find all the contracts this user interacts with and allow them to spend there
                if (getConfig().events) {
                    for (const contract of getConfig()
                        .events.filter((a) => a.user && a.user === userName)
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
    // set up the events
    if (getConfig().events) {
        getConfig().events.forEach((ue) => {
            // TODO: add a do function to call doUserEvent - look at removing doUserEvent, and also substituteArgs?
            const copy = Object.assign({ ...ue });
            console.log(`userEvent: ${ue.name}`);
            events[ue.name] = copy; // add do: doUserEvent(copy)
            // events.set(ue.name, copy);
        });
    }

    if (getConfig().diagram) writeEatFile('diagram.md', await mermaid());
    console.log('digging...done.');
};

export const digOne = (address: string): BlockchainAddress | null => {
    return address !== ZeroAddress ? new BlockchainAddress(address) : null;
};

const outputName = (func: FunctionFragment, outputIndex?: number, arrayIndex?: number): string => {
    let result = func.name;
    if (outputIndex || outputIndex === 0) {
        result = `${result}.${func.outputs[outputIndex].name === '' ? outputIndex : func.outputs[outputIndex].name}`;
    }
    if (arrayIndex || arrayIndex === 0) {
        result = `${result}[${arrayIndex}]`;
    }
    return result;
};

const digDeep = async (
    address: BlockchainAddress,
): Promise<{ measures: Measure[]; measuresOnAddress: MeasureOnAddress[]; links: Link[]; roles: Role[] }> => {
    const roles: Role[] = [];
    const links: Link[] = [];
    const measures: Measure[] = [];
    const measuresOnAddress: MeasureOnAddress[] = [];
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

        // Explore each parameterless view (or pure) functions in the contract's interface
        for (const func of functions.filter(
            (f) =>
                (f.stateMutability === 'view' || f.stateMutability === 'pure') &&
                (f.inputs.length == 0 || (f.inputs.length == 1 && f.inputs[0].type === 'address')),
        )) {
            const onAddress = func.inputs.length == 1;
            // get all the functions that return a numeric or address or arrays of them
            for (const outputIndex of func.outputs.reduce((indices, elem, index) => {
                // TODO:  add bool?
                if (elem.type === 'address' || elem.type === 'address[]' || /^u?int\d+(\[\])?$/.test(elem.type)) {
                    indices.push(index);
                }
                return indices;
            }, [] as number[])) {
                const returnsSingle = func.outputs.length == 1;
                const returnsArray = func.outputs[outputIndex].type.endsWith('[]');
                const returnsAddress = func.outputs[outputIndex].type.startsWith('address');
                const name = outputName(func, returnsSingle ? undefined : outputIndex);
                const type = func.outputs[outputIndex].type;
                // TODO: merge these two
                const call: (arg?: any) => any = onAddress
                    ? async (address: string) => await contract[func.name](address)
                    : async () => await contract[func.name]();
                const process: any[] = [];
                if (!returnsSingle) {
                    // multiple outputs so have to extract the one in question - single outputs are already extracted
                    process.push((result: any[]): any => result[outputIndex]);
                }
                if (returnsArray) {
                    if (returnsAddress) {
                        // translate addess to string
                        process.push((result: any[]): string[] => result.map((a: string) => a));
                    } else {
                        // translate numbers to bigint
                        process.push((result: any[]): bigint[] => result.map((a: bigint) => a));
                    }
                }
                // chain the call and processing
                const calculation = async (address?: any): Promise<any> => {
                    let result = await call(address);
                    for (const p of process) {
                        result = p(result);
                    }
                    return result;
                };

                // now add the data into measures, measuresOnAddress & links
                if (returnsAddress && !onAddress) {
                    // need to execute the function
                    try {
                        const result = await calculation(); // the same calc as a measure will use
                        if (Array.isArray(result)) {
                            for (let i = 0; i < result.length; i++) {
                                links.push({ name: outputName(func, outputIndex, i), address: result[i] });
                            }
                        } else {
                            links.push({ name: name, address: result });
                        }
                    } catch (err) {
                        console.error(`linking - error calling ${address} ${func.name} ${func.selector}: ${err}`);
                    }
                }
                if (onAddress) {
                    measuresOnAddress.push({ name: name, type: type, calculation: calculation });
                } else {
                    measures.push({ name: name, type: type, calculation: calculation });
                }
            }
        }
    }
    return { measures: measures, measuresOnAddress: measuresOnAddress, links: links, roles: roles };
};
