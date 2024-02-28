import { ZeroAddress, formatUnits, parseUnits } from 'ethers';

import { contracts, nodes } from './graph';
import { Field, Reader, Reading, ReadingData, ReadingType, ReadingValue } from './read';
import { ConfigFormatApply } from './config';
import { TriggerOutcome } from './trigg';
import * as yaml from 'js-yaml'; // config files are in yaml
import { log } from './logging';

///////////////////////////////////////////////////////////////////////////////
// utility functions

const replaceMatch = (
    value: string,
    replacers: [RegExp, (match: RegExpMatchArray) => string | bigint][],
): string | bigint => {
    for (const [pattern, processor] of replacers) {
        const matches = value.match(pattern);
        if (matches) {
            return processor(matches);
        }
    }
    return value;
};

export const getDecimals = (unit?: number | string): number => {
    if (typeof unit === 'string') {
        const baseValue = formatUnits(1n, unit);
        const decimalPlaces = baseValue.toString().split('.')[1]?.length || 0;
        return decimalPlaces;
    } else return unit || 0;
};

export const JSONreplacer = (key: string, value: any) =>
    typeof value === 'bigint'
        ? value.toString() + 'n' // Append 'n' to indicate BigInt
        : typeof value === 'function'
        ? undefined
        : value;

///////////////////////////////////////////////////////////////////////////////
// formattimg of specific field types

