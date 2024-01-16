import { ethers } from 'hardhat';

import { Graph } from './graph';
import { Blockchain } from './Blockchain';
import { digOne } from './dig';
import { ContractTransactionResponse, MaxInt256, MaxUint256, formatUnits, parseEther, parseUnits } from 'ethers';
import { Config, ConfigAction, ConfigFormat, nullAction, writeYaml } from './config';
import lodash from 'lodash';
import { string } from 'yargs';

// TODO: add Contract may be useful if the contract is not part of the dig Graph
/*
export const addContract = async (
    system: PAMSystem,
    address: string,
    signer: UserWithAddress,
    types: string[] = [],
): Promise<ContractWithAddress<Contract>> => {
    // create the contract
    const contract = await getContract(address, signer);
    // add its types
    types.map((type) => system.defThing(contract, type));
    if (contract.tokenSymbol) {
        system.defThing(contract, 'token');
    }
    // set up calls to the parameterless view/pure functions that return a single number
    // TODO: handle multiple number returns
    contract.interface.forEachFunction((func) => {
        if (
            func.inputs.length == 0 &&
            (func.stateMutability === 'view' || func.stateMutability === 'pure') &&
            func.outputs.length == 1 &&
            func.outputs[0].type === 'uint256'
        ) {
            system.defCalculation(`${contract.name}.${func.name}`, async () => {
                return contract[func.name]();
            });
        }
    });

    return contract;
};
*/

type ActionFunction = () => Promise<ContractTransactionResponse>;
type Actions = Map<string, ActionFunction>;

export const sort = <K, V>(unsorted: Map<K, V>, field: (v: V) => string) => {
    return Array.from(unsorted.entries()).sort((a, b) =>
        field(a[1]).localeCompare(field(b[1]), 'en', { sensitivity: 'base' }),
    );
};

export type MeasurementValue = bigint | bigint[];
export type Measurement = {
    name: string;
    type: string;
    target?: string;
    // TODO: revisit the design of deltas and values/errors overlaying each other
    // value can hold a value or a delta value for comparisons
    delta?: MeasurementValue;
    value?: MeasurementValue;
    // error can hold an error, a change in error message or indicate a change from a value to/from an error
    error?: string;
};

export type Variable = {
    name: string;
    value: bigint;
};

export type Action = {
    name: string;
    // the function gets evaluated by eval()?
    addressName: string; // foreign key
    userName: string;
    functionName: string;
    arguments: string[];
    gas?: bigint;
    error?: string;
};

export type ContractMeasurements = {
    address: string;
    name: string; // node name
    contract: string; // contract nameish
    measurements: Measurement[];
} & Partial<{
    actionName: string;
    // TODO: should be error | gas not both
    error?: string;
    gas?: bigint;
}>;

export type Measurements = (Partial<Variable> & Partial<Action> & Partial<ContractMeasurements>)[];

////////////////////////////////////////////////////////////////////////
// calculateMeasures
export const calculateMeasures = async (graph: Graph): Promise<Measurements> => {
    const result: Measurements = [];
    let count = 0;

    const sortedNodes = sort(graph.nodes, (v) => v.name);
    console.log(`Nodes: ${sortedNodes.length}`);
    for (const [address, node] of sortedNodes) {
        let values: Measurement[] = []; // values for this graph node
        const measures = graph.measures.get(address);
        if (measures && measures.length > 0) {
            for (const measure of measures) {
                try {
                    const value = await measure.calculation();
                    values.push({ name: measure.name, type: measure.type, value: value });
                } catch (e: any) {
                    values.push({ name: measure.name, type: measure.type, error: e.message });
                }
            }
        }
        const measuresOnAddress = graph.measuresOnAddress.get(address);
        if (measuresOnAddress && measuresOnAddress.length > 0) {
            for (const [targetAddress, targetNode] of sortedNodes) {
                for (const measure of measuresOnAddress) {
                    try {
                        const value = await measure.calculation(targetAddress);
                        values.push({
                            name: measure.name,
                            type: measure.type,
                            target: targetNode.name,
                            value: value,
                        });
                    } catch (e: any) {
                        values.push({
                            name: measure.name,
                            type: measure.type,
                            target: targetNode.name,
                            error: e.message,
                        });
                    }
                }
            }
        }
        if (values.length > 0) {
            result.push({
                address: address,
                name: node.name,
                contract: await node.contractNamish(),
                measurements: values,
            });
            count += values.length;
        }
    }
    console.log(`Measurements: ${count}`);
    return result;
};

