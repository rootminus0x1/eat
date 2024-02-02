import { contracts, measures, measuresOnAddress, nodes, users } from './graph';
import { ContractTransactionResponse, MaxInt256, formatEther, formatUnits } from 'ethers';
import { ConfigFormatApply, eatFileName, getConfig, parseArg, writeEatFile, writeYaml } from './config';
import lodash from 'lodash';
import { takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';

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
    name: string; // node name - this is the contract
    // TODO: contract is ambiguous - is it the contract or the contract type
    contractType: string; // contract nameish
    measurements: Measurement[];
} & Partial<Action>;

export type Measurements = (Partial<Variable> & Partial<Action> & Partial<ContractMeasurements>)[];

////////////////////////////////////////////////////////////////////////
// calculateMeasures

export type MeasurementsMatch = {
    contract: string;
    functions: string[];
};

export const calculateMeasures = async (onlyDoThese?: MeasurementsMatch[]): Promise<Measurements> => {
    const result: Measurements = [];
    let count = 0;

    const sortedNodes = sort(nodes, (v) => v.name);
    for (const [address, node] of sortedNodes) {
        let onlyDoTheseForContract: string[] = [];
        if (onlyDoThese) {
            for (const m of onlyDoThese)
                if (m.contract === node.name) {
                    onlyDoTheseForContract = m.functions;
                    break;
                }
            if (onlyDoTheseForContract.length === 0) continue; // skip this contract
        }
        //console.log(`measuring node ${node.name}`);
        let values: Measurement[] = []; // values for this graph node
        const measuresForAddress = measures.get(address);
        if (measuresForAddress && measuresForAddress.length > 0) {
            // only do measurments for addresses with a name (they're users otherwise)
            for (const measure of measuresForAddress.filter((m) => m.name)) {
                // skip if it has not been requested
                if (onlyDoTheseForContract.length > 0 && !onlyDoTheseForContract.includes(measure.name)) continue;
                try {
                    const value = await measure.calculation();
                    values.push({ name: measure.name, type: measure.type, value: value });
                } catch (e: any) {
                    values.push({ name: measure.name, type: measure.type, error: e.message });
                }
            }
        }
        if (!onlyDoThese) {
            // TODO: add the ability to filter in measures on address - need to pass in the addresses
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
        }
        if (values.length > 0) {
            result.push({
                address: address,
                name: node.name,
                contractType: await node.contractNamish(),
                measurements: values,
            });
            count += values.length;
        }
    }
    // console.log(`   Nodes: ${sortedNodes.length}, Measurements: ${count}`);
    return result;
};

////////////////////////////////////////////////////////////////////////
// calculateMeasures
export const calculateSlimMeasures = async (baseMeasurements: Measurements): Promise<Measurements> => {
    const result: Measurements = [];

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
    const baseContractMeasurements: Measurements = baseMeasurements.filter((m: any) => (m.measurements ? true : false));

    if (baseContractMeasurements.length !== actionedContractMeasurements.length)
        throw Error(
            `contract measurements differ: baseMeasurements ${baseContractMeasurements.length} actionedMeasurements ${actionedContractMeasurements.length}`,
        );

    for (let a = 0; a < actionedContractMeasurements.length; a++) {
        const baseContract = baseContractMeasurements[a] as ContractMeasurements;
        const actionedContract = actionedContractMeasurements[a] as ContractMeasurements;

        if (
            actionedContract.address !== baseContract.address ||
            actionedContract.name !== baseContract.name ||
            actionedContract.contract !== baseContract.contract ||
            actionedContract.contractType !== baseContract.contractType
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
                contractType: actionedContract.contractType,
                measurements: deltas,
            });
    }
    return results;
};

const getDecimals = (unit: string | number | undefined): number => {
    if (typeof unit === 'string') {
        const baseValue = formatUnits(1n, unit);
        const decimalPlaces = baseValue.toString().split('.')[1]?.length || 0;
        return decimalPlaces;
    } else return unit || 0;
};