// format a bigint according to unit and precision
const formatBigInt = (value: bigint, addPlus: boolean, unit?: number | string, precision?: number): string => {
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
                result = doUnit(BigInt(value) + 5n * 10n ** BigInt(getDecimals(unit) - precision - 1));
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

// format an address
const formatAddress = (value: string): string => {
    if (value === ZeroAddress) return '0x0';
    return addressToName(value);
};

const formatGas = (gas: bigint) => `${gas / 1000n}k`;

const formatError = (e: string | undefined): string => {
    let message = e || 'undefined error';
    // TODO: use replace match above
    const patterns: [RegExp, (match: RegExpMatchArray) => string][] = [
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
        if (matches !== null) {
            message = processor(matches);
            break;
        }
    }
    return message;
};

const friendlyReadingType = (
    value: ReadingType,
    type: string,
    formatting?: ConfigFormatApply,
    delta: boolean = false,
): string => {
    let result: string;
    if (type === 'address') {
        result = formatAddress(value as string);
    } else if (type.includes('int')) {
        result = formatBigInt(value as bigint, delta, formatting?.unit, formatting?.precision);
    } else {
        log(`unexpected type ${type}`);
        result = value.toLocaleString();
    }
    return result;
};

const friendlyReadingValue = (
    value: ReadingValue,
    type: string,
    name?: string,
    formatting?: ConfigFormatApply,
    delta: boolean = false,
): string | string[] => {
    let result: string | string[];
    if (type.endsWith('[]') && Array.isArray(value)) {
        result = value.map((elem) => friendlyReadingType(elem, type.slice(0, -2), formatting, delta));
    } else {
        result = friendlyReadingType(value as ReadingType, type, formatting, delta);
    }
    if (name) return `${name}=${result}`; //`${name}:${type}=${result}`;
    else return result;
};

///////////////////////////////////////////////////////////////////////////////
// raw to friendly

const ifDefined = (prefix: string, value: any | undefined, suffix: string) =>
    value === undefined ? '' : prefix + value.toString() + suffix;

export const addressToName = (address: string): string => nodes.get(address)?.name || address;

// if there's no name, use the index as the name
export const fieldToName = (field: Field): string => field.name || field.index.toString();

const add = (field: string | undefined, separator: string = '.'): string =>
    field !== undefined ? `${separator}${field}` : '';

const addField = (field: Field | undefined): string => (field !== undefined ? add(fieldToName(field)) : '');

/*
export const callToName = (reader: Reader, args?: any[]) => {
    let result = reader.function;
    if (args?.length) result += `(${args})`;
    result += fieldToName(reader.field);
    return result;
};
*/

export const friendlyArgs = (
    rawArgs: any[],
    argTypes: string[],
    argNames?: string[],
    formatting?: Map<string, ConfigFormatApply>,
): string => {
    let result = rawArgs
        .map((a: any, i: number) =>
            friendlyReadingValue(a, argTypes[i], argNames ? argNames[i] : undefined, formatting?.get(argTypes[i])),
        )
        .join(',');
    if (result.length) result = `(${result})`;
    return result;
};

export const yamlIt = (it: any): string =>
    yaml.dump(it, {
        //indent: 4,
        replacer: JSONreplacer,
        //flowLevel: 1000,
        lineWidth: 200,
        noRefs: true,
    });

// template name - contract.function.field, generated on creation
export const functionField = (func: string, field?: Field): string => `${func}${addField(field)}`;

///////////////////////////////////////////////////////////////////////////////
// Triggers

export const friendlyOutcome = (outcome: TriggerOutcome): string => {
    let display = outcome.gas !== undefined ? `gas:${formatGas(outcome.gas)}` : formatError(outcome.error);
    if (outcome.value != undefined) display = `[${outcome.value}, ${display}]`;
    if (display === undefined) display = '-';
    return display;
};

///////////////////////////////////////////////////////////////////////////////
// Readers

export const friendlyFunctionReader = (reading: Reader): string =>
    `${reading.function}${friendlyArgs(reading.args, reading.argTypes)}${addField(reading.field)}${add(
        reading.augmentation,
        '-',
    )}`;

export const readingDataValues = (
    rb: ReadingData,
    type: string,
    formatting?: ConfigFormatApply,
    delta: boolean = false,
): [any, string | undefined] => {
    let value: any = undefined;
    let error: string | undefined = undefined;
    if (rb.value !== undefined) {
        value = friendlyReadingValue(rb.value, type, undefined, formatting, delta);
    }
    if (rb.error !== undefined) error = formatError(rb.error);
    return [value, error];
};

export const readingDataDisplay = (
    rb: ReadingData,
    type: string,
    formatting?: ConfigFormatApply,
    delta: boolean = false,
): string => {
    let value: any = undefined;
    let error: string | undefined = undefined;
    [value, error] = readingDataValues(rb, type, formatting, delta);

    return value !== undefined && error !== undefined
        ? { value: value, error: error }
        : value !== undefined
        ? value
        : error;
};

export const readingDisplay = (r: Reading): string => {
    let value: any = undefined;
    let delta: any = undefined;
    let error: string | undefined = undefined;

    // TODO: replace this with a call to the function above
    if (r.delta !== undefined) {
        [value, error] = readingDataValues(r.delta, r.type, r.formatting, true);
    } else {
        [value, error] = readingDataValues(r, r.type, r.formatting);
    }

    return value !== undefined && error !== undefined
        ? { value: value, error: error }
        : value !== undefined
        ? value
        : error;
};

export const transformReadings = (orig: Reading[]): any => {
    let readings: any[] = [];
    let cName = '';

    orig.forEach((r) => {
        const display = readingDisplay(r);

        if (display != undefined) {
            // contract
            {
                const contractInstance = addressToName(r.address);
                if (contractInstance !== cName) {
                    cName = contractInstance;
                    readings.push({});
                    readings[readings.length - 1][cName] = [];
                }
                const reading: any = {};
                reading[friendlyFunctionReader(r)] = display;
                readings[readings.length - 1][cName].push(reading);
            }
        }
    });
    return readings;
};

export const transformReadingsVerbose = (orig: Reading[]): any => {
    let readings: any[] = [];
    let cName = '';
    let cIndex: number = -1;
    let fName = '';
    let fIndex: number = -1;
    let fnReadings: any[] = [];

    orig.forEach((r) => {
        // save the value/delta/error
        const display = readingDisplay(r);

        if (display != undefined) {
            // contract
            const contractInstance = addressToName(r.address);
            if (cName !== contractInstance || fName !== r.function) {
                if (cIndex !== -1) {
                    readings[cIndex].functions[fIndex].readings = fnReadings;
                    fnReadings = [];
                }

                if (cName !== contractInstance) {
                    cName = contractInstance;

                    // add this contract instance
                    readings.push({});
                    cIndex = readings.length - 1;

                    // update the fields
                    readings[cIndex][cName] = r.address;
                    readings[cIndex].contract = r.contract;
                    readings[cIndex].functions = [];

                    fName = '';
                }

                if (fName !== r.function && cIndex !== -1) fName = r.function;
                // add the function to the contract instance
                readings[cIndex].functions.push({});
                fIndex = readings[cIndex].functions.length - 1;
            }
        }
        readings[cIndex].functions[fIndex][functionField(r.function, r.field)] = r.type;

        const reading: any = {};
        reading[friendlyFunctionReader(r)] = display;
        fnReadings.push(reading);
    });

    if (cIndex !== -1 && fIndex !== -1) readings[cIndex].functions[fIndex].readings = fnReadings;
    return readings;
};

///////////////////////////////////////////////////////////////////////////////
// friendly to raw

export const nameToAddress = (name: string): string => contracts[name]?.address || name;

export const parseArg = (configArg: any): any => {
    let arg: any;
    if (typeof configArg === 'string') {
        // contract or user or address or string or number
        arg = replaceMatch(configArg, [
            // address - just leave as is
            [/^0x[a-fA-F0-9]{40}$/, (match) => match[0]],
            // 1ether, 1 ether
            [/^\s*(\d+)\s*(\w+)\s*$/, (match) => parseUnits(match[1], match[2])],
            // name to address lookup
            [/^.+$/, (match) => nameToAddress(match[0])],
        ]);
    } else {
        arg = configArg;
    }
    return arg;
};

export const rawArgs = (friendlyArgs: string[]): any[] => friendlyArgs.map((a: any) => parseArg(a));
