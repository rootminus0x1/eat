import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml
import lodash from 'lodash';
import { parseUnits } from 'ethers';
import yargs from 'yargs';
import path from 'path';

export type ConfigItem = { name: string; config: Config };

export const write = (name: string, results: string): void => {
    const outputFile = fs.createWriteStream(getConfig().outputFileRoot + getConfig().configName + '.' + name, {
        encoding: 'utf-8',
    });
    outputFile.write(results);
    outputFile.end();
};

type Formatter = (value: any) => any;
const removeInvalidYamlTypes: Formatter = (value: any): any => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
};

export const writeYaml = (name: string, results: any, formatter?: Formatter): void => {
    if (formatter) results = lodash.cloneDeepWith(results, formatter);
    write(name, yaml.dump(lodash.cloneDeepWith(results, removeInvalidYamlTypes)));
};

export type ConfigFormat = {
    type: string;
    contract: string;
    name: string;
    unit: string | number; // supports "eth", "wei", or precision digits
};

export type ConfigAction = {
    name: string;
    user: string;
    contract: string;
    function: string;
    args: (string | bigint)[];
};

export type Config = {
    // from the command line
    configName: string;
    configFilePath: string;
    outputFileRoot: string;
    nodiagram: boolean;

    // from the files
    block: number;
    start: string[];
    stopafter: string[];
    diagram: any;
    format: ConfigFormat[];
    actions: ConfigAction[];
    users: any[];
};

const sortFormats = (formats: ConfigFormat[]): any => {
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
                    if (x.contract) value += 100;
                    if (x.name) value += 100;
                    if (!x.unit) value += 10; // no format
                    if (x.type) value += 1;
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
                nodiagram: { type: 'boolean', default: false },
                nomeasures: { type: 'boolean', default: false },
                showconfig: { type: 'boolean', default: false },
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
        config.configFilePath = configFilePath;
        config.configName = configName;

        // make sure more specific formats take precedence over less specific
        config.format = sortFormats(config.format);

        // output the config actually used for debug purposes
        write('flat-config.yml', yaml.dump(config));
    }
    return config;
};