////////////////////////////////////////////////////////////////////////
// calculateDeltaMeasures
export const calculateDeltaMeasures = (
    baseMeasurements: Measurements,
    actionedMeasurements: Measurements,
): Measurements => {
    const results: Measurements = [];

    // loop through actioned measurements, just the actual measurements
    const actionedContractMeasurements: Measurements = actionedMeasurements.filter((m: any) =>
        m.measurements ? true : false,
    );
    if (baseMeasurements.length !== actionedContractMeasurements.length)
        throw Error(
            `contract measurements differ: baseMeasurements ${baseMeasurements.length} actionedMeasurements ${actionedContractMeasurements.length}`,
        );

    for (let a = 0; a < actionedContractMeasurements.length; a++) {
        const baseContract = baseMeasurements[a] as ContractMeasurements;
        const actionedContract = actionedContractMeasurements[a] as ContractMeasurements;

        if (
            actionedContract.address !== baseContract.address ||
            actionedContract.name !== baseContract.name ||
            actionedContract.contract !== baseContract.contract
        )
            throw Error(
                `contract measurements[${a}] mismatch base: ${JSON.stringify(baseContract)}; actioned: ${JSON.stringify(
                    actionedContract,
                )}`,
            );

        if (actionedContract.measurements.length !== baseContract.measurements.length)
            throw Error(`contract measurements[${a}] mismatch on number of measurements`);

        const deltas: Measurement[] = [];
        for (let m = 0; m < actionedContract.measurements.length; m++) {
            const baseMeasurement = baseContract.measurements[m];
            const actionedMeasurement = actionedContract.measurements[m];

            if (actionedMeasurement.name !== baseMeasurement.name || actionedMeasurement.type !== baseMeasurement.type)
                throw Error('attempt to diff measurements of different structures');

            // TODO: handle arrays of values wherever a "value:" or "delta:" is written below
            if (baseMeasurement.error && actionedMeasurement.error) {
                // both errors
                if (baseMeasurement.error !== actionedMeasurement.error)
                    deltas.push({
                        name: actionedMeasurement.name,
                        type: actionedMeasurement.type,
                        error: `"${baseMeasurement.error}" => "${actionedMeasurement.error}"`,
                    });
            } else if (baseMeasurement.error && !actionedMeasurement.error) {
                // different kind of result
                deltas.push({
                    name: actionedMeasurement.name,
                    type: actionedMeasurement.type,
                    error: `"${baseMeasurement.error}" => value`,
                    value: actionedMeasurement.value,
                });
            } else if (!baseMeasurement.error && actionedMeasurement.error) {
                // different kind of result
                deltas.push({
                    name: actionedMeasurement.name,
                    type: actionedMeasurement.type,
                    error: `value => "${actionedMeasurement.error}"`,
                    value: baseMeasurement.value,
                });
            } else {
                // both values
                if (baseMeasurement.value !== actionedMeasurement.value)
                    // TODO: handle arrays of bigints
                    deltas.push({
                        name: actionedMeasurement.name,
                        type: actionedMeasurement.type,
                        target: actionedMeasurement.target,
                        delta: (actionedMeasurement.value as bigint) - (baseMeasurement.value as bigint),
                    });
            }
        }
        if (deltas.length > 0)
            results.push({
                address: actionedContract.address,
                name: actionedContract.name,
                contract: actionedContract.contract,
                measurements: deltas,
            });
    }
    return results;
};

const parseArg = (configArg: any, users?: any, contracts?: any): string | bigint => {
    let arg: any;
    if (typeof configArg === 'bigint') {
        arg = configArg;
    } else if (typeof configArg === 'string') {
        // contract or user or address or string or number
        const match = configArg.match(/^\s*(\d+)\s*(\w+)\s*$/);
        if (match && match.length === 3) arg = parseUnits(match[1], match[2]);
        else if (users[configArg]) arg = users[configArg].address;
        else if (contracts[configArg]) arg = contracts[configArg].address;
    } else if (typeof configArg === 'number') arg = BigInt(configArg);
    else arg = 0n;
    return arg;
};

