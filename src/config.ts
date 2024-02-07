import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml
import lodash from 'lodash';
import yargs from 'yargs';
import path from 'path';

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
const removeInvalidYamlTypes: Formatter = (value: any): any => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
};

export const writeYaml = (name: string, results: any, formatter?: Formatter): void => {
    if (formatter) results = lodash.cloneDeepWith(results, formatter);
    // console.log(`   writing ${getConfig().outputFileRoot + eatFileName(name)}`);
    writeEatFile(name, yaml.dump(lodash.cloneDeepWith(results, removeInvalidYamlTypes)));
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

    userEvents: ConfigUserEvent[];
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
                    if (x.unit) value += 2000; // do .unit befoe .precision
                    if (x.precision) value += 1000; // do .unit befoe .precision
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
