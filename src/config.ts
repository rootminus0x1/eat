import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml'; // config files are in yaml
import { ensureDirectory } from './eat-cache';

export const getConfig = (): any[] => {
    const result = [];
    for (const configFileArg of process.argv.slice(2)) {
        let configFilePath = path.resolve(configFileArg);
        const config: any = yaml.load(fs.readFileSync(configFilePath).toString());
        const configName = path.basename(configFilePath, path.extname(configFilePath));
        config.outputFileRoot = `${path.dirname(configFilePath)}/${configName}/${configName}`;
        ensureDirectory(config.outputFileRoot);
        result.push(config);
    }
    return result;
};
