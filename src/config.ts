import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml'; // config files are in yaml
import * as lodash from 'lodash';

type ConfigItem = { name: string; config: any };

// TODO: support referencing to merge in other config.
export const getConfig = (fileArgs: string[], defaultconfigsArg: string): any[] => {
    const result = [];
    // functions
    const getConfigName = (configFilePath: string) =>
        path.basename(configFilePath, '.config' + path.extname(configFilePath));
    const loadYaml = (configFilePath: string) => yaml.load(fs.readFileSync(configFilePath).toString());

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
    // console.log(defaults);

    for (const fileArg of fileArgs) {
        // load the requested config
        const configFilePath = path.resolve(fileArg);
        const configName = getConfigName(configFilePath);

        // find matching defaults and merge them
        const config: any = defaults.reduce((result: any, d) => {
            if (configName.startsWith(d.name)) {
                //console.log(`defaulting from '${d.name}'`);
                lodash.merge(result, d.config);
                // console.log(`new config = ${JSON.stringify(result, undefined, '  ')}`);
            }
            return result;
        }, {} as any);

        // finally merge in the actual config
        lodash.merge(config, loadYaml(configFilePath));

        // finally, finally, add additional fields
        config.outputFileRoot = `${path.dirname(configFilePath)}/results/`;
        config.configFilePath = configFilePath;
        config.configName = configName;

        //console.log(`final config = ${JSON.stringify(config, undefined, '  ')}`);

        result.push(config);
    }
    return result;
};
