import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { EATAddress } from './EATAddress';
import { Link } from './graph';

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

export const dig = (address: string): EATAddress | null => {
    return address !== ZeroAddress ? new EATAddress(address) : null;
};

const identity = <T>(arg: T): T => {
    return arg;
};

/*
const digUp = async<T>(contract: Contract): Promise<{links: T[]> => {
    const links: T[] = [];

        // Explore each function in the contract's interface
        // get parameterless view (or pure) functions
        let functions: FunctionFragment[] = [];
        contract.interface.forEachFunction((func) => {
            // must be parameterless view or pure function
            if (func.inputs.length == 0 && (func.stateMutability === 'view' || func.stateMutability === 'pure')) {
                functions.push(func);
            }
        });
        for (let func of functions) {
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
                            result.push({ toAddress: funcResults, linkName: func.name });
                        } else {
                            // address[]
                            for (let index = 0; index < funcResults.length; index++) {
                                const elem = funcResults[index];
                                result.push({ toAddress: elem, linkName: `${func.name}[${index}]` });
                            }
                        }
                    } else {
                        // assume an array of results, each containing an address or address[]
                        for (const outputIndex of addressIndices) {
                            if (func.outputs[outputIndex].type === 'address') {
                                // single address
                                result.push({
                                    toAddress: funcResults[outputIndex],
                                    linkName: `${func.name}.${func.outputs[outputIndex].name}`,
                                });
                            } else {
                                // address[]
                                for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                    const elem = funcResults[outputIndex][index];
                                    result.push({
                                        toAddress: elem,
                                        linkName: `${func.name}.${func.outputs[outputIndex].name}[${index}]`,
                                    });
                                }
                            }
                        }
                    }
                } catch (err) {
                    console.error(`error calling ${contract.address} ${func.name} ${func.selector}: ${err}`);
                }
            }
        }



    return result;
}
*/

export type NumericFunction = {
    measure: () => Promise<bigint | bigint[]>;
    measureName: string;
};

export type DigDeepResults = {
    links: Link[];
    numerics: NumericFunction[];
};

export const digDeep = async (address: EATAddress): Promise<DigDeepResults> => {
    const links: Link[] = [];
    const numerics: NumericFunction[] = [];
    if (await address.isContract()) {
        // TODO: do something with constructor arguments and initialize calls (for logics)
        // TODO: follow also the proxy contained addresses
        const rpcContract = await address.getContract();

        let functions: FunctionFragment[] = [];
        rpcContract.interface.forEachFunction((func) => functions.push(func));

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
                    const funcResults = await rpcContract[func.name]();
                    if (func.outputs.length == 1) {
                        // single result - containing an address or address[]
                        if (func.outputs[0].type === 'address') {
                            // single address
                            links.push({ toAddress: funcResults, linkName: func.name });
                        } else {
                            // address[]
                            for (let index = 0; index < funcResults.length; index++) {
                                const elem = funcResults[index];
                                links.push({ toAddress: elem, linkName: `${func.name}[${index}]` });
                            }
                        }
                    } else {
                        // assume an array of results, some, defined by the indices, containing an address or address[]
                        for (const outputIndex of addressIndices) {
                            if (func.outputs[outputIndex].type === 'address') {
                                // single address
                                links.push({
                                    toAddress: funcResults[outputIndex],
                                    linkName: `${func.name}.${func.outputs[outputIndex].name}`,
                                });
                            } else {
                                // address[]
                                for (let index = 0; index < funcResults[outputIndex].length; index++) {
                                    const elem = funcResults[outputIndex][index];
                                    links.push({
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

            // same for numerics
            // TODO: see if these two can be factored out
            const numericIndices = func.outputs.reduce((indices, elem, index) => {
                // TODO: uint128, etc, and even bool?
                if (elem.type === 'uint256' || elem.type === 'uint256[]') indices.push(index);
                return indices;
            }, [] as number[]);
            // if any interesting function
            if (numericIndices.length > 0) {
                if (func.outputs.length == 1) {
                    // single result - containing a unit256 or uint256[], likewise below
                    // TODO: is there any need to differentiate between a uint256 & uint256[]?
                    if (func.outputs[0].type === 'unit256') {
                        // single number
                        numerics.push({
                            measure: async (): Promise<bigint> => await rpcContract[func.name](),
                            measureName: func.name,
                        });
                    } else {
                        // number[]
                        numerics.push({
                            measure: async (): Promise<bigint[]> => await rpcContract[func.name](),
                            measureName: func.name,
                        });
                    }
                } else {
                    // assume an array of results, some, defined by the indices, containing an uint256 or uint256[]
                    for (const outputIndex of numericIndices) {
                        if (func.outputs[outputIndex].type === 'uint256') {
                            // single number
                            numerics.push({
                                measure: async (): Promise<bigint> => {
                                    const result = await rpcContract[func.name]();
                                    return result[outputIndex];
                                },
                                measureName: `${func.name}.${func.outputs[outputIndex].name}`,
                            });
                        } else {
                            // number[]
                            numerics.push({
                                measure: async (): Promise<bigint[]> => {
                                    const result = await rpcContract[func.name]();
                                    return result[outputIndex];
                                },
                                measureName: `${func.name}.${func.outputs[outputIndex].name}`,
                            });
                        }
                    }
                }
            }
        }
    }
    return { links: links, numerics: numerics };
};