////////////////////////////////////////////////////////////////////////
// delve
export const delve = async (config: Config, dugGraph: Graph, blockchain: Blockchain): Promise<void> => {
    // formatting of output
    const formatFromConfig = (address: any): any => {
        // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
        if (typeof address === 'object' && typeof address.measurements === 'object') {
            let newAddress: any = undefined;
            address.measurements.forEach((measurement: Measurement, index: number) => {
                if (measurement && config.format && (measurement.value || measurement.delta)) {
                    for (const anyformat of config.format) {
                        const format: ConfigFormat = anyformat;
                        // TODO: could some things,
                        // like timestamps be represented as date/times
                        // or numbers
                        if (
                            (!format.type || format.type === measurement.type) &&
                            (!format.name || format.name === measurement.name) &&
                            (!format.contract || format.contract === address.contract)
                        ) {
                            // we're about to change it so clone it
                            if (!newAddress) newAddress = lodash.cloneDeep(address);
                            // TODO: handle values that are arrays
                            // we have a match - so what kind of formatting
                            if (format.unit) {
                                const formatByUnits = (field: string) => {
                                    newAddress.measurements[index][field] = formatUnits(
                                        (measurement as any)[field] as bigint, // << this should handle bigint[] too
                                        format.unit,
                                    );
                                };
                                // TODO: make this more dynamic
                                if (measurement.value) formatByUnits('value');
                                if (measurement.delta) formatByUnits('delta');
                            }
                            break; // only do one format, the first
                        }
                    }
                }
            });
            return newAddress;
        }
    };

    // TODO: allow additional actions this to be passed in for user defined actions?

    let baseMeasurements: Measurements;
    for (const configAction of [nullAction, ...(config.actions ? config.actions : [])]) {
        // start with a fresh blockchain
        blockchain.reset();
        const graph = lodash.cloneDeep(dugGraph);
        console.log(`graph: ${dugGraph.nodes.size} => ${graph.nodes.size}`);

        let contracts: any = {};
        let users: any = {};

        // set up the graph contracts and users for executing the actions
        for (const [name, address] of graph.namedAddresses) {
            const contract = await graph.nodes.get(address)?.getContract();
            if (contract) {
                contracts[name] = contract;
            } else {
                users[name] = await ethers.getImpersonatedSigner(address);
            }
        }
        // add in the users from the config
        if (config.users) {
            for (const user of config.users) {
                const signer = await blockchain.getSigner(user.name);
                users[user.name] = signer; // to be used in actions
                // add them to the graph, too
                console.log(
                    `about to add user ${user.name}, ${signer.address}, is that address free? ${JSON.stringify(
                        graph.nodes.get(signer.address),
                    )}`,
                );
                graph.nodes.set(
                    signer.address,
                    Object.assign({ name: user.name, signer: signer }, digOne(signer.address)),
                );
                console.log(`after adding user ${user.name}, ${signer.address}, graph: ${graph.nodes.size}`);
                if (user.wallet) {
                    for (const holding of user.wallet) {
                        // fill the wallet
                        // TODO: create a whales file that hands out dosh
                        const stEthWhale = await ethers.getImpersonatedSigner(
                            '0x95ed9BC02Be94C17392fE819A93dC57E73E1222E',
                        );
                        if (
                            !(await contracts[holding.contract]
                                .connect(stEthWhale)
                                .transfer(users[user.name].address, parseArg(holding.amount)))
                        ) {
                            throw Error('could not get enough stETH, find another whale');
                        }
                        // find all the contracts this user interacts with and allow them to spend there
                        if (config.actions) {
                            for (const contract of config.actions
                                .filter((a) => a.user && a.user === user.name)
                                .map((a) => a.contract)) {
                                // allow the wallet to be spent
                                await contracts[holding.contract]
                                    .connect(users[user.name])
                                    .approve(contracts[contract].address, MaxUint256);
                            }
                        }
                    }
                }
            }
        }
        const actionName = `${configAction.contract}-${configAction.function}(${JSON.stringify(configAction.args)
            .replace(/[/\\:*?"<>|]/g, '')
            .replace(/\s+/g, '_')}-${configAction.user}`;

        const action: ActionFunction = async () => {
            const args = configAction.args.map((a) => parseArg(a, users, contracts));
            return contracts[configAction.contract].connect(users[configAction.user])[configAction.function](...args);
        };

        // execute action
        let error: string | undefined = undefined;
        let gas: bigint | undefined = undefined;
        try {
            let tx = await action();
            let receipt = await tx.wait();
            gas = receipt ? receipt.gasUsed : MaxInt256;
        } catch (e: any) {
            error = e.message; // failure
        }

        if (configAction === nullAction) {
            // measures before the actual actions
            baseMeasurements = await calculateMeasures(graph);
            writeYaml(config, 'measures.yml', baseMeasurements, formatFromConfig);
        } else {
            // do the post action measures
            const actionedMeasurements = await calculateMeasures(graph);
            actionedMeasurements.unshift({
                actionName: actionName,
                /*
                        addressName: action.'address', // foreign key
                        userName: 'user',
                        functionName: 'func',
                        arguments: ['hello', 'world'],
                        */
                error: error,
                gas: gas,
            });
            writeYaml(config, `${actionName}.measures.yml`, actionedMeasurements, formatFromConfig);

            // difference the measures
            const deltaMeasurements = calculateDeltaMeasures(baseMeasurements!, actionedMeasurements);
            // write the results
            writeYaml(config, `${actionName}.measures.delta.yml`, deltaMeasurements, formatFromConfig);
        }
    }
};
