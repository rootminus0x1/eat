import * as fs from 'fs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers, network } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';

import { getConfig } from './config';
import { outputFooterMermaid, outputGraphNodeMermaid, outputHeaderMermaid } from './mermaid';
import { asDateString } from './datetime';
import { dig, digDeep, DigDeepResults, NumericFunction } from './dig';
import { Link, allLinks, allNodes } from './graph';
import { PAMSystem, PAMRunner } from './PokeAndMeasure';

async function main() {
    const config = getConfig();
    const outputFile = fs.createWriteStream(config.outputFileRoot + '.md', { encoding: 'utf-8' });

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let blockNumber = await ethers.provider.getBlockNumber();
    const timestamp = (await ethers.provider.getBlock(blockNumber))?.timestamp || 0;
    console.log(`${network.name} ${blockNumber} ${asDateString(timestamp)} UX:${timestamp}`);

    const done = new Set<string>();
    let addresses = config.start;
    // spider across the blockchain, following addresses contained in contracts, until we stop or are told to stop
    // we build up the graph structure as we go for future processing
    const allMeasures: NumericFunction[] = [];
    while (addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const graphNode = dig(address);
            if (graphNode) {
                allNodes.set(address, graphNode);
                if (!config.stopafter.includes(address)) {
                    const digResults = await digDeep(graphNode);
                    allLinks.set(address, digResults.links);
                    digResults.links.forEach((link) => addresses.push(link.toAddress));

                    allMeasures.push(...digResults.numerics);
                }
            }
        }
    }

    // output a diagrem
    // TODO: add this to the config/command line
    outputHeaderMermaid(outputFile, blockNumber, asDateString(timestamp));
    for (const [address, node] of allNodes) {
        await outputGraphNodeMermaid(outputFile, node, allLinks.get(address), config.stopafter.includes(address));
    }
    outputFooterMermaid(outputFile);
    outputFile.end();

    // delve
    const system = new PAMSystem();
    for (const measure of allMeasures) {
        system.defCalculation(measure.measureName, measure.measure);
    }

    const delver = new PAMRunner(system, [], []);
    await delver.data();

    await delver.done(config.outputFileRoot);
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
