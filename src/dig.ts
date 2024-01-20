import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { FunctionFragment, MaxUint256, ZeroAddress } from 'ethers';

import { BlockchainAddress, addTokenToWhale, getSigner, whale } from './Blockchain';
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
} from './graph';
import { getConfig, parseArg, write } from './config';
import { mermaid } from './mermaid';

export const dig = async () => {
    const done = new Set<string>(); // ensure addresses are only visited once
    const addresses = [...(getConfig().root || getConfig().leaf)]; // make a copy as we are changing it
    const leafAddresses = getConfig().leaf;
    while (addresses && addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const blockchainAddress = digOne(address);
            if (blockchainAddress) {
                const leaf = leafAddresses?.includes(address);
                nodes.set(
                    address,
                    Object.assign({ name: await blockchainAddress.contractNamish(), leaf: leaf }, blockchainAddress),
                );
                // add the measures to the contract
                const oneMeasures = await digUpMeasures(blockchainAddress);
                measures.set(address, oneMeasures.measures);
                measuresOnAddress.set(address, oneMeasures.measuresOnAddress);
                if (!leaf) {
                    const oneLinks = await digUpLinks(blockchainAddress);
                    // set the links
                    links.set(address, oneLinks);
                    // and consequent backlinks
                    oneLinks.forEach((link) =>
                        backLinks.set(
                            link.address,
                            (backLinks.get(link.address) ?? []).concat({ address: address, name: link.name }),
                        ),
                    );

                    // add more addresses to be dug up
                    oneLinks.forEach((link) => addresses.push(link.address));
                }
            }
        }
    }

    // make node names unique &  javascript identifiers
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
        const contract = await node.getContract();
        if (contract) {
            contracts[node.name] = contract;
        } else {
            users[node.name] = await ethers.getImpersonatedSigner(address);
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
            for (const [tokenName, amount] of userHoldings) {
                console.log(`   transferring ${tokenName} from whale to ${userName}`);
                if (!(await contracts[tokenName].connect(whale).transfer(users[userName].address, amount))) {
                    throw Error(`could not transfer ${tokenName} from whale to ${userName}`);
                }
                // find all the contracts this user interacts with and allow them to spend there
                if (getConfig().actions) {
                    for (const contract of getConfig()
                        .actions.filter((a) => a.user && a.user === userName)
                        .map((a) => a.contract)) {
                        // allow the wallet to be spent
                        console.log(`   approving ${contract} to use ${userName}'s ${tokenName}`);
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
    if (getConfig().diagram) write('diagram.md', await mermaid());
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

export const digUpLinks = async (address: BlockchainAddress): Promise<Link[]> => {
    const links: Link[] = [];
    // follow also the proxy contained addresses
    // unfortunately for some proxies (e.g. openzeppelin's TransparentUpgradeableProxy) only the admin can call functions on the proxy
    for (const contract of [await address.getContract(), await address.getProxyContract()]) {
        if (contract) {
            // TODO: do something with constructor arguments and initialize calls (for logics)
            let functions: FunctionFragment[] = [];
            contract.interface.forEachFunction((func) => functions.push(func));

            // Explore each parameterless view (or pure) functions in the contract's interface
            for (let func of functions.filter(
                (f) => f.inputs.length == 0 && (f.stateMutability === 'view' || f.stateMutability === 'pure'),
            )) {
                // that returns one or more addresses
                // are added to the links field along with their function name + output name/index
                // first find the indices of the functions we are interested in
                const addressIndices = func.outputs.reduce((indices, elem, index) => {
                    if (elem.type === 'address' || elem.type === 'address[]') indices.push(index);
                    return indices;
                }, [] as number[]);
                // if any interesting function
                if (addressIndices.length > 0) {
                    try {
                        const funcResults = await contract[func.name]();
                        if (func.outputs.length == 1) {
                            // single result - containing an address or address[]
                            if (func.outputs[0].type === 'address') {
                                // single address
                                links.push({ address: funcResults, name: outputName(func) });
                            } else {
                                // address[]
                                for (let index = 0; index < funcResults.length; index++) {
                                    const elem = funcResults[index];
                                    links.push({
                                        address: elem,
                                        name: outputName(func, undefined, index),
                                    });
                                }
                            }
                        } else {
                            // assume an array of results, some, defined by the indices, containing an address or address[]
                            for (const outputIndex of addressIndices) {
                                if (func.outputs[outputIndex].type === 'address') {
                                    // single address
                                    links.push({
                                        address: funcResults[outputIndex],
                                        name: outputName(func, outputIndex),
                                    });
                                } else {
                                    // address[]
                                    for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                        const elem = funcResults[outputIndex][index];
                                        links.push({
                                            address: elem,
                                            name: outputName(func, outputIndex, index),
                                        });
                                    }
                                }
                            }
                        }
                    } catch (err) {
                        console.error(`error calling ${address} ${func.name} ${func.selector}: ${err}`);
                    }
                }
            }
        }
    }
    return links;
};

export const digUpMeasures = async (
    address: BlockchainAddress,
): Promise<{ measures: Measure[]; measuresOnAddress: MeasureOnAddress[] }> => {
    const measures: Measure[] = [];
    const measuresOnAddress: MeasureOnAddress[] = [];
    // follow also the proxy contained addresses
    // unfortunately for some proxies (e.g. openzeppelin's TransparentUpgradeableProxy) only the admin can call functions on the proxy
    const contract = await address.getContract();
    if (contract) {
        let functions: FunctionFragment[] = [];
        contract.interface.forEachFunction((func) => functions.push(func));

        // Explore each parameterless view (or pure) functions in the contract's interface
        for (let func of functions.filter((f) => f.stateMutability === 'view' || f.stateMutability === 'pure')) {
            if (func.inputs.length == 0) {
                // same for measures
                const numericIndices = func.outputs.reduce((indices, elem, index) => {
                    // TODO:  add bool?
                    if (/^u?int\d+(\[\])?$/.test(elem.type)) indices.push(index);
                    return indices;
                }, [] as number[]);
                // if any interesting function
                if (numericIndices.length > 0) {
                    if (func.outputs.length == 1) {
                        // single result - containing a unit256 or uint256[], likewise below
                        if (func.outputs[0].type.endsWith('[]')) {
                            measures.push({
                                calculation: async () => (await contract[func.name]()).map((elem: bigint) => elem),
                                name: outputName(func),
                                type: func.outputs[0].type,
                            });
                        } else {
                            // single number
                            measures.push({
                                calculation: async () => await contract[func.name](),
                                name: outputName(func),
                                type: func.outputs[0].type,
                            });
                        }
                    } else {
                        // assume an array/struct of results, some, defined by the indices, containing an uint256 or uint256[]
                        for (const outputIndex of numericIndices) {
                            if (func.outputs[outputIndex].type.endsWith('[]')) {
                                measures.push({
                                    calculation: async () =>
                                        (await contract[func.name]())[outputIndex].map((elem: bigint) => elem),
                                    name: outputName(func, outputIndex),
                                    type: func.outputs[outputIndex].type,
                                });
                            } else {
                                measures.push({
                                    calculation: async () => (await contract[func.name]())[outputIndex],
                                    name: outputName(func, outputIndex),
                                    type: func.outputs[outputIndex].type,
                                });
                            }
                        }
                    }
                }
            }
            // TODO: handle struct returns in a similar way to array returns, gathering all the returned values, not just the numeric ones.
            // because the non-numeric values may help understand the numeric ones
            // likewise for array returns, gather all the returns.
            if (func.inputs.length == 1 && func.inputs[0].type === 'address') {
                // TODO: see if something can be factored out for the two sets of measures
                // same for measures on addresses
                const numericIndices = func.outputs.reduce((indices, elem, index) => {
                    // TODO:  add bool?
                    if (/^u?int\d+(\[\])?$/.test(elem.type)) indices.push(index);
                    return indices;
                }, [] as number[]);
                // if any interesting function
                if (numericIndices.length > 0) {
                    if (func.outputs.length == 1) {
                        // single result - containing a unit256 or uint256[], likewise below
                        if (func.outputs[0].type.endsWith('[]')) {
                            measuresOnAddress.push({
                                calculation: async (address: string) =>
                                    (await contract[func.name](address)).map((elem: bigint) => elem),
                                name: outputName(func),
                                type: func.outputs[0].type,
                            });
                        } else {
                            // single number
                            measuresOnAddress.push({
                                calculation: async (address: string) => await contract[func.name](address),
                                name: outputName(func),
                                type: func.outputs[0].type,
                            });
                        }
                    } else {
                        // assume an array/struct of results, some, defined by the indices, containing an uint256 or uint256[]
                        for (const outputIndex of numericIndices) {
                            if (func.outputs[outputIndex].type.endsWith('[]')) {
                                measuresOnAddress.push({
                                    calculation: async (address: string) =>
                                        (await contract[func.name](address))[outputIndex].map((elem: bigint) => elem),
                                    name: outputName(func, outputIndex),
                                    type: func.outputs[outputIndex].type,
                                });
                            } else {
                                measuresOnAddress.push({
                                    calculation: async (address: string) =>
                                        (await contract[func.name](address))[outputIndex],
                                    name: outputName(func, outputIndex),
                                    type: func.outputs[outputIndex].type,
                                });
                            }
                        }
                    }
                }
            }
        }
    }
    return { measures: measures, measuresOnAddress: measuresOnAddress };
};
