import { ethers } from 'hardhat';

import { contracts, measures, measuresOnAddress, nodes, users } from './graph';
import { ContractTransactionResponse, MaxInt256, formatUnits } from 'ethers';
import { Config, ConfigAction, ConfigFormat, getConfig, parseArg, writeYaml } from './config';
import lodash from 'lodash';
import { SnapshotRestorer, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';

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
    user: string;
    contract: string;
    function: string;
    args: string;
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
export const calculateMeasures = async (): Promise<Measurements> => {
    const result: Measurements = [];
    let count = 0;

    const sortedNodes = sort(nodes, (v) => v.name);
    for (const [address, node] of sortedNodes) {
        //console.log(`measuring node ${node.name}`);
        let values: Measurement[] = []; // values for this graph node
        const measuresForAddress = measures.get(address);
        if (measuresForAddress && measuresForAddress.length > 0) {
            for (const measure of measuresForAddress) {
                try {
                    const value = await measure.calculation();
                    values.push({ name: measure.name, type: measure.type, value: value });
                } catch (e: any) {
                    values.push({ name: measure.name, type: measure.type, error: e.message });
                }
            }
        }
        const measuresOnAddressForAddress = measuresOnAddress.get(address);
        if (measuresOnAddressForAddress && measuresOnAddressForAddress.length > 0) {
            for (const [targetAddress, targetNode] of sortedNodes) {
                if (targetAddress === address) continue; // skip self
                for (const measure of measuresOnAddressForAddress) {
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
    console.log(`  Nodes: ${sortedNodes.length}, Measurements: ${count}`);
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
                const baseIsArray = lodash.isArray(baseMeasurement.value);
                const actionedIsArray = lodash.isArray(actionedMeasurement.value);
                if (!baseIsArray && !actionedIsArray) {
                    // both bigint
                    if (baseMeasurement.value !== actionedMeasurement.value) {
                        deltas.push({
                            name: actionedMeasurement.name,
                            type: actionedMeasurement.type,
                            target: actionedMeasurement.target,
                            delta: (actionedMeasurement.value as bigint) - (baseMeasurement.value as bigint),
                        });
                    }
                } else if (baseIsArray && actionedIsArray) {
                    // both bigint[]
                    const baseArray = baseMeasurement.value as bigint[];
                    const actionedArray = actionedMeasurement.value as bigint[];
                    if (baseArray.length === actionedArray.length) {
                        let delta: bigint[] = [];
                        let diffs = false;
                        for (let i = 0; i < baseArray.length; i++) {
                            if (actionedArray[i] !== baseArray[i]) diffs = true;
                            delta.push(actionedArray[i] - baseArray[i]);
                        }
                        if (diffs) {
                            deltas.push({
                                name: actionedMeasurement.name,
                                type: actionedMeasurement.type,
                                target: actionedMeasurement.target,
                                delta: delta,
                            });
                        }
                    } else {
                        deltas.push({
                            name: actionedMeasurement.name,
                            type: actionedMeasurement.type,
                            target: actionedMeasurement.target,
                            error: `arrays changed length: ${baseArray.length} => ${actionedArray.length}`,
                        });
                    }
                } else {
                    // but different types
                    deltas.push({
                        name: actionedMeasurement.name,
                        type: actionedMeasurement.type,
                        target: actionedMeasurement.target,
                        error: `int${baseIsArray ? '[]' : ''} => int${actionedIsArray ? '[]' : ''}`,
                    });
                }
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

const formatFromConfig = (address: any): any => {
    // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
    if (typeof address === 'object' && typeof address.measurements === 'object') {
        // it is something we can handle
        let newAddress: any = undefined;
        address.measurements.forEach((measurement: Measurement, index: number) => {
            if (measurement && (measurement.value || measurement.delta)) {
                // need to patch up arrays, whether we format them or not
                const fieldNames = ['value', 'delta'];
                if (getConfig().format)
                    for (const anyformat of getConfig().format) {
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
                            // we have a match - so what kind of formatting
                            if (format.unit) {
                                for (const fieldName of fieldNames) {
                                    const field = (measurement as any)[fieldName];
                                    if (field !== undefined) {
                                        if (lodash.isArray(field)) {
                                            newAddress.measurements[index][fieldName] = field.map((elem) =>
                                                formatUnits(elem, format.unit),
                                            );
                                        } else {
                                            newAddress.measurements[index][fieldName] = formatUnits(
                                                field as bigint,
                                                format.unit,
                                            );
                                        }
                                    }
                                }
                            }
                            break; // only do one format, the first
                        }
                    }
            }
        });
        return newAddress; // undefied means it is handled by the callere
    }
};

////////////////////////////////////////////////////////////////////////
// delve
export const delve = async (): Promise<void> => {
    // formatting of output

    let snapshot = await takeSnapshot(); // the state of the world before

    const baseMeasurements = await calculateMeasures();
    writeYaml('measures.yml', baseMeasurements, formatFromConfig);

    let i = 0;
    for (const configAction of getConfig().actions ?? []) {
        const actionName = `${configAction.contract}-${configAction.function}`;
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

        // do the post action measures
        const actionedMeasurements = await calculateMeasures();
        actionedMeasurements.unshift({
            actionName: actionName,
            contract: configAction.contract,
            function: configAction.function,
            user: configAction.user,
            args: JSON.stringify(configAction.args),
            error: error,
            gas: gas,
        });
        writeYaml(`${actionName}.measures.yml`, actionedMeasurements, formatFromConfig);

        // difference the measures
        const deltaMeasurements = calculateDeltaMeasures(baseMeasurements!, actionedMeasurements);
        // write the results
        writeYaml(`${actionName}.measures.delta.yml`, deltaMeasurements, formatFromConfig);

        // don't restore for the last in the loop
        if (++i < getConfig().actions.length) snapshot.restore();
    }
};
