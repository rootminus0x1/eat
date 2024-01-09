import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml'; // config files are in yaml
import lodash from 'lodash';

type ConfigItem = { name: string; config: any };

export const write = (config: any, name: string, results: string): void => {
    const outputFile = fs.createWriteStream(config.outputFileRoot + config.configName + '.' + name, {
        encoding: 'utf-8',
    });
    outputFile.write(results);
    outputFile.end();
};

// TODO: support referencing to merge in other config.
export const getConfig = (fileArgs: string[], defaultconfigsArg: string): any[] => {
    const result = [];
    // functions
    const getConfigName = (configFilePath: string) =>
        path.basename(configFilePath, '.config' + path.extname(configFilePath));

    const loadYaml = (configFilePath: string) => yaml.load(fs.readFileSync(configFilePath).toString());

    const merge = (object: any, source: any) =>
        lodash.mergeWith(object, source, (o: any, s: any) => {
            if (lodash.isArray(o)) return o.concat(s);
        });

    // load the default-configs
    let defaults: ConfigItem[] = [];
    try {
        fs.readdirSync(defaultconfigsArg)
            .sort()
            .forEach((fileName) =>
                defaults.push({
                    name: getConfigName(fileName),
                    config: loadYaml(defaultconfigsArg + '/' + fileName),
                }),
            );
    } catch (error: any) {}

    for (const fileArg of fileArgs) {
        // load the requested config
        const configFilePath = path.resolve(fileArg);
        const configName = getConfigName(configFilePath);

        // find matching defaults and merge them
        const config: any = defaults.reduce((result: any, d) => {
            if (configName.startsWith(d.name)) {
                merge(result, d.config);
            }
            return result;
        }, {} as any);

        // finally merge in the actual config
        merge(config, loadYaml(configFilePath));

        // finally, finally, add additional fields
        config.outputFileRoot = `${path.dirname(configFilePath)}/results/`;
        config.configFilePath = configFilePath;
        config.configName = configName;

        // output the config actually used for debug purposes
        write(config, 'flat-config.yml', yaml.dump(config));

        result.push(config);
    }
    return result;
};
