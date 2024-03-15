import { performance } from 'perf_hooks';

// global indentation level
let indentLevel = 0;
const indentation = 2; // spaces
const maxArgsLength = 80;

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
        result = result.substring(0, maxLength - 3) + '...';
    }
    return result;
};

export const log = (text: string, endl: boolean = true) => {
    console.log(indent() + text);
};

export const discardlog = () => {};

export class Logger {
    private startTime: number;
    private leader: string;

    constructor(name: string, ...args: any[]) {
        this.leader = `${indent()}${name}`;
        if (args) this.leader += `(${argsStr(maxArgsLength, ...args)})`;
        console.log(`${this.leader} =>`);
        indentLevel++; // Increase indent level for nested calls
        this.startTime = performance.now();
    }

    public done = (success: boolean = true): number => {
        const duration = performance.now() - this.startTime;
        indentLevel--;
        console.log(`${this.leader}${success ? '' : ' FAILED'} took ${(duration / 1000).toLocaleString('en')}s.`);
        return duration;
    };
}

export const withLogging = (fn: any) => {
    return async (...args: any[]) => {
        const timer = new Logger(fn.name, args);
        let success = false;
        try {
            const result = await fn(...args); // Execute the original function
            success = true;
            return result;
        } finally {
            timer.done(success);
        }
    };
};
