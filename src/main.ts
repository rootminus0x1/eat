import * as fs from 'fs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';
import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { getConfig } from './config';
import { outputFooterMermaid, outputGraphNodeMermaid, outputHeaderMermaid } from './mermaid';
import { asDateString } from './datetime';
import { EATAddress } from './EATAddress';
import { dig } from './dig';
import { Link, allLinks, allNodes } from './graph';

async function main() {
    const config = getConfig();
    const outputFile = fs.createWriteStream(config.outputFileRoot + '.md', { encoding: 'utf-8' });

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let block = await ethers.provider.getBlockNumber();

    outputHeaderMermaid(outputFile, block, asDateString((await ethers.provider.getBlock(block))?.timestamp || 0));

    const done = new Set<string>();
    let addresses = config.start;
    while (addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const stopper = config.stopafter.includes(address);
            const promise = (async (): Promise<void> => {
                const graphNode = new EATAddress(address);
                let nodeLinks: Link[] = [];
                if (!stopper && (await graphNode.isContract())) {
                    nodeLinks = await dig(graphNode);
                }

                // TODO: make this a map
                for (let link of nodeLinks) {
                    // don't follow zero addresses, but we want to diagram them, maybe
                    if (link.toAddress !== ZeroAddress) {
                        addresses.push(link.toAddress);
                    }
                }
                await outputGraphNodeMermaid(outputFile, graphNode, nodeLinks, stopper);
            })();
            await promise;
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
