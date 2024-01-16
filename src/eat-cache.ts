import * as fs from 'fs';
import { ensureDirectory } from './config';

const cacheDir = './eat-cache';

const cachePath = (key: string): string => {
    return cacheDir + '/' + Buffer.from(key).toString('base64');
};

export const getCachedValue = async (key: string): Promise<string | undefined> => {
    ensureDirectory(cacheDir);
    // get the value
    const path = cachePath(key);
    return fs.existsSync(path) ? fs.readFileSync(path, 'utf-8') : undefined;
};

export const saveCacheValue = async (key: string, value: string) => {
    fs.writeFileSync(cachePath(key), value);
};
