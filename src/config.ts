import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml
import lodash, { result, values } from 'lodash'; //
import { formatUnits, parseUnits } from 'ethers';

import yargs from 'yargs';
import path from 'path';
import { users, contracts, nodes } from './graph';
import { Logger, log } from './logging';
import { functionField, transformReadings } from './friendly';
import { Field, Reading } from './read';
import { TriggerOutcome } from './trigg';

export const stringCompare = (a: string, b: string): number => a.localeCompare(b, 'en', { sensitivity: 'base' });
export const numberCompare = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);

const regexpEscape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
type formatSpec = { unit?: number | string; precision?: number } | undefined;

export const getFormatting = (type: string, contract: string, func: string, field?: Field) => {
    if (getConfig().format) {
        const reading = functionField(func, field);
        let mergedFormat: ConfigFormatApply = {};
        for (const format of getConfig().format) {
            // TODO: could some things,
            // like timestamps be represented as date/times
            // or numbers
            // merge all the formats that apply
            if (
                (!format.type || type === format.type) &&
                (!format.reading || reading === format.reading) &&
                (!format.contract || contract === format.contract)
            ) {
                // is it a highest priority no-format spec
                if (format.unit === undefined && format.precision === undefined) {
                    return {}; // this overrides any formatting specified previously
                }

                // merge the formatting but don't override
                if (format.unit !== undefined && mergedFormat.unit === undefined) {
                    mergedFormat.unit = format.unit;
                }
                if (format.precision !== undefined && mergedFormat.precision === undefined) {
                    mergedFormat.precision = format.precision;
                }
                // got a full format? if so we're done
                if (mergedFormat.unit !== undefined && mergedFormat.precision !== undefined) return mergedFormat; // got enough
            }
        }
        if (mergedFormat.unit !== undefined || mergedFormat.precision !== undefined) {
            return mergedFormat;
        }
    }
    return undefined;
};

export type ConfigItem = { name: string; config: Config };

export const ensureDirectory = (filePath: string) => {
    // ensure the directory exists
    const dir = path.dirname(filePath);
    try {
        // Check if the directory already exists
        fs.accessSync(dir);
    } catch (error: any) {
        // If the directory doesn't exist, create it
        if (error.code === 'ENOENT') {
            fs.mkdirSync(dir, { recursive: true });
        } else {
            // If there was an error other than the directory not existing, throw the error
            throw error;
        }
    }
};

export const writeFile = (filePath: string, results: string): void => {
    // log(`writing ${filePath}`);
    ensureDirectory(filePath);
    fs.writeFileSync(filePath, results, { encoding: 'utf-8' });
};

export const eatFileName = (name: string): string => {
    return getConfig().configName + '.' + name;
};

const writeEatFile = (name: string, results: string): void => {
    log(`writing ${eatFileName(name)}`);
    writeFile(getConfig().outputFileRoot + eatFileName(name), results);
};

type Formatter = (value: any) => any;

const replacer = (key: string, value: any) => {
    if (typeof value === 'bigint') {
        return value.toString() + 'n'; // Append 'n' to indicate BigInt
    } else if (typeof value === 'function') {
        return undefined; // strip out the functions
    } else {
        return value; // Return the value unchanged
    }
};

/*const transformReadingsOrig = (orig: Reading[]): any => {
    let addresses: any = {};
    let contracts: any = {};
    let readings: any = {};

    orig.forEach((r) => {
        // save the value/delta/error
        let value: any = undefined;
        let error: string | undefined = undefined;

        const readingDisplay = (rb: ReadingBasic, delta: boolean = false): [any, string | undefined] => {
            let value: any = undefined;
            let error: string | undefined = undefined;
            if (rb.value !== undefined) {
                const formatted = formatFromConfig(rb.value, r.type, r.formatting, delta);
                let comment = ''; // `${r.type}`;
                if (r.formatting) comment = ` # ${JSON.stringify(r.formatting).replace(/"/g, '')}`;
                value = r.type.endsWith('[]')
                    ? (formatted as string[]).map((f) => `${f}${comment}`)
                    : `${formatted}${comment}`;
            }
            if (r.error !== undefined) error = `${r.error}`;
            return [value, error];
        };

        if (r.delta !== undefined) {
            [value, error] = r.delta ? readingDisplay(r.delta, true) : [undefined, undefined];
        } else {
            [value, error] = readingDisplay(r);
        }

        const display =
            value !== undefined && error !== undefined
                ? { value: value, error: error }
                : value !== undefined
                ? value
                : error;

        if (display != undefined) {
            readings[r.reading] = display;

            if (addresses[r.contractInstance] === undefined) {
                addresses[r.contractInstance] = `${r.contract}@${r.address}`;
            }

            if (contracts[r.contract] === undefined) contracts[r.contract] = {};
            // remove the contract instance and parameters
            contracts[r.contract][r.reading.replace(/^[^.]*\./, '').replace(/\([^)]*\)/, '')] = r.type;
        }
    });

    return { addresses: addresses, contracts: contracts, readings: readings };
};
*/

const yamlIt = (it: any): string =>
    yaml.dump(it, {
        replacer: replacer,
    });

const _writeReadings = (fileName: string, results: Reading[], simulation?: TriggerOutcome[]) => {
    let simData = simulation ? yamlIt({ simulation: simulation }) : '';
    // writeEatFile("old_" + fileName, simData + yamlIt(transformReadingsOrig(results)));
    writeEatFile(fileName, simData + yamlIt({ readings: transformReadings(results) }));
};

