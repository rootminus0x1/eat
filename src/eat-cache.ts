import * as fs from 'fs';
import { ensureDirectory, getConfig } from './config';

const cachePath = (key: string): string => {
    return getConfig().cacheRoot + '/' + Buffer.from(key).toString('base64');
};

export const getCachedValue = async (key: string): Promise<string | undefined> => {
    // get the value
    const path = cachePath(key);
    ensureDirectory(path);
    return fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : undefined;
};

export const saveCacheValue = async (key: string, value: string) => {
    fs.writeFileSync(cachePath(key), value);
};
