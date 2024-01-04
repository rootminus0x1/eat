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

export const digDeep = async (address: EATAddress): Promise<Link[]> => {
    const result: Link[] = [];
    if (await address.isContract()) {
        // TODO: do something with constructor arguments and initialize calls (for logics)
        // TODO: follow also the proxy contained addresses
        const rpcContract = await address.getContract();

        // Explore each function in the contract's interface
        // get parameterless view (or pure) functions
        let functions: FunctionFragment[] = [];
        rpcContract.interface.forEachFunction((func) => {
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
                    const funcResults = await rpcContract[func.name]();
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
                    console.error(`error calling ${address} ${func.name} ${func.selector}: ${err}`);
                }
            }
        }
    }
    return result;
};
