import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { getConfig, write } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { setupBlockchain } from './Blockchain';
import { dig } from './dig';
import { delve } from './delve';
import { ensureDirectory } from './eat-cache';

async function main() {
    // TODO: move more into config
    ensureDirectory(getConfig().outputFileRoot);

    const timestamp = await setupBlockchain(getConfig().block, false);

    // spider across the blockchain, following addresses contained in contracts, until we stop or are told to stop
    // we build up the graph structure as we go for future processing

    await dig();

    // output a diagram
    write('diagram.md', await mermaid(getConfig().block, asDateString(timestamp), getConfig().diagram));

    await delve();
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
