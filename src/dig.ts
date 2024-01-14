import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { FunctionFragment, ZeroAddress } from 'ethers';

import { BlockchainAddress } from './Blockchain';
import { Graph, Link, Measure, MeasureOnAddress } from './graph';

export type DigDeepResults = {
    links: Link[];
    measures: Measure[];
    measuresOnAddress: MeasureOnAddress[];
};

export const dig = async (addresses: string[], stopafter?: string[]) => {
    // ensure addresses are only visited once
    const done = new Set<string>();
    const graph = new Graph();
    while (addresses && addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const blockchainAddress = digOne(address);
            if (blockchainAddress) {
                const stopper = stopafter?.includes(address);
                graph.nodes.set(
                    address,
                    Object.assign(
                        { name: await blockchainAddress.contractNamish(), stopper: stopper },
                        blockchainAddress,
                    ),
                );

                if (!stopper) {
                    const digResults = await digDeep(blockchainAddress);
                    // set the links
                    graph.links.set(address, digResults.links);
                    // and consequent backlinks
                    digResults.links.forEach((link) =>
                        graph.backLinks.set(
                            link.address,
                            (graph.backLinks.get(link.address) ?? []).concat({ address: address, name: link.name }),
                        ),
                    );

                    // add more addresses to be dug up
                    digResults.links.forEach((link) => addresses.push(link.address));

                    // add the measures to the contract
                    graph.measures.set(address, digResults.measures);
                    graph.measuresOnAddress.set(address, digResults.measuresOnAddress);
                }
            }
        }
    }

    // make node names unique &  javascript identifiers
    const nodeNames = new Map<string, string[]>();
    for (const [address, node] of graph.nodes) {
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
                const node = graph.nodes.get(address);
                if (node) {
                    const backLinks = graph.backLinks.get(address);
                    let done = false;
                    if (backLinks && backLinks.length == 1) {
                        const index = backLinks[0].name.match(/\[(\d+)\]$/);
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
    // save named addresses lookup
    for (const [address, node] of graph.nodes) {
        graph.namedAddresses.set(node.name, address);
    }
    return graph;
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

export const digDeep = async (address: BlockchainAddress): Promise<DigDeepResults> => {
    const links: Link[] = [];
    const measures: Measure[] = [];
    const measuresOnAddress: MeasureOnAddress[] = [];
    // follow also the proxy contained addresses
    // unfortunately for some proxies (e.g. openzeppelin's TransparentUpgradeableProxy) only the admin can call functions on the proxy
    for (const contract of [await address.getContract(), await address.getProxyContract()]) {
        if (contract) {
            // TODO: do something with constructor arguments and initialize calls (for logics)
            let functions: FunctionFragment[] = [];
            contract.interface.forEachFunction((func) => functions.push(func));

            // Explore each parameterless view (or pure) functions in the contract's interface
            for (let func of functions.filter((f) => f.stateMutability === 'view' || f.stateMutability === 'pure')) {
                // that returns one or more addresses
                // are added to the links field along with their function name + output name/index
                // first find the indices of the functions we are interested in
                if (func.inputs.length == 0) {
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
                            if (func.outputs[0].type.endsWith('[]'))
                                console.log(
                                    `${await address.contractName()}/${await address.implementationContractName()}: ${
                                        func.name
                                    } returns ${func.outputs[0].type}[]`,
                                );
                            // single number
                            measures.push({
                                calculation: async () => await contract[func.name](),
                                name: outputName(func),
                                type: func.outputs[0].type,
                            });
                        } else {
                            // assume an array/struct of results, some, defined by the indices, containing an uint256 or uint256[]
                            for (const outputIndex of numericIndices) {
                                if (func.outputs[outputIndex].type.endsWith('[]'))
                                    console.log(
                                        `${await address.contractName()}/${await address.implementationContractName()}: ${
                                            func.name
                                        } returns ${func.outputs[0].type}[]`,
                                    );
                                measures.push({
                                    calculation: async () => (await contract[func.name]())[outputIndex],
                                    name: outputName(func, outputIndex),
                                    type: func.outputs[outputIndex].type,
                                });
                            }
                        }
                    }
                }
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
                            if (func.outputs[0].type.endsWith('[]'))
                                console.log(
                                    `${await address.contractName()}/${await address.implementationContractName()}: ${
                                        func.name
                                    } returns ${func.outputs[0].type}[]`,
                                );
                            // single number
                            // TODO: this bit is different to measures
                            else
                                measuresOnAddress.push({
                                    calculation: async (address: string) => await contract[func.name](address),
                                    name: outputName(func),
                                    type: func.outputs[0].type,
                                });
                        } else {
                            // assume an array/struct of results, some, defined by the indices, containing an uint256 or uint256[]
                            for (const outputIndex of numericIndices) {
                                if (func.outputs[outputIndex].type.endsWith('[]')) {
                                    console.log(
                                        `${await address.contractName()}/${await address.implementationContractName()}: ${
                                            func.name
                                        } returns ${func.outputs[0].type}[]`,
                                    );
                                    // TODO: this bit too
                                } else {
                                    measuresOnAddress.push({
                                        calculation: async (address) =>
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
    }
    return { links: links, measures: measures, measuresOnAddress: measuresOnAddress };
};
