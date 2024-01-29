import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { setupBlockchain } from './Blockchain';
import { dig } from './dig';
import { delve } from './delve';

async function main() {
    await setupBlockchain();

    await dig();

    await delve();
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Error: %s', error);
        process.exit(1);
    });
