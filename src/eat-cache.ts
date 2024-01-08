import * as fs from 'fs';

const cacheDir = './eat-cache';

const cachePath = (key: string): string => {
    return cacheDir + '/' + Buffer.from(key).toString('base64');
};

export const ensureDirectory = async (dir: string) => {
    // ensure the cache directory exists
    try {
        // Check if the directory already exists
        await fs.promises.access(dir);
    } catch (error: any) {
        // If the directory doesn't exist, create it
        if (error.code === 'ENOENT') {
            await fs.promises.mkdir(dir, { recursive: true });
        } else {
            // If there was an error other than the directory not existing, throw the error
            throw error;
        }
    }
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