export const writeReadings = (name: string, results: Reading[], simulation?: TriggerOutcome[]): void => {
    _writeReadings(name + '.readings.yml', results, simulation);
};

export const writeReadingsDelta = (name: string, results: Reading[], simulation: TriggerOutcome[]): void => {
    _writeReadings(name + '.readings.delta.yml', results, simulation);
};

export const writeDiagram = (name: string, diagram: string): void => {
    writeEatFile(name + '.diagram.mmd', diagram);
};

export const writeMarkDown = (name: string, diagram: string): void => {
    writeEatFile(name + '.diagram.md', diagram);
};

export type ConfigFormatMatch = {
    type?: string;
    contract?: string; // contract type
    reading?: string; // tail part of the reading name
};

export type ConfigFormatApply = {
    unit?: string | number; // supports "eth", "wei", or precision digits
    precision?: number; // number of significant decimals, after the point - negative for before the point
};

export type ConfigFormat = ConfigFormatMatch & ConfigFormatApply;

//type Arg = string | bigint;
export type ConfigUserEvent = {
    name: string;
    user: string;
    contract: string;
    function: string;
    args: string[];
};
/*
type ArgSubstitution = [number, Arg];
function substituteArgs(userEvent: ConfigUserEvent, ...substitutions: ArgSubstitution[]): ConfigUserEvent {
    const newArgs = userEvent.args ? [...userEvent.args] : [];
    substitutions.forEach(([index, value]) => {
        newArgs[index] = value;
    });
    return { ...userEvent, args: newArgs };
}
*/
export type ConfigHolding = {
    contract: string;
    amount: string | bigint;
};

export type ConfigUser = {
    name: string;
    wallet: ConfigHolding[];
};

export type Config = {
    // from the command line
    configName: string;
    configFilePath: string;
    outputFileRoot: string;
    sourceCodeRoot: string;

    // blockchain setup
    // TODO: support any of the 3 ways to specify a block number and generate the other two
    block: number;
    timestamp: number;
    datetime: string;

    triggers: ConfigUserEvent[];
    users: ConfigUser[];

    // where to look
    root: string[];
    leaf: string[];
    twig: string[];
    depth: number;

    // what to output
    diagram: any;
    plot: any;

    // output details
    format: ConfigFormat[];
    show: string[]; // for debug purposes - als set via command line
};

const sortFormats = (formats: ConfigFormat[]): any => {
    // put any with precision before any with units
    // those with both contract and name come first
    // second are those with one of contract and name, retaining the same order as given
    // last are those with no contract and name
    return (
        formats
            // add indices
            .map((format, index) => ({ format, index }))
            // sort them
            .sort((a, b) => {
                const valueof = (x: ConfigFormat): number => {
                    let value = 0;
                    // must do "no format" before format, then do .unit before .precision
                    if (!x.unit && !x.precision) value += 3000;
                    if (x.unit) value += 2000; // do .unit before .precision
                    if (x.precision) value += 1000;
                    // then do it in order of matches against .contract/.name and then .type
                    if (x.contract) value += 100;
                    if (x.reading) value += 100;
                    if (x.type) value += 10;
                    return value;
                };
                const av = valueof(a.format);
                const bv = valueof(b.format);
                return av == bv ? a.index - b.index : bv - av;
            })
            // remove the indices
            .map((v) => v.format)
    );
};

const getConfigName = (configFilePath: string) =>
    path.basename(configFilePath, '.config' + path.extname(configFilePath));

const loadYaml = (configFilePath: string) => yaml.load(fs.readFileSync(configFilePath).toString());

const merge = (object: any, source: any) =>
    lodash.mergeWith(object, source, (o: any, s: any) => {
        if (lodash.isArray(o)) return o.concat(s);
    });

let config: Config | undefined;

export const getConfig = (): Config => {
    if (!config) {
        const argv: any = yargs(process.argv.slice(2))
            .options({
                showconfig: { type: 'boolean', default: false },
                showformat: { type: 'boolean', default: false },
                showunformatted: { type: 'boolean', default: false },
                quiet: { type: 'boolean', default: false },
                defaultconfigs: { type: 'string', default: 'test/default-configs' },
            })
            .parse();

        // load the default-configs
        let defaults: ConfigItem[] = [];
        try {
            fs.readdirSync(argv.defaultconfigs)
                .sort()
                .forEach((fileName) =>
                    defaults.push({
                        name: getConfigName(fileName),
                        config: loadYaml(argv.defaultconfigs + '/' + fileName) as Config,
                    }),
                );
        } catch (error: any) {}

        // load the requested config
        const configFilePath = path.resolve(argv._[0]);
        log(configFilePath);

        const configName = getConfigName(configFilePath);

        // find matching defaults and merge them
        config = defaults.reduce((result, d) => {
            if (configName.startsWith(d.name)) {
                merge(result, d.config);
            }
            return result;
        }, {} as Config);

        // finally merge in the actual config
        merge(config, loadYaml(configFilePath));

        // finally, finally, add additional fields
        config.configFilePath = configFilePath;
        config.configName = configName;
        config.outputFileRoot = `${path.dirname(configFilePath)}/results/`;
        config.sourceCodeRoot = `contacts/`;

        // make sure more specific formats take precedence over less specific
        if (config.format) config.format = sortFormats(config.format);

        if (argv.showformat) config.show = ['format'];

        // output the config actually used for debug purposes
        if (argv.showconfig) writeEatFile('flat-config.yml', yaml.dump(config));
    }
    return config;
};
