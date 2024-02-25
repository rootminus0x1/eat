/** read
 * contains Readers and Readings
 * all contain only raw values, i.e. bigints and 0x strings for addresses, etc.
 * it also cotains formatting information
 */

import { ConfigFormatApply } from './config';

export type ReadingType = bigint | string | boolean;
export type ReadingValue = ReadingType | ReadingType[];
export type Field =
    // the output index of the field (for generic extraction)
    {
        name: string; // for multiple outputs, arrays are not multiple outputs, name is for user extraction
        index: number;
    };

export type ReaderTemplate = {
    address: string;
    contract: string;
    function: string;
    field?: Field;
    argTypes: string[]; // types or the args
    type: string; // solidity type of result, you know how to extract the resulta
    read: (...args: any[]) => Promise<any>; // is this needed if we have all the above?
    formatting?: ConfigFormatApply;
};

export type Reader = ReaderTemplate & {
    args: any[]; // raw args
};

/*
export const makeErrorReader = (error: string, extra: string = '') => ({
    address: '',
    contract: extra.match(/^[^.]+/),
    function: extra.match(/[.][^.]+/),
    field: undefined,
    argTypes: [], // types or the args
    type: 'string', // solidity type of result, you know how to extract the resulta
    read: () => ({ error: `ERROR! ${error}: ${extra}` }),
    args: [], // raw args
});
*/

export type ReadingData = {
    value?: ReadingValue; // if it's an address or array of addresses they are translated into contract names
    // error can hold an error, a change in error message or indicate a change from a value to/from an error
    error?: string;
};

export type Reading = Reader &
    ReadingData & {
        delta?: ReadingData;
    };

const makeReader = (template: ReaderTemplate, ...args: any[]): Reader => Object.assign({ args: args }, template);

export const callReaderTemplate = async (reader: ReaderTemplate, ...args: any[]): Promise<ReadingData> => {
    let value: ReadingValue | undefined;
    let error: string | undefined;
    try {
        let result = await reader.read(...args);
        if (reader.field) {
            value = result[reader.field.index];
        } else {
            value = result;
        }
    } catch (e: any) {
        error = e.message;
    }
    return {
        value: value,
        error: error,
    };
};

export const makeReading = async (readerTemplate: ReaderTemplate, ...rawArgs: any[]): Promise<Reading> => {
    const basic = await callReaderTemplate(readerTemplate, ...rawArgs);
    return Object.assign({ args: rawArgs }, readerTemplate, basic);
};
