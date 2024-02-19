import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml
import lodash, { result } from 'lodash';
import { formatUnits, parseUnits } from 'ethers';

import yargs from 'yargs';
import path from 'path';
import { Reading, ReadingType, ReadingValue, TriggerOutcome } from './delve';
import { users, contracts, nodes } from './graph';

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

export const parseArg = (configArg: any): string | bigint => {
    let arg: any;
    if (typeof configArg === 'bigint') {
        arg = configArg;
    } else if (typeof configArg === 'string') {
        // contract or user or address or string or number
        arg = replaceMatch(configArg, [
            // address - just leave as is
            [/^0x[a-fA-F0-9]{40}$/, (match) => match[0]],
            // 1ether, 1 ether
            [/^\s*(\d+)\s*(\w+)\s*$/, (match) => parseUnits(match[1], match[2])],
            // name to address lookup
            [
                /^.+$/,
                (match) => {
                    if (users[match[0]]) return users[match[0]].address;
                    if (contracts[match[0]]) return contracts[match[0]].address;
                    return match[0];
                },
            ],
        ]);
    } else if (typeof configArg === 'number') {
        arg = BigInt(configArg);
    } else {
        arg = configArg;
    }
    return arg;
};

const getDecimals = (unit: string | number | undefined): number => {
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

const regexpEscape = (word: string) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
type formatSpec = { unit?: number | string; precision?: number } | undefined;

const formatFromConfig = (
    value: ReadingValue,
    contract: string,
    reading: string,
    type: string,
    delta: boolean = false,
): [string | string[], formatSpec] => {
    let result: string | string[];
    let formatResult: formatSpec = undefined;
    if (type.endsWith('[]')) {
        result = (value as bigint[]).map((elem: any) => elem.toString());
    } else {
        result = value.toString();
    }
    if (getConfig().format) {
        let mergedFormat: ConfigFormatApply = {};
        let donotformat = false;
        for (const format of getConfig().format) {
            // TODO: make addresses, map on to contracts or users, not just for target fields
            // TODO: could some things,
            // like timestamps be represented as date/times
            // or numbers
            // merge all the formats that apply
            if (
                (!format.type || type === format.type) &&
                (!format.reading || reading.match(new RegExp(`(^|\\.)${regexpEscape(format.reading)}(\\.\\(||$)`))) &&
                (!format.contract || contract === format.contract)
            ) {
                if (format.unit === undefined && format.precision === undefined) {
                    donotformat = true;
                    break; // got a no format request, so we're done
                }

                if (format.unit !== undefined && mergedFormat.unit === undefined) mergedFormat.unit = format.unit;
                if (format.precision !== undefined && mergedFormat.precision === undefined)
                    mergedFormat.precision = format.precision;

                if (mergedFormat.unit !== undefined && mergedFormat.precision !== undefined) break; // got enough
            }
        }
        if (donotformat) {
            formatResult = {};
        } else if (mergedFormat.unit !== undefined || mergedFormat.precision !== undefined) {
            formatResult = mergedFormat;
            if (type.endsWith('[]') && Array.isArray(value)) {
                result = value.map((elem: any) =>
                    doFormat(
                        BigInt(elem.toString()),
                        delta,
                        mergedFormat.unit as string | number,
                        mergedFormat.precision,
                    ),
                );
            } else {
                result = doFormat(
                    BigInt(value.toString()),
                    delta,
                    mergedFormat.unit as string | number,
                    mergedFormat.precision,
                );
            }
        }
    }
    return [result, formatResult];
};

export const formatArg = (arg: ReadingType): string => {
    if (arg == undefined) {
        console.log('undefined arg');
    }
    if (typeof arg === 'string') {
        return replaceMatch(arg, [
            // address - look up the name
            [/^0x[a-fA-F0-9]{40}$/, (match) => nodes.get(match[0])?.name || match[0]],
        ]).toString();
    }
    // TODO: format from config here, need contact, function and field to do that
    return arg.toString();
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
    // console.log(`   writing ${filePath}`);
    ensureDirectory(filePath);
    fs.writeFileSync(filePath, results, { encoding: 'utf-8' });
};

export const eatFileName = (name: string): string => {
    return getConfig().configName + '.' + name;
};

export const writeEatFile = (name: string, results: string): void => {
    console.log(`   writing ${eatFileName(name)}`);
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

const transformReadings = (orig: Reading[]): any => {
    let addresses: any = {};
    let contracts: any = {};
    let readings: any = {};

    orig.forEach((r) => {
        if (addresses[r.contractInstance] === undefined) {
            addresses[r.contractInstance] = `${r.contract}@${r.address}`;
        }

        if (contracts[r.contract] === undefined) contracts[r.contract] = {};
        // remove the contract instance and parameters
        contracts[r.contract][r.reading.replace(/^[^.]*\./, '').replace(/\([^)]*\)/, '')] = r.type;
        if (r.value !== undefined) {
            const [formatted, formats] = formatFromConfig(r.value, r.contract, r.reading, r.type);
            let comment = ''; // `${r.type}`;
            if (formats) comment = ` # ${JSON.stringify(formats).replace(/"/g, '')}`;
            readings[r.reading] = r.type.endsWith('[]')
                ? (formatted as string[]).map((f) => `${f}${comment}`)
                : `${formatted}${comment}`;
        } else {
            readings[r.reading] = `!${r.error}`;
        }
    });

    return { addresses: addresses, contracts: contracts, readings: readings };
};

const yamlIt = (it: any): string =>
    yaml.dump(it, {
        replacer: replacer,
    });

export const writeReadings = (name: string, results: Reading[], simulation?: TriggerOutcome[]): void => {
    let data = simulation ? yamlIt({ simulation: simulation }) : '';
    data += yamlIt(transformReadings(results));
    writeEatFile(name + '.readings.yml', data);
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

type Arg = string | bigint;
export type ConfigUserEvent = {
    name: string;
    user: string;
    contract: string;
    function: string;
    args: Arg[];
};

type ArgSubstitution = [number, Arg];
function substituteArgs(userEvent: ConfigUserEvent, ...substitutions: ArgSubstitution[]): ConfigUserEvent {
    const newArgs = userEvent.args ? [...userEvent.args] : [];
    substitutions.forEach(([index, value]) => {
        newArgs[index] = value;
    });
    return { ...userEvent, args: newArgs };
}

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
        console.log(configFilePath);

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
