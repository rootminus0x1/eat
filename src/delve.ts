import * as crypto from 'crypto-js';

import { readerTemplates, nodes } from './graph';
import { ConfigFormatApply, eatFileName, getConfig, numberCompare, stringCompare, writeEatFile } from './config';
import { takeSnapshot, time } from '@nomicfoundation/hardhat-network-helpers';
import { withLogging, Logger, log } from './logging';
import { Reader, Reading, ReadingData, ReadingType, callReader, makeReading } from './read';
import {
    addressToName,
    friendlyArgs,
    friendlyOutcome,
    friendlyReader,
    friendlyReaderFunction,
    getDecimals,
    readingDataDisplay,
} from './friendly';
import { Trigger, TriggerOutcome, doTrigger } from './trigg';
import { formatEther, formatUnits } from 'ethers';

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
                    } else {
                        /*
                        log(
                            `a=${formatUnits(a as bigint, decimals)}, b=${formatUnits(
                                b as bigint,
                                decimals,
                            )}, delta=${formatUnits(
                                result as bigint,
                                decimals,
                            )} for exponent=${exponent} when units=${decimals} and precision=${precision}`,
                        );
                        */
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
        // log(`${friendlyReader(reading)}`);
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

// export const readingsDeltas = withLogging(_readingsDeltas);

////////////////////////////////////////////////////////////////////////
// delve

// assumptions:
// range given can be of the form (v = valid, i = invalid)
//   IVI = |iivvii|
//   IV = |iivvvv|
//   VI = |vvvvii|
//   V = |vvvvvv|
// invalid means f(x) returns undefined, valid means f(x) returns bigint
export const inverse = async (
    ytarget: bigint,
    ygetter: () => Promise<bigint>,
    xsetter: (value: bigint) => Promise<void>,
    xbound: [bigint, bigint],
    ytolerance: bigint = 10n ** 14n, // 4 decimals
): Promise<bigint | undefined> => {
    const snapshot = await takeSnapshot();
    let result: bigint | undefined = undefined;

    try {
        let [xMinGiven, xMaxGiven] = xbound;
        if (xMinGiven >= xMaxGiven) throw Error(`lower bound ${xMinGiven} must be less than ${xMaxGiven}`);

        const f = async (x: bigint) => {
            try {
                await xsetter(x);
                const y = await ygetter();
                //log(`f(${formatEther(x)}) -> ${formatEther(y)}`);
                return y;
            } catch (e: any) {
                //log(`f(${formatEther(x)}) undefined`);
                return undefined;
            }
        };

        // find a value of x within xbound that f(x) is defined (!== undefined)
        let xMinValid = (await f(xMinGiven)) !== undefined ? xMinGiven : undefined; // min X value known to be valid
        let xMaxValid = (await f(xMaxGiven)) !== undefined ? xMaxGiven : undefined; // max X value known to be valie

        // ! xMinValid && ! xMaxValid = range type IVI
        // ! xMinValid &&   xMaxValid = range type IV
        //   xMinValid && ! xMaxValid = range type VI
        //   xMinValid &&   xMaxValid = range type V

        if (xMinValid === undefined || xMaxValid === undefined) {
            // not range type V
            let xSomeValid: bigint | undefined = undefined; // some X value known to be valid, not known where in the range it is
            if (xMinValid === undefined && xMaxValid === undefined) {
                // range type IVI, find some value for x in the V bit
                // must be a good value within the range with bad values on the boundaries and outside
                // search using a gradually decreasing step size for a defined result
                let stepSize = xMaxGiven - xMinGiven; // Initial step size based on range
                while (xSomeValid === undefined && stepSize >= 1n) {
                    stepSize /= 2n; // half the step size;
                    for (let x = xMinGiven + stepSize; x < xMaxGiven; x += stepSize) {
                        if (f(x) !== undefined) {
                            xSomeValid = x;
                            break;
                        }
                    }
                }
            }
            // by here we have at least one of xMinValid, xMaxValid or xSomeValid must not be undefined
            if (xMinValid === undefined && xMaxValid === undefined && xSomeValid === undefined)
                throw Error('no valid return values for ygetter(x) for x in [${xbound[0]}:${xbound[1]}');

            if (xMinValid === undefined) {
                // range type IVI or IV, need to find the boundary between I and V, on the V side
                // seach from xMinGiven up (as likely most of the range is valid)
                let low = xMinGiven + 1n; // we know xMinGiven is not valid
                let high: bigint = xSomeValid !== undefined ? xSomeValid : xMaxValid!; // lowest known valid value
                if (high === undefined) throw "shouldn't throw this";
                while (low < high) {
                    const mid = (low + high) / 2n; // floor
                    if ((await f(mid)) === undefined) {
                        low = mid + 1n;
                    } else {
                        high = mid;
                    }
                }
                if (high === undefined) throw Error('xMinValid still undefined!');
                xMinValid = high;
            }
            if (xMaxValid === undefined) {
                // seach from xMaxGiven up (as likely most of the range is valid)
                let low = xSomeValid !== undefined ? xSomeValid : xMinValid; // highest known valid value
                let high = xMaxGiven - 1n;
                if (low === undefined) throw "shouldn't throw this";
                while (low < high) {
                    const mid = (low + high + 1n) / 2n; // ceil
                    if ((await f(mid)) === undefined) {
                        high = mid - 1n;
                    } else {
                        low = mid;
                    }
                }
                if (low === undefined) throw Error('xMinValid still undefined!');
                xMaxValid = low;
            }
        }
        let yMinValid = (await f(xMinValid!)) as bigint;
        let yMaxValid = (await f(xMaxValid!)) as bigint;

        // log(
        //     `x in [${formatEther(xMinGiven)}..${formatEther(xMaxGiven)}] -> y in [${formatEther(yMinValid)}..${formatEther(
        //         yMaxValid,
        //     )}]`,
        // );

        // Ensure that y is within the range of the function
        if (yMinValid > ytarget || yMaxValid < ytarget)
            throw `target y ${ytarget} is outside of the range ${yMinValid}..${yMaxValid}`;

        let xhigh = xMaxValid;
        //    let yhigh = yMaxValid;
        let xlow = xMinValid;
        //    let ylow = yMinValid;
        let xmid: bigint | undefined = undefined;
        const abs = (a: bigint) => (a < 0n ? -a : a);
        while (xlow <= xhigh) {
            xmid = xlow + (xhigh - xlow) / 2n;
            const ymid = await f(xmid);
            if (ymid === undefined) throw `f(${xmid}) failed when it shouldn't!`;

            if (ytarget - ytolerance <= ymid && ymid <= ytarget + ytolerance) {
                break; // Found a value within the tolerance
            }

            if (ymid < ytarget) {
                xlow = xmid + 1n;
            } else {
                xhigh = xmid - 1n;
            }
        }
        // Return the midpoint as an approximation of the inverse
        // log(`inverse(${formatEther(ytarget)}) = ${formatEther(xmid!)}`);
        result = xmid;
    } finally {
        snapshot.restore();
    }

    return result;
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
    simulation?: Trigger[]; // simulation for the readings of this line, re-done for each reading on the line
    reader: Reader;
    ignore0?: boolean;
    style?: string;
};

export type YAxis = Axis & {
    lines: Line[];
};

export type YAxes = {
    simulation?: Trigger[]; // simulation for all the readings of all axes, re-done for each x-reading - not cumulative
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
        `set terminal svg enhanced size 800 ${
            500 + 19 * (yAxes.y.lines.length + (yAxes.y2?.lines.length || 0) + 1.5) /* for the title */
        } background rgb "gray90"`,
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
                    axis.scale
                        ? ' (' + axis.scale.toLocaleString() + (axis.scale.valueOf() !== 0 ? "'s" : '') + ')'
                        : ''
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
                if (axis.scale === 'sqrt') {
                    script.push(`set nonlinear ${a} via sqrt(${a[0]}) inverse ${a[0]}*${a[0]}`);
                } else if (axis.scale === 'sqr') {
                    script.push(`set nonlinear ${a} via ${a[0]}*${a[0]} inverse sqrt(${a[0]})`);
                } else if (axis.scale === 'log') {
                    script.push(`set ${a}range [0:]`); // logs don't work at 0
                    script.push(`set nonlinear ${a} via log(${a[0]}) inverse exp(${a[0]})`);
                } else if (axis.scale === 'log10') {
                    script.push(`set ${a}range [0:]`); // logs don't work at 0
                    script.push(`set nonlinear ${a} via log10(${a[0]}) inverse 10**${a[0]}`);
                } else if (axis.scale === 'exp') {
                    script.push(`set nonlinear ${a} via exp(${a[0]}) inverse log(${a[0]})`);
                } else if (axis.scale === 'sinh') {
                    script.push(`set nonlinear ${a} via sinh(${a[0]}) inverse asinh(${a[0]})`);
                } else if (axis.scale === 'asinh') {
                    script.push(`set nonlinear ${a} via asinh(${a[0]}) inverse sinh(${a[0]})`);
                }
            }
        }
    });

    {
        // headers - scoped out so no inadvertent later access
        const headers: string[] = []; // headers for data file (inc events and simulations, which each take a column)

        const readerHeader = (reader: Reader, axis: string = '') =>
            headers.push(`${axis}${addressToName(reader.address)}.${friendlyReaderFunction(reader)}`);

        const triggerHeaders = (triggers?: Trigger[]) =>
            (triggers || []).forEach((trigger) => headers.push(trigger.name));

        // headers
        // x-axis trigger
        headers.push(xAxis.label);

        // x-axis cummulative triggers - all run once on each x axis value
        triggerHeaders(xAxis.cumulative);

        // x-axis reader
        const xindex = headers.length;
        readerHeader(xAxis.reader);

        // y-axis simulation
        triggerHeaders(yAxes.simulation);

        // y-axis readers
        const yindex = headers.length;
        // the x-axis data comes next, headers and plots
        const plots: string[] = [];

        const lineHeaders = (lines: Line[] | undefined, isY2: boolean, hasY2: boolean) => {
            for (const line of lines || []) {
                triggerHeaders(line.simulation);
                readerHeader(line.reader, hasY2 ? (isY2 ? '[Y-axis->]' : '[<-Y-axis]') : '');
                const column = (index: number, ignoreZeros: boolean = false): string => {
                    const c = index.toString();
                    return ignoreZeros ? `(\$${c} == 0 ? 1/0 : \$${c})` : `(\$${c})`;
                };
                plots.push(
                    `datafile using ${column(xindex + 1)}:${column(headers.length, line.ignore0)} with lines${
                        line.style?.includes('pointtype') ? 'points' : ''
                    }${line.style ? ' ' + line.style : ''}${isY2 ? ' axes x1y2' : ''}`,
                );
            }
        };

        lineHeaders(yAxes.y.lines, false, yAxes.y2 !== undefined);
        lineHeaders(yAxes.y2?.lines, true, true);
        script.push(`plot ${plots.join(',\\\n     ')}`);
        data.push(headers.map((h) => formatForCSV(h)).join(','));
    }
    //-----------------------------------
    const original = await takeSnapshot(); // to be restored at the end of everything
    //-----------------------------------
    for (const trigger of xAxis.cause) {
        const rowData: string[] = [];

        const triggersData = async (triggers?: Trigger[]) => {
            for (const trigger of triggers || []) {
                const outcome = await doTrigger(trigger, true);
                rowData.push(friendlyOutcome(outcome));
            }
        };
        const readersData = async (lines?: Line[], scale?: number | undefined) => {
            for (const line of lines || []) {
                //-----------------------------------
                let lineshot = line.simulation ? await takeSnapshot() : undefined; // to be restored after all dependents have been read
                //-----------------------------------
                await triggersData(line.simulation);
                const readingData = await callReader(line.reader); // no args
                // TODO: work with non-bigint data?
                const display = readingDataDisplay(readingData, line.reader.type, line.reader.formatting);
                if (line.reader.type.endsWith('[]'))
                    throw Error(`cannot plot data that is an array ${addressToName(line.reader.address)}.`);
                let displayable = display as string;
                if (scale) displayable = (Number(displayable as string) / Number(scale)).toString();
                rowData.push(displayable);
                //-----------------------------------
                if (lineshot !== undefined) await lineshot.restore();
                //-----------------------------------
            }
        };

        // generate the x-axis value - this is not cumulative
        await triggersData([trigger]);

        // x-axis cumulative - used to simulate a change over time, but not measured other than the yAxes readers
        await triggersData(xAxis.cumulative || []);

        const scaleof = (axis: Axis | undefined) => (typeof axis?.scale === 'number' ? axis.scale : undefined);
        // x-axis readers
        await readersData([{ reader: xAxis.reader }], scaleof(xAxis));

        // y-axis simulation - re-run on each loop
        //-----------------------------------
        let axisshot = yAxes.simulation ? await takeSnapshot() : undefined; // to be restored after all dependents have been read
        //-----------------------------------

        await triggersData(yAxes.simulation);

        await readersData(yAxes.y.lines, scaleof(yAxes.y));
        await readersData(yAxes.y2?.lines, scaleof(yAxes.y2));

        //----------------------
        if (axisshot !== undefined) await axisshot.restore();
        //----------------------

        data.push(rowData.map((m) => formatForCSV(m)).join(','));
    }
    //----------------------
    await original.restore();
    //----------------------

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
