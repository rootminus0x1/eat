import { performance } from 'perf_hooks';

// global indentation level
let indentLevel = 0;
const indentation = 2; // spaces
const maxArgsLength = 30;

// type of function to be wrapped
type AnyFunctionSync = (...args: any[]) => any;
type AnyFunction = (...args: any[]) => Promise<any>;

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

export const log = (...args: any[]) => {
    console.log(`${indent()}${argsStr(1000, ...args)}`);
};

// wrapping function, returns the wrapped function, err, wrapped
export const withLoggingSync = (fn: AnyFunctionSync) => {
    return (...args: Parameters<AnyFunctionSync>): ReturnType<AnyFunctionSync> => {
        logStart(fn.name, args);
        const start = performance.now();
        try {
            return fn(...args); // Execute the original function
        } finally {
            const finish = performance.now();
            logFinish(fn.name, start, finish, args);
        }
    };
};

export const withLogging = (fn: AnyFunction) => {
    return async (...args: Parameters<AnyFunctionSync>): Promise<ReturnType<AnyFunctionSync>> => {
        logStart(fn.name, args);
        const start = performance.now();
        try {
            return await fn(...args); // Execute the original function
        } finally {
            const finish = performance.now();
            logFinish(fn.name, start, finish, args);
        }
    };
};
