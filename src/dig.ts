import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { BlockchainAddress } from './Blockchain';
import { Graph, Link, Measure } from './graph';

export type DigDeepResults = {
    links: Link[];
    measures: Measure[];
};

export const digGraph = async (addresses: string[], stopafter?: string[]) => {
    // ensure addresses are only visited once
    const done = new Set<string>();
    const graph = new Graph();
    while (addresses && addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const blockchainAddress = dig(address);
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
                    graph.measures.set(address, digResults.measures);
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

export const dig = (address: string): BlockchainAddress | null => {
    return address !== ZeroAddress ? new BlockchainAddress(address) : null;
};

export const digDeep = async (address: BlockchainAddress): Promise<DigDeepResults> => {
    const links: Link[] = [];
    const measures: Measure[] = [];
    const contract = await address.getContract();
    if (contract) {
        // TODO: do something with constructor arguments and initialize calls (for logics)
        // TODO: follow also the proxy contained addresses

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
                            links.push({ address: funcResults, name: func.name });
                        } else {
                            // address[]
                            for (let index = 0; index < funcResults.length; index++) {
                                const elem = funcResults[index];
                                links.push({ address: elem, name: `${func.name}[${index}]` });
                            }
                        }
                    } else {
                        // assume an array of results, some, defined by the indices, containing an address or address[]
                        for (const outputIndex of addressIndices) {
                            if (func.outputs[outputIndex].type === 'address') {
                                // single address
                                links.push({
                                    address: funcResults[outputIndex],
                                    name: `${func.name}.${func.outputs[outputIndex].name}`,
                                });
                            } else {
                                // address[]
                                for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                    const elem = funcResults[outputIndex][index];
                                    links.push({
                                        address: elem,
                                        name: `${func.name}.${func.outputs[outputIndex].name}[${index}]`,
                                    });
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error(`error calling ${address} ${func.name} ${func.selector}: ${err}`);
                }
            }

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
                        name: `${func.name}`,
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
                            name: `${func.name}.${func.outputs[outputIndex].name}`,
                            type: func.outputs[outputIndex].type,
                        });
                    }
                }
            }
        }
    }
    return { links: links, measures: measures };
};
