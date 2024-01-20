import { contracts, measures, measuresOnAddress, nodes, users } from './graph';
import { ContractTransactionResponse, MaxInt256, formatUnits } from 'ethers';
import { ConfigFormatApply, getConfig, parseArg, writeYaml } from './config';
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
    // value can hold a value or a delta value for comparisons
    delta?: MeasurementValue;
    value?: MeasurementValue;
    // error can hold an error, a change in error message or indicate a change from a value to/from an error
    error?: string;
};

export type Variable = {
    name: string;
    value: string;
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
} & Partial<Action>;

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
    console.log(`   Nodes: ${sortedNodes.length}, Measurements: ${count}`);
    return result;
};

////////////////////////////////////////////////////////////////////////
// calculateMeasures
export const calculateSlimMeasures = async (baseMeasurements: Measurements): Promise<Measurements> => {
    const result: Measurements = [];
    let count = 0;

    for (const contract of baseMeasurements.filter((m) => m.measurements)) {
        const nonZero = (contract as ContractMeasurements).measurements.filter((measure) => {
            if (measure.value)
                if (lodash.isArray(measure.value)) return measure.value.length > 0;
                else return true;
            else return measure.error ? true : false;
        });
        if (nonZero.length > 0) {
            // copy top level stuff
            const resultContract = lodash.clone(contract);
            resultContract.measurements = nonZero; // replace measurements
            result.push(resultContract);
        }
    }
    return result;
};

////////////////////////////////////////////////////////////////////////
// calculateDeltaMeasures
export const calculateDeltaMeasures = (
    baseMeasurements: Measurements,
    actionedMeasurements: Measurements,
): Measurements => {
    const results: Measurements = [];

    // loop through actioned measurements, just the actual measurements, nothing else
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

// only do doDecimals after formatting by unit, else there's no decimals!
const doFormat = (fieldName: string, value: bigint, unit?: number | string, decimals?: number): string => {
    let result = unit ? formatUnits(value, unit) : value.toString();
    if (decimals !== undefined) {
        // it's been formatted, so round to that many decimals
        const decimalIndex = result.indexOf('.');
        // Calculate the number of decimal places
        const currentDecimals = decimalIndex >= 0 ? result.length - decimalIndex - 1 : 0;
        if (currentDecimals > decimals) {
            // TODO: round the number
            result = result.slice(undefined, decimals - currentDecimals);
        }
    }
    return (fieldName === 'delta' && value > 0 ? '+' : '') + result;
};

const formatFromConfig = (address: any): any => {
    // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
    if (typeof address === 'object' && typeof address.measurements === 'object') {
        // it is something we can handle
        // we're about to change it so clone it
        const newAddress: any = lodash.cloneDeep(address);
        for (let measurement of newAddress.measurements) {
            if (measurement && (measurement.value || measurement.delta)) {
                // need to patch up arrays, whether we format them or not
                const fieldNames = ['value', 'delta'];
                if (getConfig().format) {
                    let mergedFormat: ConfigFormatApply = {};
                    let donotformat = false;
                    for (const format of getConfig().format) {
                        // TODO: could some things,
                        // like timestamps be represented as date/times
                        // or numbers
                        // merge all the formats that apply
                        // TODO: add regexp matches, rather than === matches
                        if (
                            (!format.type || format.type === measurement.type) &&
                            (!format.name || format.name === measurement.name) &&
                            (!format.contract || format.contract === newAddress.contract)
                        ) {
                            if (format.unit === undefined && format.decimals === undefined) {
                                donotformat = true;
                                break; // got a no format request
                            }

                            if (format.unit !== undefined && mergedFormat.unit === undefined)
                                mergedFormat.unit = format.unit;
                            if (format.decimals !== undefined && mergedFormat.decimals === undefined)
                                mergedFormat.decimals = format.decimals;

                            if (mergedFormat.unit !== undefined && mergedFormat.decimals !== undefined) break; // got enough
                        }
                    }
                    if (donotformat) {
                        if (getConfig().show?.includes('format')) {
                            measurement.format = {};
                        }
                    } else if (mergedFormat.unit !== undefined) {
                        for (const fieldName of fieldNames) {
                            if (measurement[fieldName] !== undefined) {
                                let formatters: ((value: bigint) => bigint | string)[] = [];
                                // always do unit before decimals
                                formatters.push((value) =>
                                    doFormat(
                                        fieldName,
                                        value,
                                        mergedFormat.unit as string | number,
                                        mergedFormat.decimals,
                                    ),
                                );

                                formatters.forEach((formatter) => {
                                    if (lodash.isArray(measurement[fieldName])) {
                                        measurement[fieldName] = measurement[fieldName].map((elem: any) =>
                                            formatter(elem),
                                        );
                                    } else {
                                        measurement[fieldName] = formatter(measurement[fieldName]);
                                    }
                                });
                            }
                        }
                        if (getConfig().show?.includes('format')) {
                            measurement.format = mergedFormat;
                        }
                    }
                }
            }
        }
        return newAddress; // undefied means it is handled by the callere
    }
};

////////////////////////////////////////////////////////////////////////
// delve

export type VariableCalculator = {
    name: string;
    next: () => Promise<string | undefined>;
};

type VariableValue = {
    name: string;
    value: any;
};
export const delve = async (variable?: VariableCalculator): Promise<void> => {
    // formatting of output

    let snapshot = await takeSnapshot(); // the state of the world before

    if (!variable) {
        await delveOnce(snapshot);
    } else {
        while (true) {
            const value = await variable.next();
            if (!value) break;
            await delveOnce(snapshot, { name: variable.name, value: value });
        }
    }
};

const delveOnce = async (snapshot: SnapshotRestorer, value?: VariableValue): Promise<void> => {
    const variablePrefix = value ? `${value.name}=${value.value.toString()}.` : '';
    if (value) console.log(`      ${variablePrefix}`);

    const baseMeasurements = await calculateMeasures();
    if (value) {
        baseMeasurements.unshift({ name: value.name, value: value.value });
    }
    writeYaml(`${variablePrefix}measures.yml`, baseMeasurements, formatFromConfig);
    writeYaml(`${variablePrefix}slim-measures.yml`, await calculateSlimMeasures(baseMeasurements), formatFromConfig);

    let i = 0;
    for (const configAction of getConfig().actions ?? []) {
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

        const actionName = `${configAction.contract}-${configAction.function}`;

        // do the post action measures
        const actionedMeasurements = await calculateMeasures();
        if (value) {
            baseMeasurements.unshift({ name: value.name, value: value.value });
        }
        actionedMeasurements.unshift({
            name: actionName,
            user: configAction.user,
            contract: configAction.contract,
            function: configAction.function,
            args: JSON.stringify(configAction.args),
            error: error,
            gas: gas,
        });

        const prefix = `${variablePrefix}${actionName}.`;

        writeYaml(`${prefix}measures.yml`, actionedMeasurements, formatFromConfig);
        writeYaml(`${prefix}slim-measures.yml`, await calculateSlimMeasures(actionedMeasurements), formatFromConfig);

        // difference the measures
        // write the results
        writeYaml(
            `${prefix}delta-measures.yml`,
            calculateDeltaMeasures(baseMeasurements!, actionedMeasurements),
            formatFromConfig,
        );

        snapshot.restore();
    }
};
