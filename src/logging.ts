import { performance } from 'perf_hooks';

// global indentation level
let indentLevel = 0;
const indentation = 2; // spaces
const maxArgsLength = 60;

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

let buffer: string = '';
let pending: string[] = [];
export const log = (text: string, endl: boolean = true) => {
    buffer += text;
    if (endl) {
        pending.push(`${indent()}${buffer}`);
        discardlog();
    }
};

export const discardlog = () => {
    buffer = '';
};

export class Logger {
    private startTime: number;
    private leader: string;

    constructor(name: string, ...args: any[]) {
        this.doPending('');
        if (name.startsWith('_')) name = name.substring(1);
        this.leader = `${indent()}${name}`;
        if (args) this.leader += `(${argsStr(maxArgsLength, ...args)})`;
        indentLevel++; // Increase indent level for nested calls
        this.startTime = performance.now();
    }

    private doPending = (pre: string): number => {
        const result = pending.length;
        if (pending.length) {
            if (pre) console.log(pre);
            pending.forEach((l) => console.log(l));
            pending = [];
        }
        return result;
    };

    public done = (): number => {
        const duration = performance.now() - this.startTime;
        indentLevel--;
        if (buffer) log('');
        let extra = '...';
        if (this.doPending(`${this.leader}${extra}`) > 0) extra = '';
        console.log(`${this.leader}${extra} took ${(duration / 1000).toLocaleString('en')}s.`);
        return duration;
    };
}

export const withLogging = (fn: any) => {
    return async (...args: any[]) => {
        const timer = new Logger(fn.name, args);
        try {
            return await fn(...args); // Execute the original function
        } finally {
            timer.done();
        }
    };
};
