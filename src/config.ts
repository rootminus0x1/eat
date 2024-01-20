import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml
import lodash from 'lodash';
import { parseUnits } from 'ethers';
import yargs from 'yargs';
import path from 'path';

export type ConfigItem = { name: string; config: Config };

export const ensureDirectory = (dir: string) => {
    // ensure the cache directory exists
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

export const write = (name: string, results: string): void => {
    const outputFileName = getConfig().configName + '.' + name;
    console.log(`   writing ${outputFileName}`);
    fs.writeFileSync(getConfig().outputFileRoot + outputFileName, results, { encoding: 'utf-8' });
};

type Formatter = (value: any) => any;
const removeInvalidYamlTypes: Formatter = (value: any): any => {
    if (typeof value === 'bigint') {
        // TODO: write it as a number if it can be contained in a number
        return value.toString();
    }
};

export const writeYaml = (name: string, results: any, formatter?: Formatter): void => {
    if (formatter) results = lodash.cloneDeepWith(results, formatter);
    write(name, yaml.dump(lodash.cloneDeepWith(results, removeInvalidYamlTypes)));
};

export type ConfigFormatMatch = {
    type?: string;
    contract?: string;
    contractType?: string;
    measurement?: string;
    // TODO: add field, for returned structures, make field have the precedence as contract & name/measurement
};

export type ConfigFormatApply = {
    unit?: string | number; // supports "eth", "wei", or precision digits
    decimals?: number; // number of significant decimals, after the point - use this as it works for differences too
};

export type ConfigFormat = ConfigFormatMatch & ConfigFormatApply;

export type ConfigAction = {
    name: string;
    user: string;
    contract: string;
    function: string;
    args: (string | bigint)[];
};

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

    // blockchain setup
    // TODO: support any of the 3 ways to specify a block number and generate the other two
    block: number;
    timestamp: number;
    datetime: string;

    actions: ConfigAction[];
    users: ConfigUser[];

    // where to look
    root: string[];
    leaf: string[];

    // what to output
    diagram: any;
    plot: any;

    // output details
    format: ConfigFormat[];
    show: string[]; // for debug purposes - als set via command line
};

const sortFormats = (formats: ConfigFormat[]): any => {
    // put any with decimals before any with units
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
                    // must do "no format" before format, then do .unit before .decimals
                    if (!x.unit && !x.decimals) value += 3000;
                    if (x.unit) value += 2000; // do .unit befoe .decimals
                    if (x.decimals) value += 1000; // do .unit befoe .decimals
                    // then do it in order of matches against .contract/.name and then .type
                    if (x.contract) value += 100;
                    if (x.measurement) value += 100;
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

export const parseArg = (configArg: any, users?: any, contracts?: any): string | bigint => {
    let arg: any;
    if (typeof configArg === 'bigint') {
        arg = configArg;
    } else if (typeof configArg === 'string') {
        // contract or user or address or string or number
        const match = configArg.match(/^\s*(\d+)\s*(\w+)\s*$/);
        if (match && match.length === 3) arg = parseUnits(match[1], match[2]);
        else if (users[configArg]) arg = users[configArg].address;
        else if (contracts[configArg]) arg = contracts[configArg].address;
    } else if (typeof configArg === 'number') arg = BigInt(configArg);
    else arg = 0n;
    return arg;
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
        config.outputFileRoot = `${path.dirname(configFilePath)}/results/`;
        ensureDirectory(config.outputFileRoot);
        config.configFilePath = configFilePath;
        config.configName = configName;

        // make sure more specific formats take precedence over less specific
        if (config.format) config.format = sortFormats(config.format);

        if (argv.showformat) config.show = ['format'];

        // output the config actually used for debug purposes
        if (argv.showconfig) write('flat-config.yml', yaml.dump(config));
    }
    return config;
};
