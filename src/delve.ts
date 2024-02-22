import * as crypto from 'crypto-js';

import { contracts, readers, nodes, users, GraphNode } from './graph';
import { MaxInt256, formatEther, formatUnits } from 'ethers';
import {
    ConfigFormatApply,
    eatFileName,
    formatArg,
    getConfig,
    getDecimals,
    parseArg,
    stringCompare,
    writeEatFile,
} from './config';
import lodash, { forEach, isNumber } from 'lodash';
import { takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { withLogging, Logger, log, erase } from './logging';

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

export type ContractInfo = {
    identifier: string;
    contract: string;
    address: string; // this is the only place an address should be, everywhere else it's the contract identifier, which might be an address
};

export type ReadingType = bigint | string | boolean;
export type ReadingValue = ReadingType | ReadingType[];

export type Reader = {
    address: string; // the address of the contract
    contract: string;
    function: string;
    field?: {
        name: string; // for multiple outputs, arrays are not multiple outputs, name is for user extraction
        index: number;
    }; // the output index of the field (for generic extraction)
    argTypes: string[]; // types or the args
    type: string; // solidity type of result, you know how to extract the resulta
    read: (...args: any[]) => Promise<any>;
    formatting?: ConfigFormatApply;
};

export const makeReader = (address: string, fn: string, field?: string): Reader => {
    const forContract = readers.get(address);
    if (forContract) {
        const reader = forContract.filter((r: Reader) => {
            if (r.function !== fn) return false; // mismatched function name
            if (r.field === undefined && field === undefined) return true; // neither has a field, so matched
            // both must have fields
            if (r.field === undefined || field === undefined) return false; // mismatched field existence
            // if we get here, both have fields
            return field === r.field.name || field === r.field.index.toString(); // allow field to have a numeric value
        });
        if (reader.length === 1) return reader[0];
        if (reader.length > 1)
            throw Error('when making a Reader, more than one match was found - maybe need to define a field?');
        if (reader.length === 0) throw Error('when making a Reader, none was found');
    }
    throw Error('when making a Reader, none was found at the address given');
};

export type ReadingBasic = {
    value?: ReadingValue; // if it's an address or array of addresses they are translated into contract names
    // error can hold an error, a change in error message or indicate a change from a value to/from an error
    error?: string;
};

export type Reading = ReadingBasic & {
    reading: string; //name of the reading
    contract: string; // type of the contract
    function: string;
    field?: string;
    argTypes: string[];
    args: any[];
    type: string;
    contractInstance: string;
    address: string; // address of the contract
    // value can hold a value or a delta value for comparisons
    delta?: ReadingBasic;
    formatting?: ConfigFormatApply;
};

export const callReaderBasic = async (reader: Reader, ...args: any[]): Promise<ReadingBasic> => {
    let value: ReadingValue | undefined;
    let error: string | undefined;
    try {
        let result = await reader.read(...args);
        if (reader.field) {
            value = result[reader.field.index];
        } else {
            value = result;
        }
        // TODO: maybe do the below
        /*
        if (reader.type.endsWith('[]')) {
            if (reader.type.startsWith('address')) {
                result = result.map((a: string) => a);
            } else {
                // translate numbers to bigint
                result = result.map((n: bigint) => n);
            }
        }
        */
    } catch (e: any) {
        error = e.message;
    }
    return {
        value: value,
        error: error,
    };
};

export const addressToName = (address: string): string => nodes.get(address)?.name || address;

export const callToName = (reader: Reader, args?: any[]) => {
    let result = reader.function;
    if (args?.length) result += `(${args})`;
    const field = reader.field?.name || reader.field?.index.toString(); // if there's no name, use the index in the name
    if (field) result += `.${field}`;
    return result;
};

export const callReader = async (reader: Reader, ...friendlyArgs: any[]): Promise<Reading> => {
    const basic = await callReaderBasic(reader, ...friendlyArgs.map((a: any) => parseArg(a)));
    if (basic.value !== undefined) {
        if (reader.type.endsWith('[]')) {
            basic.value = (basic.value as ReadingType[]).map((v) => formatArg(v));
        } else {
            basic.value = formatArg(basic.value as ReadingType);
        }
    }
    return Object.assign(
        {
            reading: `${addressToName(reader.address)}.${callToName(
                reader, //
                friendlyArgs.map((a: any) => formatArg(a)),
            )}`,
            contractInstance: addressToName(reader.address),
            contract: reader.contract,
            function: reader.function,
            field: reader.field?.name || reader.field?.index.toString(),
            address: reader.address,
            argTypes: reader.argTypes,
            args: friendlyArgs,
            type: reader.type,
            formatting: reader.formatting,
        },
        basic,
    );
};

export const doReading = async (address: string, fn: string, field?: string, ...args: any[]): Promise<Reading> => {
    const reader = makeReader(address, fn, field);
    return await callReader(reader, ...args);
};

// user events
export type Trigger = {
    name: string; // useful name given that summarises the below (TODO: could make this a function?)
    //user: string;
    //contract: string;
    //function: string;
    args?: (string | bigint)[]; // this replaces args below
    pull: (...args: any[]) => Promise<any>; // async fuction that executes (pulls) the trigger to make the effect
    // TODO: add list of events that can be parsed for results, for this contract
};
export type TriggerOutcome = {
    trigger: Trigger;
} & Partial<{ error: string }> &
    Partial<{ gas?: bigint; events: any }>;

export const doTrigger = async (trigger: Trigger, ...overrideArgs: any[]): Promise<TriggerOutcome> => {
    let gas: bigint | undefined;
    // let events;
    let error: string | undefined;
    try {
        const args = (overrideArgs || trigger.args)?.map((a: any) => parseArg(a));
        const tx = await trigger.pull(...args);
        // TODO: generate user functions elsewhere
        // const tx = await contracts[event.contract].connect(users[event.user])[event.function](...args);
        // TODO: get the returned values out
        // would be nice to capture any log events emitted too :-) see expect.to.emit
        const receipt = await tx.wait();
        gas = receipt?.gasUsed;
        // TODO: parse the results into events, etc
    } catch (e: any) {
        error = e.message;
    }
    return {
        trigger: trigger,
        error: error,
        gas: gas,
    };
};

// generate multiple triggers based on some sequance generator

export function makeTrigger(base: Trigger, ...args: any[]): Trigger {
    return Object.assign({}, base, { args: args }); // override the args
}

export function makeTriggers(base: Trigger, start: bigint, finish: bigint, step: bigint = 1n): Trigger[] {
    const result: Trigger[] = [];
    for (let i = start; (step > 0 && i <= finish) || (step < 0 && i >= finish); i += step) {
        result.push(makeTrigger(base, i));
    }
    return result;
}

export type Experiment = {
    simulation: TriggerOutcome[];
    readings: Reading[];
};

////////////////////////////////////////////////////////////////////////
// doReadings

const compareReadingKeys = (a: Reading, b: Reading) =>
    stringCompare(a.contractInstance, b.contractInstance) || stringCompare(a.reading, b.reading);

const sortReadings = (r: Reading[]): Reading[] => r.sort(compareReadingKeys);

export const doReadings = async (): Promise<Reading[]> => {
    const result: Reading[] = [];
    for (const [address, readerList] of readers) {
        //const logger = new Logger(`reading: ${addressToName(address)}`);
        for (const reader of readerList) {
            if (reader.argTypes && reader.argTypes.length == 1 && reader.argTypes[0] === 'address') {
                // nodes are already sorted by name
                for (const [target, node] of nodes) {
                    if (target !== address) result.push(await callReader(reader, target));
                }
            } else {
                result.push(await callReader(reader));
            }
        }
        //logger.finish();
    }

    // make sure Readings are always sorted, regardless of Reader/Node order
    // use the reading field as it rolls up function name, arguments and fields
    return sortReadings(result);
};
/*
////////////////////////////////////////////////////////////////////////
// calculateSlimMeasures
export const calculateSlimMeasures = async (baseMeasurements: Measurements): Promise<Measurements> => {
    const result: Measurements = [];

    for (const contract of baseMeasurements.filter((m) => m.readings)) {
        const nonZero = (contract as ContractMeasurements).readings.filter((reading) => {
            if (reading.value !== undefined) {
                if (lodash.isArray(reading.value)) {
                    // non-empty array is counted as non-zero (who would return an array filled with zeros?)
                    return reading.value.length > 0;
                } else {
                    // non-zero now depends on the type
                    if (reading.type === 'address') {
                        return (reading.value as string) !== '0x0000000000000000000000000000000000000000';
                    } else {
                        return (reading.value as bigint) !== 0n;
                    }
                }
            } else {
                return reading.error ? true : false;
            }
        });
        if (nonZero.length > 0) {
            // copy top level stuff
            const resultContract = lodash.clone(contract);
            resultContract.readings = nonZero; // replace readings
            result.push(resultContract);
        }
    }
    return result;
};
*/
////////////////////////////////////////////////////////////////////////
// diff Readings
const _readingsDeltas = (readings: Reading[], baseReadings: Reading[]): Reading[] => {
    const deltas: Reading[] = [];
    let a = 0,
        b = 0;
    while (a < readings.length && b < baseReadings.length) {
        const reading = readings[a];
        const base = baseReadings[b];
        const cmp = compareReadingKeys(reading, base);
        if (cmp < 0) {
            // log(`${reading.reading} only in new - keeping`);
            deltas.push(reading); // a new reading, not in base
            a++;
        } else if (cmp > 0) {
            // log(`${base.reading} only in base - discarding`);
            // ignore these - they are not in the new reading, only in base, so not that interesting
            // deltas.push(base); // a missing reading, only in base
            b++;
        } else {
            a++;
            b++;
            let delta: ReadingBasic = {};
            // check the errors first
            if (reading.error === undefined && base.error !== undefined)
                delta.error = `"${base.error}" -> ${reading.error}`;
            if (reading.error !== undefined && base.error === undefined)
                delta.error = `${base.error} -> "${reading.error}"`;
            if (reading.error !== base.error) delta.error = `"${base.error}" -> "${reading.error}"`;

            // now check the values that are the same type (by definition) but may be arrays or scalars
            const scalarDelta = (type: string, a: ReadingType, b: ReadingType): ReadingType => {
                let result: any = undefined;
                if (a !== b) {
                    if (a !== undefined && b !== undefined) {
                        if (type.includes('int')) {
                            result = (b as bigint) - (a as bigint);
                            // take into account any formatting, units and precision
                            if (reading.formatting?.precision != undefined) {
                                const decimals = getDecimals(reading.formatting.unit); // e.g. 16, 18 or 0
                                const precision = reading.formatting.precision || 0; // e.g. 0, 1 or -1
                                // * 10 ** (16, 17, 1)
                                // log(
                                //     ` result=${result} after decimals=${decimals}, precision=${precision}, result=${
                                //         result * 10 ** (precision - decimals)
                                //     }`,
                                // );
                                if (result * 10 ** (precision - decimals) <= 0.0) {
                                    result = undefined;
                                }
                            }
                        } else if (type === 'bool') result = a; // changed from !reading.value to reading.value
                        else if (type === 'string' || type.startsWith('address') || type.startsWith('bytes'))
                            result = `"${base.value}" -> "${reading.value}}"`;
                        else throw Error(`unsupported reading type in deltas: ${reading.type}`);
                    }
                }
                return result;
            };

            if (reading.value === undefined && base.value !== undefined)
                delta.value = `[${base.value.toString()}] -> ${reading.value}`;
            if (reading.value !== undefined && base.value === undefined)
                delta.value = `${base.value} -> [${reading.value.toString()}]`;

            // like for like comparison
            if (reading.value !== undefined && base.value !== undefined) {
                if (reading.type.endsWith('[]')) {
                    // do array comparison
                    const readingA = reading.value as ReadingType[];
                    const baseA = base.value as ReadingType[];
                    if (readingA.length === baseA.length) {
                        const proposed = readingA.map((readingAi, i) =>
                            scalarDelta(reading.type.replace('[]', ''), readingAi, baseA[i]),
                        );
                        const defined = proposed.reduce((count, v) => (v !== undefined ? count + 1 : count), 0);
                        delta.value = defined > 0 ? proposed : undefined;
                    } else {
                        delta.value = `${baseA.length}:[${baseA.toString()}] -> ${
                            readingA.length
                        }[${readingA.toString()}]`;
                    }
                } else {
                    // do scalar comparison
                    log(reading.reading, false);
                    delta.value = scalarDelta(reading.type, reading.value as ReadingType, base.value as ReadingType);
                    erase();
                }
            }

            if (delta.value !== undefined || delta.error !== undefined)
                deltas.push(Object.assign({ delta: delta }, reading));
        }
    }
    // add anything left over as more readings
    while (a < readings.length) deltas.push(readings[a++]); // a new reading, not in base
    // while (b < baseReadings.length) deltas.push(baseReadings[b++]); // a missing reading, only in base
    return sortReadings(deltas);
};

export const readingsDeltas = withLogging(_readingsDeltas);

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
/*
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
*/

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

/*
export const writeReadings = (name: string[], simulation: TriggerOutcome[], readings: Reading[], type?: string) => {
    const fullName = [...name, (type && type.length ? type + '-' : '') + 'readers.yml'];
    //writeYaml(fullName.join('.'), readings, formatFromConfig);
};
*/
/*
const delveSimulation = async (stack: string, simulation: Trigger[] = [], context?: Trigger): Promise<void> => {
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

        // do the post userEvent readers
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
*/
// do each event and after it, do each simulation then reset the blockchain before the next event
const _delve = async (stack: string, simulation: Trigger[] = []): Promise<[Reading[], TriggerOutcome[]]> => {
    const outcomes: TriggerOutcome[] = [];
    // do each event
    /*    for (const trigger of simulation) {
        outcomes.push(await doTrigger(trigger));
        // TODO: not just a string, but the value to be unshifted into readers before saving
        await delveSimulation(stack, simulation, event);
    }
*/
    const readings = await doReadings();
    return [readings, outcomes];
};

export const delve = withLogging(_delve);

/*
type Simulation = Event[];

type SimulationThenMeasurement = {
    simulation?: Simulation; // do these
    calculations: {
        // then reading these
        match: MeasurementsMatch;
        lineStyle?: string; // drawing them this way
        y2axis?: boolean;
    }[];
};

const formatForCSV = (value: string): string =>
    // If the value contains a comma, newline, or double quote, enclose it in double quotes
    /[,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

class ErrorFormatter {
    private runErrorsMap = new Map<string, string>(); // map of error message to error hash string, stored in file .errors.csv

    public errorMap = (): string[] => {
        return Array.from(this.runErrorsMap, ([key, value]) => `${value},${key}`);
    };

    public formatError = (e: any): string => {
        let message = e || 'undefined error';
        let code = this.runErrorsMap.get(message); // have we encountered this error text before?
        if (code === undefined) {
            // first time this message has occurred - generate the code
            const patterns: [RegExp, (match: string) => string][] = [
                // specific messages
                [/^(contract runner does not support sending transactions)/, (match) => match[1]],
                // specific messages with extra info
                [/^(.+)\s\(.+"method":\s"([^"]+)"/, (match) => match[1] + ': ' + match[2]], // method in quotes
                // more generic messages
                [/'([^']+)'$/, (match) => match[1]], // message in quotes
                [/\s*([^:(]*)(?:\s*\([^)]*\))?:?([^:(]*)$/, (match) => match[1] + match[2]], // message after last ':' unless its within ()
                // [/:\s*([^:]+)$/, (match) => match[1]], // message after last ':'
            ];
            for (const [pattern, processor] of patterns) {
                const matches = message.match(pattern);
                if (matches) {
                    code = processor(matches);
                    break;
                }
            }
            if (code === undefined) {
                //const hash = createHash("sha256").update(message).digest("base64");
                code = crypto.SHA3(message, { outputLength: 32 }).toString(crypto.enc.Base64);
            }
            // TODO: ensure the code/message combination is unique
            this.runErrorsMap.set(message, code);
        }
        return code;
    };
}

const formatEventResult = (ef: ErrorFormatter, event: EventResult): string => {
    // there is
    // 1. the requested value,
    // 2. whether the event happened: error, or callResult
    // eventDisplay is, on success:
    //      even.name=event.value (the requested value)
    // on failure
    //      event.name!=event.value!format(event.error)
    let eventDisplay = event.name || 'no event name!';
    if (event.error !== undefined) {
        if (event.value !== undefined) eventDisplay += `!=${formatEther(event.value)}`;
        eventDisplay += `!!${ef.formatError(event.error)}`;
    } else {
        const parsedResult =
            typeof event.callResult === 'bigint'
                ? formatEther(event.callResult)
                : typeof event.callResult === 'object'
                ? JSON.stringify(event.callResult)
                : event.callResult.toString();
        eventDisplay += '=' + parsedResult;
    }
    return eventDisplay;
};

export const delvePlot = async (
    name: string, // TODO: generate this
    xlabel: string,
    independent: Event[],
    ylabel: string | [string, string],
    dependents: SimulationThenMeasurement[],
): Promise<void> => {
    const scriptfilename = `${name}.gnuplot.gp`;
    const datafilename = `${name}.gnuplot.csv`;
    const datafilepath = `${eatFileName(datafilename)}`;
    const errorfilename = `${name}.error.csv`;
    const errorfilepath = `${eatFileName(errorfilename)}`;
    const svgfilename = `${name}.gnuplot.svg`;
    const svgfilepath = `${eatFileName(svgfilename)}`;
    const pngfilename = `${name}.gnuplot.png`;
    const pngfilepath = `${eatFileName(pngfilename)}`;
    console.log(`delve plotting ${name}...`);
    // let prevMeasurements: Measurements = null; // for doing  diff
    // generate a gnuplot data file and a command

    // headers, plots, data container, error report
    const headers: string[] = []; // headers for data file (inc events and simulations, which each take a column)
    const plots: string[] = []; // plots of the data fields
    let data: string[] = []; // the data (errors are inserted in-place)

    // automatically plot the x-axis in the right order (gnuplot always does it ascending)
    let reverse = false;
    let prevValue = undefined;
    const ef = new ErrorFormatter();
    // for each x axis value
    let first = true; // first time through, also set up
    // TODO: make independent a series of simulations, not just a series of events
    // for (const i of independent) {
    for await (const event of await Events(independent)) {
        if (!event.value) throw 'events on the x axis have to have a value';
        // handle the event - field data, then field header
        if (first) headers.push(event.name + '(simulation)' || 'no event name!');
        const plotRow: string[] = [];
        {
            const eventDisplay = formatEventResult(ef, event);
            //console.log(`   ${eventDisplay}`);
            plotRow.push(eventDisplay);
        }

        // the X value
        if (first) headers.push(event.name || 'no event name');
        plotRow.push(formatEther(event.value));

        // calculate each reading under each simulation
        for (const dependent of dependents) {
            // for each reading, run the simulation adding headers and plot for this dependent
            // before running any simulation, snapshot the current state
            const snapshot = await takeSnapshot();
            // run the simulation adding a headeer and results to data
            let simulationName = ''; // this is needed below
            if (dependent.simulation) {
                let simEventDisplays: string[] = [];
                let simEventNames: string[] = [];
                for await (const sim of await Events(dependent.simulation)) {
                    simEventDisplays.push(formatEventResult(ef, sim));
                    if (first) simEventNames.push(sim.name || 'no dependent simulation event name');
                }
                if (first) {
                    simulationName = simEventNames.join('+');
                    headers.push(simulationName);
                }
                const simulationDisplay = simEventDisplays.join('+');
                plotRow.push(simulationDisplay);
                //console.log(`         ${simulationDisplay}`);
            }
            // now do the calculations, do the headers and plots first
            if (first) {
                // the header for a dependent has part of the simulation in it's name
                for (const calculation of dependent.calculations) {
                    headers.push(
                        `${calculation.match.contract}.${calculation.match.reading}${
                            calculation.match.target
                                ? '(' +
                                  (contracts[calculation.match.target].name ||
                                      users[calculation.match.target].name ||
                                      calculation.match.target) +
                                  ')'
                                : ''
                        }${dependent.simulation ? '>' + simulationName : ''}`,
                    );
                    // what are the y-scales
                    let ycolumn = `(\$${headers.length.toString()})`;
                    plots.push(
                        `datafile using 2:${ycolumn} with lines ${calculation.lineStyle ? calculation.lineStyle : ''} ${
                            calculation.y2axis ? 'axes x1y2' : ''
                        }`,
                    );
                }
            }
            // get the dependent values, as a flattened, formatted row
            const results = (
                await calculateMeasures([...dependent.calculations.map((calculation) => calculation.match)])
            )
                // flatten and format per config
                .map((cm) => formatFromConfig(cm))
                .flatMap((cm) => cm.readings)
                // convert them to CSV values or errors
                .map((m) =>
                    m.value !== undefined
                        ? m.value
                        : m.error !== undefined
                        ? ef.formatError(m.error)
                        : 'undefined error',
                );
            // add the results for this dependent to the row
            plotRow.push(...results);
            await snapshot.restore();
        } // dependents
        // work out if the x-axis needs to be reversed
        if (prevValue !== undefined) {
            reverse = event.value < prevValue;
        } else {
            prevValue = event.value;
        }
        data.push(plotRow.map((m) => formatForCSV(m)).join(','));
        first = false;
    } // independents

    writeEatFile(datafilename, [headers.map((h) => formatForCSV(h)).join(','), ...data].join('\n'));
    writeEatFile(
        errorfilename,
        ef
            .errorMap()
            .map((e) => formatForCSV(e))
            .join('\n'),
    );

    let script = [
        `datafile = "${datafilepath}"`,
        `# additional imformation and error in ${errorfilepath}`,
        `set datafile separator comma`,
        `set key autotitle columnheader`,
        `set key bmargin`, // at the bottome
        `# set terminal pngcairo`,
        `# set output "${pngfilepath}`,
        `set terminal svg enhanced size 800 500 background rgb "gray90"`,
        `set autoscale`,
        `# set output "${svgfilepath}`,
        `set xlabel "${xlabel}"`,
        `set colorsequence default`,
    ];
    // normalise the ylabels
    let ylabels: [string, string] = Array.isArray(ylabel) ? ylabel : [ylabel, ''];
    ylabels.forEach((l, i) => {
        if (l) {
            const axis = i == 1 ? 'y2' : 'y';
            script.push(`set ${axis}label "${l}"`);
            if (l.endsWith('(sqrt)')) {
                script.push(`set nonlinear ${axis} via sqrt(y) inverse y*y`);
            }
            script.push(`set ${axis}tics`);
        }
    });

    if (reverse) {
        script.push(`set xrange reverse`);
    }

// #stats datafile using 1 nooutput
// #min = STATS_min
// #max = STATS_max
// #range_extension = 0.2 * (max - min)
// #set xrange [min - range_extension : max + range_extension]

// #stats datafile using 2 nooutput
// #min = STATS_min
// #max = STATS_max
// #range_extension = 0.2 * (max - min)
// #set yrange [min - range_extension : max + range_extension]

// #stats datafile using 3 nooutput
// #min = STATS_min
// #max = STATS_max
// #range_extension = 0.2 * (max - min)
// #set y2range [min - range_extension : max + range_extension]
    script.push(`plot ${plots.join(',\\\n     ')}`);
    writeEatFile(scriptfilename, script.join('\n'));
    console.log('delve plotting...done.');
};
*/
