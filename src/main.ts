import * as fs from 'fs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';

import { getConfig } from './config';
import { outputFooterMermaid, outputGraphNodeMermaid, outputHeaderMermaid } from './mermaid';
import { asDateString } from './datetime';
import { dig, digDeep } from './dig';
import { Link, allLinks, allNodes } from './graph';

async function main() {
    const config = getConfig();
    const outputFile = fs.createWriteStream(config.outputFileRoot + '.md', { encoding: 'utf-8' });

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let block = await ethers.provider.getBlockNumber();

    outputHeaderMermaid(outputFile, block, asDateString((await ethers.provider.getBlock(block))?.timestamp || 0));

    const done = new Set<string>();
    let addresses = config.start;
    // spider across the blockchain, following addresses contained in contracts, until we stop or are told to stop
    // we build up the graph structure as we go for future processing
    while (addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const stopper = config.stopafter.includes(address);
            const graphNode = dig(address);
            if (graphNode) {
                allNodes.set(address, graphNode);
                let nodeLinks: Link[] = [];
                if (!stopper) {
                    nodeLinks = await digDeep(graphNode);
                    allLinks.set(address, nodeLinks);
                    nodeLinks.forEach((link) => addresses.push(link.toAddress));
                }
                await outputGraphNodeMermaid(outputFile, graphNode, nodeLinks, stopper);
            }
        }
    }

    outputFooterMermaid(outputFile);
    outputFile.end();
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
