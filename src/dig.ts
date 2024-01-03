import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { EatContract } from './eatcontract';
import { GraphContract, GraphNode, GraphNodeType } from './graphnode';

/*
function hasFunction(abi: ethers.Interface, name: string, inputTypes: string[], outputTypes: string[]): boolean {
    abi.forEachFunction(async (func) => {
        if (
            func.name === name &&
            func.inputs.reduce((matches, input, index) => {
                return matches && input.type == inputTypes[index];
            }, true) &&
            func.outputs.reduce((matches, output, index) => {
                return matches && output.type == outputTypes[index];
            }, true)
        )
            return true;
    });
    return false;
}
*/

export async function dig(address: string, follow: boolean): Promise<GraphNode> {
    let result = new GraphNode(address);

    // what kind of address
    if (ethers.isAddress(address)) {
        const code = await ethers.provider.getCode(address);
        if (code !== '0x') {
            result.type = GraphNodeType.contract;
            const contract = new EatContract(address);
            result.contract = new GraphContract(contract.address, await contract.name());
            if (await contract.name()) result.name = await contract.name();
            // set up the ABI to use for following addresses
            // TODO: put a lot f this into the EatConract
            let source = await contract.sourceCode();
            let abi = source?.ABI;
            let rpcContract: Contract;
            // lookup the ERC20 token name, if it exists
            const erc20Token = new ethers.Contract(
                address,
                ['function name() view returns (string)', 'function symbol() view returns (string)'],
                ethers.provider,
            );
            try {
                const erc20Name = await erc20Token.name();
                const erc20Symbol = await erc20Token.symbol();
                if (erc20Name || erc20Symbol) result.token = `${erc20Symbol} (${erc20Name})`;
            } catch (error) {}
            // TODO: do something with constructor arguments and initialize calls (for logics)
            if (source && source.Proxy > 0) {
                // It's a proxy
                const implementation = new EatContract(source.Implementation);
                // replace the ABI to use for following addresses
                // TODO: merge this abi with the proxy abi, maybe later when searching the functions
                abi = (await implementation.sourceCode())?.ABI;
                result.implementations.push(new GraphContract(implementation.address, await implementation.name()));
                // TODO: get the update history
                // Get historical transactions for the proxy contract
                const events = await ethers.provider.getLogs({
                    address: address,
                    topics: [ethers.id('Upgraded(address)')],
                    fromBlock: 0,
                    toBlock: 'latest',
                });
                if (events.length > 0) {
                    // TODO: iterate the events and add them as implementations
                    // get the latest event's first topic as the proxy implementation
                    const topic = events[events.length - 1]?.topics[1];
                    if (topic) {
                        // TODO: this should be a decoding of the topics according to event Upgraded(address indexed implementation)
                        // result.logic = '0x' + topic.slice(-40);
                    }
                }
            }
            if (abi && follow) {
                // TODO: combine the proxy and implementation abi's
                rpcContract = new ethers.Contract(address, abi, ethers.provider);
                // Explore each function in the contract's interface and check it's return

                let functions: FunctionFragment[] = [];
                rpcContract.interface.forEachFunction((func) => {
                    // must be parameterless view or pure function
                    if (
                        func.inputs.length == 0 &&
                        (func.stateMutability === 'view' || func.stateMutability === 'pure')
                    ) {
                        functions.push(func);
                    }
                });
                for (let func of functions) {
                    // that returns one or more addresses
                    const addressIndices = func.outputs.reduce((indices, elem, index) => {
                        if (elem.type === 'address' || elem.type === 'address[]') indices.push(index);
                        return indices;
                    }, [] as number[]);
                    if (addressIndices.length > 0) {
                        try {
                            const funcResults = await rpcContract[func.name]();
                            if (func.outputs.length == 1) {
                                if (func.outputs[0].type === 'address') {
                                    result.links.push({ to: funcResults, name: func.name });
                                } else {
                                    // address[]
                                    for (let index = 0; index < funcResults.length; index++) {
                                        const elem = funcResults[index];
                                        result.links.push({ to: elem, name: `${func.name}[${index}]` });
                                    }
                                }
                            } else {
                                // assume an array of results
                                for (const outputIndex of addressIndices) {
                                    if (func.outputs[outputIndex].type === 'address') {
                                        result.links.push({
                                            to: funcResults[outputIndex],
                                            name: `${func.name}.${func.outputs[outputIndex].name}`,
                                        });
                                    } else {
                                        // address[]
                                        for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                            const elem = funcResults[outputIndex][index];
                                            result.links.push({
                                                to: elem,
                                                name: `${func.name}.${func.outputs[outputIndex].name}[${index}]`,
                                            });
                                        }
                                    }
                                }
                                //console.error('array or results containing an address');
                            }
                        } catch (err) {
                            console.error(`error calling ${address} ${func.name} ${func.selector}: ${err}`);
                        }
                    }
                }
            }
        } else {
            result.type = GraphNodeType.address;
        }
    } else {
        result.type = GraphNodeType.invalid;
    }
    return result;
}
