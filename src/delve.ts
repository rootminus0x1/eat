import * as crypto from 'crypto-js';

import { contracts, readerTemplates, nodes, users, GraphNode } from './graph';
import { MaxInt256, formatEther, formatUnits } from 'ethers';
import { ConfigFormatApply, eatFileName, getConfig, numberCompare, stringCompare, writeEatFile } from './config';
import lodash, { forEach, isNumber } from 'lodash';
import { takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { withLogging, Logger, log } from './logging';
import { Reader, Reading, ReadingData, ReadingType, callReader, makeReading } from './read';
import {
    addressToName,
    friendlyArgs,
    friendlyFunctionReader,
    friendlyOutcome,
    getDecimals,
    readingDataDisplay,
    readingDisplay,
} from './friendly';
import { Trigger, TriggerOutcome, doTrigger } from './trigg';

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

/*
export const doReading = async (address: string, fn: string, field?: string, ...args: any[]): Promise<Reading> => {
    const reader = makeReader(address, fn, field);
    return await callReader(reader, ...args);
};
*/
/*
export type Experiment = {
    simulation: TriggerOutcome[];
    readings: Reading[];
};
*/
////////////////////////////////////////////////////////////////////////
// doReadings

const compareReadingKeys = (a: Reading, b: Reading) =>
    // TODO: replace contract/address with contract instance name (i.e. addressToName(x.address))
    stringCompare(a.contract, b.contract) ||
    stringCompare(a.address, b.address) ||
    stringCompare(a.function, b.function) ||
    stringCompare(friendlyArgs(a.args, a.argTypes), friendlyArgs(b.args, b.argTypes)) ||
    (a.field && b.field ? numberCompare(a.field.index, b.field.index) : 0);

const sortReadings = (r: Reading[]): Reading[] => r.sort(compareReadingKeys);

export const doReadings = async (): Promise<Reading[]> => {
    const result: Reading[] = [];
    for (const [address, readerList] of readerTemplates) {
        //const logger = new Logger(`reading: ${addressToName(address)}`);
        for (const reader of readerList) {
            if (reader.argTypes && reader.argTypes.length == 1 && reader.argTypes[0] === 'address') {
                // nodes are already sorted by name
                for (const [target, node] of nodes) {
                    if (target !== address) result.push(await makeReading(reader, target));
                }
            } else {
                result.push(await makeReading(reader)); // no args needed here
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

export const readingDelta = (
    reading: ReadingData,
    base: ReadingData,
    formatting: ConfigFormatApply | undefined,
    type: string,
): ReadingData => {
    const delta: ReadingData = {};
    // check the errors first
    // TODO: do we need the quotes?
    if (reading.error === undefined && base.error !== undefined) delta.error = `"${base.error}" -> ${reading.error}`;
    if (reading.error !== undefined && base.error === undefined) delta.error = `${base.error} -> "${reading.error}"`;
    if (reading.error !== base.error) delta.error = `"${base.error}" -> "${reading.error}"`;

    // now check the values that are the same type (by definition) but may be arrays or scalars
    const scalarDelta = (type: string, a: ReadingType, b: ReadingType): ReadingType => {
        let result: ReadingType = 0n;
        if (a !== b) {
            if (type.includes('int')) {
                result = (a as bigint) - (b as bigint);
                // take into account any formatting, units and precision
                if (formatting?.precision !== undefined) {
                    const decimals = getDecimals(formatting.unit); // e.g. 16, 18 or 0
                    const precision = formatting.precision || 0; // e.g. 0, 1 or -1
                    // * 10 ** (16, 17, 1)
                    const exponent = BigInt(precision - decimals);
                    let scaler = exponent < 0n ? result / 10n ** -exponent : result * 10n ** exponent;
                    if (scaler < 0) scaler = -scaler;
                    if (scaler === 0n) {
                        result = 0n;
                    }
                }
            } else if (type === 'bool') result = a; // changed from !reading.value to reading.value
            else if (type === 'string' || type.startsWith('address') || type.startsWith('bytes'))
                result = `"${base.value}" -> "${reading.value}}"`;
            else throw Error(`unsupported reading type in deltas: ${type}`);
        }
        return result;
    };

    if (reading.value === undefined && base.value !== undefined)
        delta.value = `[${base.value.toString()}] -> ${reading.value}`;
    if (reading.value !== undefined && base.value === undefined)
        delta.value = `${base.value} -> [${reading.value.toString()}]`;

    // like for like comparison
    if (reading.value !== undefined && base.value !== undefined) {
        if (type.endsWith('[]') && Array.isArray(reading.value) && Array.isArray(base.value)) {
            // do array comparison
            const readingA = reading.value;
            const baseA = base.value;
            if (readingA.length === baseA.length) {
                const proposed = readingA.map((readingAi, i) =>
                    scalarDelta(type.replace('[]', ''), readingAi, baseA[i]),
                );
                const defined = proposed.reduce((count, v) => (v ? count + 1 : count), 0);
                delta.value = defined > 0 ? proposed : undefined;
            } else {
                delta.value = `${baseA.length}:[${baseA.toString()}] -> ${readingA.length}[${readingA.toString()}]`;
            }
        } else {
            // do scalar comparison
            delta.value = scalarDelta(type, reading.value as ReadingType, base.value as ReadingType);
        }
    }
    return delta;
};

export const readingsDeltas = (readings: Reading[], baseReadings: Reading[]): Reading[] => {
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
            let delta: ReadingData = readingDelta(reading, base, reading.formatting, reading.type);
            if (delta.value /* non-0 or defined */ || delta.error !== undefined)
                deltas.push(Object.assign({ delta: delta }, reading));
        }
    }
    // add anything left over as more readings
    while (a < readings.length) deltas.push(readings[a++]); // a new reading, not in base
    // while (b < baseReadings.length) deltas.push(baseReadings[b++]); // a missing reading, only in base
    return sortReadings(deltas);
};

////////////////////////////////////////////////////////////////////////
// delve
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
    const snapshot = await takeSnapshot(); // to be restored at the end of this
    // do each trigger
    for await (const trigger of simulation) {
        outcomes.push(await doTrigger(trigger, true));
    }
    const readings = await doReadings();
    await snapshot.restore();
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
*/

const formatForCSV = (value: string): string =>
    // If the value contains a comma, newline, or double quote, enclose it in double quotes
    /[,"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

/*
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

/*
THE NEW DELVEPLOT
*/

type Axis = {
    label: string;
    scale?: number | string; // divide the results by this and augment the label
    reversed?: boolean;
    range?: [number | undefined, number | undefined];
};
export type XAxis = Axis & {
    cause: Trigger[];
    cumulative?: Trigger[];
    reader: Reader;
};

export type Line = {
    reader: Reader;
    style?: string;
};

export type YAxis = Axis & {
    lines: Line[];
};

export type YAxes = {
    simulation?: Trigger[];
    y: YAxis;
    y2?: YAxis;
};

const _delvePlot = async (
    name: string, // TODO: generate this
    xAxis: XAxis,
    yAxes: YAxes,
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
    // let prevMeasurements: Measurements = null; // for doing  diff
    // generate a gnuplot data file and a command

    // plot data & scripts to go in files
    let data: string[] = []; // the data (errors are inserted in-place)
    let script = [
        `set title "${name}" noenhanced`,
        `datafile = "${datafilepath}"`,
        `# additional imformation and error in ${errorfilepath}`,
        `set datafile separator comma`,
        `set key autotitle columnheader noenhanced`,
        `set key bmargin`, // at the bottome
        `set key title " "`, // further down to avoid the x-axis label
        `# set terminal pngcairo`,
        `# set output "${pngfilepath}"`,
        `set terminal svg enhanced size 800 500 background rgb "gray90"`,
        `set autoscale`,
        `set colorsequence default`,
        `# set output "${svgfilepath}"`,
    ];
    [xAxis, yAxes.y, yAxes.y2].map((axis, i) => {
        const a = ['x', 'y', 'y2'][i];
        if (axis) {
            if (axis.reversed) {
                script.push(`set ${a}range reverse`);
            }
            script.push(
                `set ${a}label "${axis.label}${
                    axis.scale ? ' (' + axis.scale.toLocaleString() + 's)' : ''
                }" noenhanced`,
            );
            script.push(`set ${a}tics`);
            script.push(`set ${a}tics nomirror`);
            if (axis.range !== undefined) {
                let [min, max] = axis.range.map((r) =>
                    r === undefined
                        ? '*'
                        : axis.scale !== undefined && typeof axis.scale === 'number'
                        ? r / axis.scale
                        : r,
                );
                script.push(`set ${a}range [${min}:${max}]`);
            }
            if (axis.scale !== undefined && typeof axis.scale === 'string') {
                if (axis.scale === 'sqrt') script.push(`set nonlinear ${a} via sqrt(${a[0]}) inverse ${a[0]}*${a[0]}`);
                else if (axis.scale === 'sqr')
                    script.push(`set nonlinear ${a} via ${a[0]}*${a[0]} inverse sqrt(${a[0]})`);
                else if (axis.scale === 'log') script.push(`set nonlinear ${a} via log(${a[0]}) inverse exp(${a[0]})`);
                else if (axis.scale === 'exp') script.push(`set nonlinear ${a} via exp(${a[0]}) inverse log(${a[0]})`);
                else if (axis.scale === 'sinh')
                    script.push(`set nonlinear ${a} via sinh(${a[0]}) inverse asinh(${a[0]})`);
                else if (axis.scale === 'asinh')
                    script.push(`set nonlinear ${a} via asinh(${a[0]}) inverse sinh(${a[0]})`);
            }
        }
    });

    {
        // headers - scoped out so no inadvertent later access
        const headers: string[] = []; // headers for data file (inc events and simulations, which each take a column)
        const readerHeader = (reader: Reader) =>
            headers.push(`${addressToName(reader.address)}.${friendlyFunctionReader(reader)}`);
        const triggerHeader = (trigger: Trigger) => headers.push(trigger.name);

        // headers
        // x-axis trigger
        headers.push(xAxis.label);

        // x-axis cummulative triggers - all run once on each x axis value
        (xAxis.cumulative || []).forEach((sim) => triggerHeader(sim));

        // x-axis reader
        const xindex = headers.length;
        readerHeader(xAxis.reader);

        // y-axis simulation
        (yAxes.simulation || []).forEach((sim) => triggerHeader(sim));

        // y-axis readers
        const yindex = headers.length;
        // the x-axis data comes next, headers and plots
        const plots: string[] = [];
        const lineHeader = (line: Line, index: number, indexOffset: number, isY2: boolean) => {
            readerHeader(line.reader);
            const column = (index: number): string => `(\$${index.toString()})`;
            plots.push(
                `datafile using ${column(xindex + 1)}:${column(index + indexOffset + 1)} with lines ${
                    line.style ? line.style : ''
                } ${isY2 ? 'axes x1y2' : ''}`,
            );
        };
        yAxes.y.lines.forEach((line, i) => lineHeader(line, i, yindex, false));
        (yAxes.y2?.lines || []).forEach((line, i) => lineHeader(line, i, yindex + yAxes.y.lines.length, true));
        script.push(`plot ${plots.join(',\\\n     ')}`);
        data.push(headers.map((h) => formatForCSV(h)).join(','));
    }

    const snapshot = await takeSnapshot(); // to be restored after all dependents have been read
    for (const trigger of xAxis.cause) {
        const rowData: string[] = [];
        const readersData = async (readers?: Reader[], scale?: number | undefined) => {
            for (const reader of readers || []) {
                const readingData = await callReader(reader); // no args
                // TODO: work with non-bigint data?
                let display = readingDataDisplay(readingData, reader.type, reader.formatting);
                if (scale) display = (Number(display) / Number(scale)).toString();
                rowData.push(display);
            }
        };
        const triggersData = async (triggers?: Trigger[]) => {
            for (const trigger of triggers || []) {
                const outcome = await doTrigger(trigger, true);
                rowData.push(friendlyOutcome(outcome));
            }
        };

        await triggersData([trigger]); // x axis

        // x-axis cumulative
        await triggersData(xAxis.cumulative || []);

        // snapshot in here, to restore after

        const scaleof = (axis: Axis | undefined) => (typeof axis?.scale === 'number' ? axis.scale : undefined);
        // x-axis readers
        await readersData([xAxis.reader], scaleof(xAxis));

        // y-axis simulation - re-run
        await triggersData(yAxes.simulation);

        await readersData(
            yAxes.y.lines.map((l) => l.reader),
            scaleof(yAxes.y),
        );
        await readersData(
            yAxes.y2?.lines.map((l) => l.reader),
            scaleof(yAxes.y2),
        );

        await snapshot.restore();
        data.push(rowData.map((m) => formatForCSV(m)).join(','));
    }

    writeEatFile(datafilename, data.join('\n'));

    script.push(`# stats datafile using 1 nooutput`);
    script.push(`# min = STATS_min`);
    script.push(`# max = STATS_max`);
    script.push(`# range_extension = 0.2 * (max - min)`);
    script.push(`# set xrange [min - range_extension : max + range_extension]`);

    script.push(`# stats datafile using 2 nooutput`);
    script.push(`# min = STATS_min`);
    script.push(`# max = STATS_max`);
    script.push(`# range_extension = 0.2 * (max - min)`);
    script.push(`# set yrange [min - range_extension : max + range_extension]`);

    script.push(`# stats datafile using 3 nooutput`);
    script.push(`# min = STATS_min`);
    script.push(`# max = STATS_max`);
    script.push(`# range_extension = 0.2 * (max - min)`);
    script.push(`# set y2range [min - range_extension : max + range_extension]`);

    writeEatFile(scriptfilename, script.join('\n'));
};

export const delvePlot = withLogging(_delvePlot);