// only do doDecimals after formatting by unit, else there's no decimals!
const doFormat = (value: bigint, addPlus: boolean, unit?: number | string, decimals?: number): string => {
    const doUnit = (value: bigint): string => {
        return unit ? formatUnits(value, unit) : value.toString();
    };
    let result = doUnit(value);
    if (decimals !== undefined) {
        // it's been formatted, so round to that many decimals
        let decimalIndex = result.indexOf('.');
        // Calculate the number of decimal places 123.45 di=3,l=6,cd=2; 12345 di=-1,l=5,cd=0
        const currentDecimals = decimalIndex >= 0 ? result.length - decimalIndex - 1 : 0;
        if (currentDecimals > decimals) {
            if (result[result.length + decimals - currentDecimals] >= '5') {
                result = doUnit(value + 5n * 10n ** BigInt(getDecimals(unit) - decimals - 1));
            }
            // slice off the last digits, including the decimal point if its the last character (i.e. decimals == 0)
            result = result.slice(undefined, decimals - currentDecimals);
            // strip a trailing "."
            if (result[result.length - 1] === '.') result = result.slice(undefined, result.length - 1);
            // add back the zeros
            if (decimals < 0) result = result + '0'.repeat(-decimals);
        }
    }
    return (addPlus && value > 0 ? '+' : '') + result;
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
                            (!format.measurement || format.measurement === measurement.name) &&
                            (!format.contract || format.contract === newAddress.contract) &&
                            (!format.contractType || format.contractType === newAddress.contractType)
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
                    } else if (mergedFormat.unit !== undefined || mergedFormat.decimals !== undefined) {
                        let unformatted: any = {};
                        for (const fieldName of fieldNames) {
                            if (measurement[fieldName] !== undefined) {
                                let formatters: ((value: bigint) => bigint | string)[] = [];
                                formatters.push((value) =>
                                    doFormat(
                                        value,
                                        fieldName === 'delta',
                                        mergedFormat.unit as string | number,
                                        mergedFormat.decimals,
                                    ),
                                );

                                formatters.forEach((formatter) => {
                                    if (lodash.isArray(measurement[fieldName])) {
                                        unformatted[fieldName] = lodash.clone(measurement[fieldName]);
                                        measurement[fieldName] = measurement[fieldName].map((elem: any) =>
                                            formatter(elem),
                                        );
                                    } else {
                                        unformatted[fieldName] = measurement[fieldName];
                                        measurement[fieldName] = formatter(measurement[fieldName]);
                                    }
                                });
                            }
                        }
                        if (getConfig().show?.includes('format')) {
                            measurement.format = mergedFormat;
                            measurement.unformatted = unformatted;
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

type UnnamedVariableCalculator = AsyncIterableIterator<string>;
export type VariableCalculator = UnnamedVariableCalculator & { name: string };
const next = async (valuec?: VariableCalculator): Promise<Variable | undefined> => {
    if (valuec) {
        const nextResult = await valuec.next();
        if (!nextResult.done) {
            return { name: valuec.name, value: nextResult.value };
        }
    }
    return undefined;
};

export function* valuesStepped(start: number, finish: number, step: number = 1): Generator<string> {
    for (let i = start; (step > 0 && i <= finish) || (step < 0 && i >= finish); i += step) {
        yield i.toString();
    }
}

export function* valuesSingle(value: number): Generator<string> {
    yield value.toString();
}

export function* valuesArray(values: number[]): Generator<string> {
    for (const v of values) yield v.toString();
}

export const Values = async (
    name: string,
    generator: Generator<string>,
    doFunc: (value: string) => Promise<void>,
): Promise<VariableCalculator> => {
    const asyncIterator: UnnamedVariableCalculator = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
            while (true) {
                const value = await doNextValue();
                if (value.done) break;
                yield value.value;
            }
        },
        next: async (): Promise<IteratorResult<string>> => {
            return await doNextValue();
        },
    };

    const doNextValue = async (): Promise<IteratorResult<string>> => {
        const value = generator.next();
        if (value.done) {
            return { done: true, value: undefined };
        }
        await doFunc(value.value);
        return { done: false, value: value.value };
    };

    return Object.assign(asyncIterator, { name: name });
};

