import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml'; // config files are in yaml

const loadConfig = (fileArg: string): any => {
    const configFilePath = path.resolve(fileArg);
    let config: any = yaml.load(fs.readFileSync(configFilePath).toString());
    config.configFilePath = configFilePath;
    config.configName = path.basename(configFilePath, '-config' + path.extname(configFilePath));
    return config;
};

function deepCopyAndOverlay<T extends Record<string, any>>(source1: T, source2: T): T {
    function deepCopy(obj: any): any {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }

        if (Array.isArray(obj)) {
            return obj.map((item) => deepCopy(item));
        }

        if (typeof obj === 'object') {
            const copiedObject: Record<string, any> = {};

            for (const key in obj) {
                if (obj.hasOwnProperty(key)) {
                    copiedObject[key] = deepCopy(obj[key]);
                }
            }

            return copiedObject;
        }

        return obj;
    }

    const copiedObject = deepCopy(source1);

    function overlay(target: Record<string, any>, source: Record<string, any>): void {
        for (const key in source) {
            if (source.hasOwnProperty(key)) {
                if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
                    // Recursively overlay nested objects
                    target[key] = deepCopyAndOverlay(target[key], source[key]);
                } else {
                    // Overlay primitive values or arrays
                    target[key] = source[key];
                }
            }
        }
    }

    overlay(copiedObject, source2);

    return copiedObject;
}

// TODO: support referencing to merge in other config.
export const getConfig = (fileArgs: string[], defaultconfigArg: string): any[] => {
    const result = [];
    // load the default
    const defaultConfig = loadConfig(defaultconfigArg);
    for (const fileArg of fileArgs) {
        let config = deepCopyAndOverlay(defaultConfig, loadConfig(fileArg));

        config.outputFileRoot = `${path.dirname(config.configFilePath)}/results/`;

        result.push(config);
    }
    return result;
};
