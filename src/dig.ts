import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { DugAddress } from './DUGAddress';
// import { GraphContract, GraphNode, GraphNodeType } from './graphnode';

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

export async function dig(address: string, follow: boolean): Promise<DugAddress> {
    let result = new DugAddress(address);
    if (follow && (await result.isContract())) {
        // TODO: do something with constructor arguments and initialize calls (for logics)
        // TODO: follow also the proxy contained addresses
        const rpcContract = await result.getContract();
        // Explore each function in the contract's interface and check it's return
        let functions: FunctionFragment[] = [];
        rpcContract.interface.forEachFunction((func) => {
            // must be parameterless view or pure function
            if (func.inputs.length == 0 && (func.stateMutability === 'view' || func.stateMutability === 'pure')) {
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
                        // single result - containing an address or address[]
                        if (func.outputs[0].type === 'address') {
                            // single address
                            result.links.push({ toAddress: funcResults, linkName: func.name });
                        } else {
                            // address[]
                            for (let index = 0; index < funcResults.length; index++) {
                                const elem = funcResults[index];
                                result.links.push({ toAddress: elem, linkName: `${func.name}[${index}]` });
                            }
                        }
                    } else {
                        // assume an array of results, each containing an address or address[]
                        for (const outputIndex of addressIndices) {
                            if (func.outputs[outputIndex].type === 'address') {
                                // single address
                                result.links.push({
                                    toAddress: funcResults[outputIndex],
                                    linkName: `${func.name}.${func.outputs[outputIndex].name}`,
                                });
                            } else {
                                // address[]
                                for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                    const elem = funcResults[outputIndex][index];
                                    result.links.push({
                                        toAddress: elem,
                                        linkName: `${func.name}.${func.outputs[outputIndex].name}[${index}]`,
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
    return result;
}
