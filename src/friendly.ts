import { formatUnits, parseUnits } from 'ethers';

import { nodes } from './graph';
import { Field, Reader, Reading, ReadingData, ReadingValue } from './read';
import { ConfigFormatApply } from './config';

///////////////////////////////////////////////////////////////////////////////
// raw to friendly

export const addressToName = (address: string): string => nodes.get(address)?.name || address;

// if there's no name, use the index as the name
export const fieldToName = (field: Field): string => field.name || field.index.toString();

const addField = (field?: Field): string => (field ? `.${fieldToName(field)}` : '');

/*
export const callToName = (reader: Reader, args?: any[]) => {
    let result = reader.function;
    if (args?.length) result += `(${args})`;
    result += fieldToName(reader.field);
    return result;
};
*/

const formatArg = (value: any, type: string) => {
    if (type === 'address') {
        const match = value.match(/^0x[a-fA-F0-9]{40}$/);
        if (match) return addressToName(value);
    }
    return value;
};

export const friendlyArgs = (rawArgs: any[], argTypes: string[]): string => {
    let result = rawArgs.map((a: any, i: number) => formatArg(a, argTypes[i])).join(',');
    if (result.length) result = `(${result})`;
    return result;
};
// template name - contract.function.field, generated on creation
export const functionField = (func: string, field?: Field): string => `${func}${addField(field)}`;

// instanceName: contractInstance.function(friendlyArgs).field
export const friendlyFunctionReading = (reading: Reading): string =>
    `${reading.function}${friendlyArgs(reading.args, reading.argTypes)}${addField(reading.field)}`;

export const getDecimals = (unit?: number | string): number => {
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

const friendlyReadingValue = (
    value: ReadingValue,
    type: string,
    formatting?: ConfigFormatApply,
    delta: boolean = false,
): string | string[] => {
    let result: string | string[];
    if (formatting?.unit !== undefined || formatting?.precision !== undefined) {
        if (type.endsWith('[]') && Array.isArray(value)) {
            result = value.map((elem: any) =>
                doFormat(BigInt(elem.toString()), delta, formatting.unit as string | number, formatting.precision),
            );
        } else {
            result = doFormat(
                BigInt(value.toString()),
                delta,
                formatting.unit as string | number,
                formatting.precision,
            );
        }
    } else {
        if (type.endsWith('[]') && Array.isArray(value)) {
            result = value.map((elem: any) => formatArg(elem, type.replace('[]', '')).toString());
        } else {
            result = formatArg(value, type).toString();
        }
    }
    return result;
};

const readingBasicDisplay = (
    rb: ReadingData,
    type: string,
    formatting?: ConfigFormatApply,
    delta: boolean = false,
): [any, string | undefined] => {
    // log(
    //     `formatting ${r.reading}: ${r.type}, ${typeof rb.value}, ${
    //         rb.value
    //     }, as string: '${rb.value?.toString()}'`,
    // );
    let value: any = undefined;
    let error: string | undefined = undefined;
    if (rb.value !== undefined) {
        const formatted = friendlyReadingValue(rb.value, type, formatting, delta);
        let comment = ''; // `${r.type}`;
        if (formatting) comment = ` # ${JSON.stringify(formatting).replace(/"/g, '')}`;
        value = type.endsWith('[]') ? (formatted as string[]).map((f) => `${f}${comment}`) : `${formatted}${comment}`;
    }
    if (rb.error !== undefined) error = `${rb.error}`;
    return [value, error];
};

export const readingDisplay = (r: Reading): string => {
    let value: any = undefined;
    let delta: any = undefined;
    let error: string | undefined = undefined;

    if (r.delta !== undefined) {
        [value, error] = readingBasicDisplay(r.delta, r.type, r.formatting, true);
    } else {
        [value, error] = readingBasicDisplay(r, r.type, r.formatting);
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
        reading[friendlyFunctionReading(r)] = display;
        fnReadings.push(reading);
    });

    if (cIndex !== -1 && fIndex !== -1) readings[cIndex].functions[fIndex].readings = fnReadings;
    return readings;
};

///////////////////////////////////////////////////////////////////////////////
// friendly to raw

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

const nameToAddress = (name: string): string => nodes.get(name)?.address || name;

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
