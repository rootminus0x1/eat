import {
    contracts,
    measures,
    measuresOnAddress,
    nodes,
    users,
    parseArg,
    MeasurementResult,
    MeasurementValue,
} from './graph';
import { MaxInt256, formatEther, formatUnits, parseEther } from 'ethers';
import { ConfigFormatApply, eatFileName, getConfig, writeEatFile, writeYaml } from './config';
import lodash from 'lodash';
import { takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { asDateString } from './datetime';

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

export type Measurement = {
    name: string;
    type: string;
    target?: string;
    // value can hold a value or a delta value for comparisons
    delta?: MeasurementResult;
    value?: MeasurementResult;
    valueName?: string | string[]; // if value is an address
    // error can hold an error, a change in error message or indicate a change from a value to/from an error
    error?: string;
};

// user events
type UserEvent = {
    name: string;
    user: string;
    contract: string;
    function: string;
    args: (string | bigint)[];
};
type UserEventResult = {
    name: string;
    user: string;
    contract: string;
    function: string;
    args: (string | bigint)[];
} & Partial<{ error: string }> &
    Partial<{ gas: bigint }>;

export const doEvent = async (event: any, ...args: any[]) => {
    // what type of event
    if (event.setMarket) {
        // it's a market event
        const result = await event.setMarket(...(args.length ? args : [event.value])); // default to the given value(s)
        return {
            name: `${event.name}${
                result === undefined ? '' : '=' + (typeof result === 'bigint' ? formatEther(result) : result.toString())
            }`,
            precision: event.precision,
            value: result,
        };
    }
    if (
        event.user !== undefined &&
        event.contract !== undefined &&
        event.function !== undefined &&
        event.args !== undefined
    ) {
        const result: UserEventResult = event;
        try {
            // TODO: hadle the args input (to substitute values, maybe)
            const args = event.args.map((a: any) => parseArg(a));
            const tx = await contracts[event.contract].connect(users[event.user])[event.function](...args);
            // TODO: get the returned values out
            // would be nice to capture any log events emitted too :-) see expect.to.emit
            const receipt = await tx.wait();
            result.gas = receipt ? receipt.gasUsed : MaxInt256;
        } catch (e: any) {
            result.error = e.message; // failure
        }
        return result;
    }
    throw `event ${event.name} not run: unknown type of event`;
};

// market events
export type MarketEventType = {
    name: string;
    precision?: number;
    setMarket: (value: any) => Promise<any>;
};
type MarketEvent = MarketEventType & {
    value: bigint;
};
type MarketEventResult = {
    name: string;
    precision?: number;
    value: bigint;
};

type Event = Partial<UserEvent> & Partial<MarketEvent>;
type EventResult = Partial<UserEventResult> & Partial<MarketEventResult>;

export function marketEvents(type: MarketEventType, start: bigint, finish: bigint, step: bigint = 1n): MarketEvent[] {
    const result: MarketEvent[] = [];
    for (let i = start; (step > 0 && i <= finish) || (step < 0 && i >= finish); i += step) {
        result.push(Object.assign({ value: i }, type));
    }
    return result;
}

export function marketEvent(type: MarketEventType, value: bigint): MarketEvent {
    return Object.assign({ value: value }, type);
}

export type ContractMeasurements = {
    address: string;
    name: string; // node name - this is the contract
    contractType: string; // contract nameish
    measurements: Measurement[];
};

export type Measurements = (Partial<Event> & Partial<ContractMeasurements>)[];

////////////////////////////////////////////////////////////////////////
// calculateMeasures

export type MeasurementsMatch = {
    contract: string;
    function: string;
};

export const calculateMeasures = async (filter?: MeasurementsMatch[]): Promise<Measurements> => {
    const result: Measurements = [];
    let count = 0;

    for (const [address, node] of nodes) {
        // collapse the duplicate contract matches, into a single
        let contractFilter = null;
        if (filter) {
            contractFilter = filter.reduce((functions, match) => {
                if (match.contract === node.name) {
                    functions.add(match.function);
                }
                return functions;
            }, new Set<string>());
            if (contractFilter.size == 0) continue; // nothing to do for this contract
        }
        //console.log(`measuring node ${node.name}`);
        let values: Measurement[] = []; // values for this graph node
        const measuresForAddress = measures.get(address);
        if (measuresForAddress && measuresForAddress.length > 0) {
            // only do measurments for addresses with a name (they're users otherwise)
            for (const measure of measuresForAddress.filter((m) => m.name)) {
                // skip if there is a filter and it is not in the filter
                if (contractFilter && !contractFilter.has(measure.name)) {
                    continue;
                }
                const result: Measurement = { name: measure.name, type: measure.type };
                try {
                    result.value = await measure.calculation();
                    if (result.type === 'address') {
                        result.valueName = nodes.get(result.value.toString())?.name;
                    }
                    if (result.type === 'address[]') {
                        let anyNames = false;
                        result.valueName = (result.value as MeasurementValue[]).map((v) => {
                            let lookup: string | undefined = nodes.get(v.toString())?.name;
                            if (lookup) {
                                anyNames = true;
                            } else {
                                lookup = v.toString();
                            }
                            return lookup;
                        });
                        if (!anyNames) result.valueName = undefined; // don't just repeat the addresses
                    }
                } catch (e: any) {
                    result.error = e.message;
                }
                values.push(result);
            }
        }
        if (!filter) {
            // can's currently filter on specific addresses (and maybe we will never need that)
            // TODO: add the ability to filter in measures on address - need to pass in the addresses
            const measuresOnAddressForAddress = measuresOnAddress.get(address);
            if (measuresOnAddressForAddress && measuresOnAddressForAddress.length > 0) {
                for (const [targetAddress, targetNode] of nodes) {
                    if (targetAddress === address) continue; // skip self
                    for (const measure of measuresOnAddressForAddress) {
                        const m: Measurement = {
                            name: measure.name,
                            type: measure.type,
                            target: targetNode.name, // use the node name as user addresses may change run-to-run
                        };
                        try {
                            m.value = await measure.calculation(targetAddress);
                        } catch (e: any) {
                            m.error = e.message;
                        }
                        values.push(m);
                    }
                }
            }
        }
        // TODO: only save contract where it has measures?
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
// calculateSlimMeasures
export const calculateSlimMeasures = async (baseMeasurements: Measurements): Promise<Measurements> => {
    const result: Measurements = [];

    for (const contract of baseMeasurements.filter((m) => m.measurements)) {
        const nonZero = (contract as ContractMeasurements).measurements.filter((measure) => {
            if (measure.value !== undefined) {
                if (lodash.isArray(measure.value)) {
                    // non-empty array is counted as non-zero (who would return an array filled with zeros?)
                    return measure.value.length > 0;
                } else {
                    // non-zero now depends on the type
                    if (measure.type === 'address') {
                        return (measure.value as string) !== '0x0000000000000000000000000000000000000000';
                    } else {
                        return (measure.value as bigint) !== 0n;
                    }
                }
            } else {
                return measure.error ? true : false;
            }
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
                // TODO: handle address comparisons
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

const doFormat = (value: bigint, addPlus: boolean, unit?: number | string, precision?: number): string => {
    const doUnit = (value: bigint): string => {
        return unit ? formatUnits(value, unit) : value.toString();
    };
    let result = doUnit(value);
    if (precision !== undefined) {
        // it's been formatted, so round to that precision
        let decimalIndex = result.indexOf('.');
        // Calculate the number of decimal places 123.45 di=3,l=6,cd=2; 12345 di=-1,l=5,cd=0
        const currentDecimals = decimalIndex >= 0 ? result.length - decimalIndex - 1 : 0;
        if (currentDecimals > precision) {
            if (result[result.length + precision - currentDecimals] >= '5') {
                result = doUnit(value + 5n * 10n ** BigInt(getDecimals(unit) - precision - 1));
            }
            // slice off the last digits, including the decimal point if its the last character (i.e. precision == 0)
            result = result.slice(undefined, precision - currentDecimals);
            // strip a trailing "."
            if (result[result.length - 1] === '.') result = result.slice(undefined, result.length - 1);
            // add back the zeros
            if (precision < 0) result = result + '0'.repeat(-precision);
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
                        // TODO: make addresses, map on to contracts or users, not just for target fields
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
                            if (format.unit === undefined && format.precision === undefined) {
                                donotformat = true;
                                break; // got a no format request
                            }

                            if (format.unit !== undefined && mergedFormat.unit === undefined)
                                mergedFormat.unit = format.unit;
                            if (format.precision !== undefined && mergedFormat.precision === undefined)
                                mergedFormat.precision = format.precision;

                            if (mergedFormat.unit !== undefined && mergedFormat.precision !== undefined) break; // got enough
                        }
                    }
                    if (donotformat) {
                        if (getConfig().show?.includes('format')) {
                            measurement.format = {};
                        }
                    } else if (mergedFormat.unit !== undefined || mergedFormat.precision !== undefined) {
                        let unformatted: any = {};
                        for (const fieldName of fieldNames) {
                            if (measurement[fieldName] !== undefined) {
                                let formatters: ((value: bigint) => bigint | string)[] = [];
                                formatters.push((value) =>
                                    doFormat(
                                        value,
                                        fieldName === 'delta',
                                        mergedFormat.unit as string | number,
                                        mergedFormat.precision,
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
/*
type UnnamedVariableCalculator = AsyncIterableIterator<bigint>;
export type VariableCalculator = UnnamedVariableCalculator & { name: string; precision: number };
const next = async (valuec?: VariableCalculator): Promise<Variable | undefined> => {
    if (valuec) {
        const nextResult = await valuec.next();
        if (!nextResult.done) {
            return { name: valuec.name, value: doFormat(nextResult.value, false, 'ether', valuec.precision) };
        }
    }
    return undefined;
};
export type VariableSetter = (value: bigint) => Promise<void>;

export function* valuesStepped(start: bigint, finish: bigint, step: bigint = 1n): Generator<bigint> {
    for (let i = start; (step > 0 && i <= finish) || (step < 0 && i >= finish); i += step) {
        yield i;
    }
}

export function* valuesSingle(value: bigint): Generator<bigint> {
    yield value;
}

export function* valuesArray(values: bigint[]): Generator<bigint> {
    for (const v of values) yield v;
}

export const Values = async (
    name: string,
    precision: number,
    generator: Generator<bigint>,
    doFunc: VariableSetter,
): Promise<VariableCalculator> => {
    const asyncIterator: UnnamedVariableCalculator = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<bigint> {
            while (true) {
                const value = await doNextValue();
                if (value.done) break;
                yield value.value;
            }
        },
        next: async (): Promise<IteratorResult<bigint>> => {
            return await doNextValue();
        },
    };

    const doNextValue = async (): Promise<IteratorResult<bigint>> => {
        const value = generator.next();
        if (value.done) {
            return { done: true, value: undefined };
        }
        await doFunc(value.value);
        return { done: false, value: value.value };
    };

    return Object.assign(asyncIterator, { name: name, precision: precision });
};
*/

export const inverse = async (
    y: bigint,
    yGetter: () => Promise<bigint>,
    xSetter: (value: bigint) => Promise<void>,
    xLowerBound: bigint,
    xUpperBound: bigint,
    xTolerance: bigint = 1n,
): Promise<bigint | undefined> => {
    const f = async (x: bigint) => {
        await xSetter(x);
        return yGetter();
    };

    // Ensure that y is within the range of the function
    if ((await f(xLowerBound)) > y || (await f(xUpperBound)) < y) {
        return undefined;
    }

    while (xUpperBound - xLowerBound > xTolerance) {
        const midPoint = (xLowerBound + xUpperBound) / 2n;
        const midValue = await f(midPoint);

        if (midValue < y) {
            xLowerBound = midPoint;
        } else {
            xUpperBound = midPoint;
        }
    }
    // Return the midpoint as an approximation of the inverse
    return (xLowerBound + xUpperBound) / 2n;
};

const Events = async (events: Event[]): Promise<AsyncIterableIterator<EventResult>> => {
    const asyncIterator: AsyncIterableIterator<EventResult> = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<EventResult> {
            while (true) {
                const value = await doNextValue();
                if (value.done) break;
                yield value.value;
            }
        },
        next: async (): Promise<IteratorResult<EventResult>> => {
            return await doNextValue();
        },
    };

    let nextEvent = 0;
    const doNextValue = async (): Promise<IteratorResult<EventResult>> => {
        // get the event from the list
        if (nextEvent >= events.length) {
            return { value: undefined, done: true };
        } else {
            const event = events[nextEvent++];
            const result = await doEvent(event);
            return {
                value: result,
                done: false,
            };
        }
    };
    return asyncIterator;
};

/*  two ways of running a sequence of events:
    simulation:
        here the events are run one after the other, with no resetting.
        files generated are:
            base
            after event0 & delta to base
            after event(0 & 1) & delta to event0
            :
    individual
        here the events are run one after the other but resetting the blockchain after each one
        files generated are
            base
            after event0 & delta to base
            after event1 & delta to base
            :
        this is similar (but not identical because base need only be generated once) to a series of simulations with a single event
*/

const writeMeasures = (name: string[], measurements: Measurements, type?: string) => {
    const fullName = [...name, (type && type.length ? type + '-' : '') + 'measures.yml'];
    writeYaml(fullName.join('.'), measurements, formatFromConfig);
};

const delveSimulation = async (stack: string, simulation: Event[] = [], context?: Event): Promise<void> => {
    // This executes the given events one by one in order
    // and saves all the associated files
    const fileprefix = context && context.name && context.name.length ? [context.name] : [];

    const width = simulation.length > 0 ? (simulation.length - 1).toString().length : 0;

    const baseMeasurements = await calculateMeasures();
    if (context) baseMeasurements.unshift(context);

    const index = width ? ['-'.padStart(width, '-')] : [];
    // TODO: roll all file saving into a single place
    const baseFileName = [...fileprefix, ...index, ...(width ? ['base'] : [])];
    writeMeasures(baseFileName, baseMeasurements);
    writeMeasures(baseFileName, await calculateSlimMeasures(baseMeasurements), 'slim');

    let i = 0;
    for await (const event of await Events(simulation)) {
        // the event has happened

        // do the post userEvent measures
        const postMeasurements = await calculateMeasures();
        const filename = [...fileprefix, i.toString().padStart(width, '0'), event.name!];
        // TODO: make sure the event info is in the file, slim & delta file
        postMeasurements.unshift(event);
        if (context) baseMeasurements.unshift(context);

        writeMeasures(filename, postMeasurements);
        writeMeasures(filename, await calculateSlimMeasures(postMeasurements), 'slim');

        // do the delta - should deltas have the original value as well as the delta?
        const deltaMeasurements = calculateDeltaMeasures(baseMeasurements, postMeasurements);
        writeMeasures(filename, deltaMeasurements, 'delta');

        i++;
    }
};

// do each event and after it, do each simulation then reset the blockchain before the next event
export const delve = async (stack: string, events: Event[] = [], simulation: Event[] = []): Promise<void> => {
    console.log(`delving(${stack})...`);
    if (events.length == 0) {
        await delveSimulation(stack, simulation);
    } else {
        const snapshot = await takeSnapshot(); // the state of the world before
        // do each event
        for await (const event of await Events(events)) {
            // the event is done
            // TODO: not just a string, but the value to be unshifted into measures before saving
            await delveSimulation(stack, simulation, event);
            await snapshot!.restore();
        }
    }
    console.log(`delving(${stack})...done.`);
};

type SimulationThenMeasurement = {
    simulation?: Event[]; // do these
    calculations: {
        // then measure these
        match: MeasurementsMatch;
        lineStyle?: string; // drawing them this way
        y2axis?: boolean;
    }[];
};

export const delvePlot = async (
    name: string, // TODO: generate this
    xlabel: string,
    independent: Event[],
    ylabel: string | string[],
    dependents: SimulationThenMeasurement[],
): Promise<void> => {
    const scriptfilename = `${name}.gnuplot.gp`;
    const datafilename = `${name}.gnuplot.dat`;
    const datafilepath = `${eatFileName(datafilename)}`;
    const svgfilename = `${name}.gnuplot.svg`;
    const svgfilepath = `${eatFileName(svgfilename)}`;
    const pngfilename = `${name}.gnuplot.png`;
    const pngfilepath = `${eatFileName(pngfilename)}`;
    console.log(`delve plotting ${name}...`);
    // let prevMeasurements: Measurements = null; // for doing  diff
    // generate a gnuplot data file and a command
    const eventName = [...independent.reduce((names, event) => names.add(event.name!), new Set<string>())].join('-');
    const fields: string[] = [];
    const plots: string[] = [];
    let index = 0;
    for (const dependent of dependents) {
        for (const calculation of dependent.calculations) {
            const field = `${calculation.match.contract}.${calculation.match.function}${
                dependent.simulation ? '>' + dependent.simulation.map((event) => event.name).join('+') : ''
            }`;
            fields.push(field);
            plots.push(
                `datafile using 1:${index + 2} with lines ${
                    calculation.lineStyle ? calculation.lineStyle : ''
                } title "${field}" ${calculation.y2axis ? 'axes x1y2' : ''}`,
            );
        }
        index++;
    }

    // headers and data container
    let names = [eventName, ...fields];
    let data: string[] = [];

    // automatically plot the x-axis in the right order (gnuplot always does it ascending)
    let reverse = false;
    let prevValue = undefined;
    // for each x axis value
    for await (const event of await Events(independent)) {
        console.log(`   ${event.name}`);

        // calculate each measure under each simulation
        const measurements: Measurements = [];
        for (const dependent of dependents) {
            // for each measurement, run the simulation
            const snapshot = await takeSnapshot();
            if (dependent.simulation)
                for await (const sim of await Events(dependent.simulation)) {
                    console.log(`         ${sim.name}`);
                }
            // get the dependent value
            measurements.push(
                ...(await calculateMeasures([...dependent.calculations.map((calculation) => calculation.match)])),
            );
            await snapshot.restore();
        }
        if (!event.value) throw 'events on the x axis have to return a value';
        if (prevValue !== undefined) {
            reverse = event.value < prevValue;
        } else {
            prevValue = event.value;
        }
        const value = event.value;
        data.push(
            [
                formatEther(event.value),
                ...measurements.map((cm) =>
                    formatFromConfig(cm)
                        .measurements.map((m: any) => m.value || '*') // TODO: handle errors - error file?
                        .join(' '),
                ),
            ].join(' '),
        );
    }
    writeEatFile(datafilename, ['# ' + names.join(' '), ...data].join('\n'));

    let script = [
        `datafile = "${datafilepath}"`,
        `# set terminal pngcairo`,
        `# set output "${pngfilepath}`,
        `set terminal svg`,
        `# set output "${svgfilepath}`,
        `set xlabel "${xlabel}`,
        `set colorsequence podo`,
    ];

    if (Array.isArray(ylabel)) {
        if (ylabel.length > 0) {
            script.push(`set ylabel "${ylabel[0]}"`, `set y2label "${ylabel[1]}"`, `set y2tics`, `set ytics nomirror`);
        } else {
            script.push(`set ylabel "${ylabel[0]}"`);
        }
    } else {
        script.push(`set ylabel "${ylabel}"`);
    }
    if (reverse) {
        script.push(`set xrange reverse`);
    }
    /*
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
*/
    script.push(`plot ${plots.join(',\\\n     ')}`);
    writeEatFile(scriptfilename, script.join('\n'));
    console.log('delve plotting...done.');
};
