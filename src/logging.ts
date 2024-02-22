import { performance } from 'perf_hooks';

// global indentation level
let indentLevel = 0;
const indentation = 2; // spaces
const maxArgsLength = 30;

const indent = () => ' '.repeat(indentLevel * indentation);

const replacer = (key: string, value: any) => {
    if (typeof value === 'bigint') {
        return value.toString() + 'n'; // Append 'n' to indicate BigInt
    } else if (typeof value === 'function') {
        return undefined; // strip out the functions
    } else {
        return value; // Return the value unchanged
    }
};

const argsStr = (maxLength: number, ...args: any[]): string => {
    let result = JSON.stringify(args, replacer).replace(/^\[|\]$/g, '');
    result = result.substring(1, result.length - 1);

    // Limit the string length to maxLength characters
    if (result.length > maxLength) {
        result = result.substring(0, maxLength);
    }
    return result;
};

/*

const logStart = (fnName: string, ...args: any[]) => {
    if (fnName.startsWith('_')) fnName = fnName.substring(1);
    console.log(`${indent()}${fnName}(${argsStr(maxArgsLength, ...args)})...`);
    indentLevel++; // Increase indent level for nested calls
};

const logFinish = (fnName: string, start: number, finish: number, ...args: any[]) => {
    indentLevel--; // Decrease indent level after execution
    if (fnName.startsWith('_')) fnName = fnName.substring(1);
    console.log(
        `${indent()}${fnName}(${argsStr(maxArgsLength, ...args)}) took ${((finish - start) / 1000).toLocaleString(
            'en',
        )}s.`,
    );
};

*/

export class Logger {
    private startTime: number;
    private leader: string;

    constructor(name: string, ...args: any[]) {
        if (name.startsWith('_')) name = name.substring(1);
        this.leader = `${indent()}${name}`;
        if (args) this.leader += `(${argsStr(maxArgsLength, ...args)})`;
        console.log(`${this.leader}...`);
        indentLevel++; // Increase indent level for nested calls
        this.startTime = performance.now();
    }

    finish(): number {
        const duration = performance.now() - this.startTime;
        indentLevel--;
        console.log(`${this.leader} took ${(duration / 1000).toLocaleString('en')}s.`);
        return duration;
    }
}

let buffer: string = '';
export const log = (text: string, endl: boolean = true) => {
    buffer += text;
    if (endl) {
        console.log(`${indent()}${buffer}`);
        erase();
    }
};
export const erase = () => {
    buffer = '';
};

export const withLogging = (fn: any) => {
    return async (...args: any[]) => {
        const timer = new Logger(fn.name, args);
        try {
            return await fn(...args); // Execute the original function
        } finally {
            timer.finish();
        }
    };
};
