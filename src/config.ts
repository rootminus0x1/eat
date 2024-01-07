import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml'; // config files are in yaml

export const getConfig = (): any => {
    const args = process.argv.slice(2);
    let configFilePath = path.resolve(args[0]);
    const config: any = yaml.load(fs.readFileSync(configFilePath).toString());
    const configName = path.basename(configFilePath, path.extname(configFilePath));
    config.outputFileRoot = `${path.dirname(configFilePath)}/${configName}/${configName}`;
    return config;
};