export const delve = async (valuec?: VariableCalculator): Promise<void> => {
    // This executes the configured actions one by one in the original set-up
    // and saves all the associated files

    let snapshot = await takeSnapshot(); // the state of the world before

    const value = await next(valuec);

    const variablePrefix = value ? `${value.name}=${value.value}.` : '';
    // if (value) console.log(`      ${variablePrefix}`);

    // TODO: make this a config
    const storeMeasurements: boolean = true;

    const baseMeasurements = await calculateMeasures();

    if (value) {
        baseMeasurements.unshift(value);
    }

    if (storeMeasurements) {
        writeYaml(`${variablePrefix}measures.yml`, baseMeasurements, formatFromConfig);
        writeYaml(
            `${variablePrefix}slim-measures.yml`,
            await calculateSlimMeasures(baseMeasurements),
            formatFromConfig,
        );
    }

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
        actionedMeasurements.unshift({
            name: actionName,
            user: configAction.user,
            contract: configAction.contract,
            function: configAction.function,
            args: JSON.stringify(configAction.args),
            error: error,
            gas: gas,
        });
        if (value) {
            actionedMeasurements.unshift(value);
        }
        const prefix = `${variablePrefix}${actionName}.`;

        if (storeMeasurements) {
            writeYaml(`${prefix}measures.yml`, actionedMeasurements, formatFromConfig);
            writeYaml(
                `${prefix}slim-measures.yml`,
                await calculateSlimMeasures(actionedMeasurements),
                formatFromConfig,
            );

            // difference the measures & write the results
            writeYaml(
                `${prefix}delta-measures.yml`,
                calculateDeltaMeasures(baseMeasurements!, actionedMeasurements),
                formatFromConfig,
            );
        }

        snapshot.restore();
    }
};

export const delvePlot = async (variable: VariableCalculator, dependents: MeasurementsMatch[]): Promise<void> => {
    let snapshot = await takeSnapshot(); // the state of the world before

    // let prevMeasurements: Measurements = null; // for doing  diff
    // generate a gnuplot data file and a command
    let names = [
        variable.name,
        ...dependents.flatMap((match) => match.functions.map((func) => `${match.contract}.${func}`)),
    ];
    let data: string[] = [];

    for await (const value of variable) {
        // get the dependents
        // TODO: only get the ones needed (passed in as a parameter for this function)
        const measurements = await calculateMeasures(dependents);
        data.push(
            [
                value,
                ...measurements.map((cm) =>
                    formatFromConfig(cm)
                        .measurements.map((m: any) => m.value || m.error)
                        .join(' '),
                ),
            ].join(' '),
        );

        snapshot.restore();
    }
    writeEatFile('gnuplot.dat', ['# ' + names.join(' '), ...data].join('\n'));
    // first data item is a plot, rest are replots.
    // TODO: need to decide what axis each is plotted against, or work it out automatically, high v low variance

    // generate the script
    const script = `datafile = "${eatFileName('gnuplot.dat')}"
# set terminal pngcairo
# set output "${eatFileName('gnuplot.png')}"
set terminal svg
# set output "${eatFileName('gnuplot.png')}"
set xlabel "${variable.name}"
set ylabel "${names[1]}" # TODO: this should be the units, not the name
set ytics nomirror
set y2label "${names[2]}"
set y2tics

#stats datafile using 1 nooutput
#min = STATS_min
#max = STATS_max
#range_extension = 0.2 * (max - min)
#set xrange [min - range_extension : max + range_extension]

#stats datafile using 2 nooutput
#min = STATS_min
#max = STATS_max
#range_extension = 0.2 * (max - min)
#set yrange [min - range_extension : max + range_extension]

#stats datafile using 3 nooutput
#min = STATS_min
#max = STATS_max
#range_extension = 0.2 * (max - min)
#set y2range [min - range_extension : max + range_extension]

plot datafile using 1:2 with lines title "${names[1]}",\
     datafile using 1:3 with lines title "${names[2]}" axes x1y2
`;

    writeEatFile('gnuplot-script.gp', script);
};
