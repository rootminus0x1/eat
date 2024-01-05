import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers, network } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';

import { getConfig } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { dig, digDeep, DigDeepResults } from './dig';
import { allNodes, Link, allLinks, Measure, allMeasures } from './graph';
import { PAMSystem, PAMRunner } from './PokeAndMeasure';
import { BlockchainAddress } from './BlockchainAddress';
import { calculateAllMeasures } from './delve';

async function main() {
    const config = getConfig();

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let blockNumber = await ethers.provider.getBlockNumber();
    const timestamp = (await ethers.provider.getBlock(blockNumber))?.timestamp || 0;
    console.log(`${network.name} ${blockNumber} ${asDateString(timestamp)} UX:${timestamp}`);

    const done = new Set<string>();
    let addresses = config.start;
    // spider across the blockchain, following addresses contained in contracts, until we stop or are told to stop
    // we build up the graph structure as we go for future processing

    while (addresses.length) {
        const address = addresses[0];
        addresses.shift();
        if (!done.has(address)) {
            done.add(address);
            const BlockchainAddress = dig(address);
            if (BlockchainAddress) {
                const stopper = config.stopafter.includes(address);
                allNodes.set(address, Object.assign({ stopper: stopper }, BlockchainAddress));
                if (!stopper) {
                    const digResults = await digDeep(BlockchainAddress);
                    allLinks.set(address, digResults.links);
                    digResults.links.forEach((link) => addresses.push(link.to));

                    allMeasures.set(address, digResults.measures);
                }
            }
        }
    }

    // output a diagrem
    // TODO: add this output to the config/command line
    // TODO: factor out writing files, all it needs is a function to generate a string
    const diagramOutputFile = fs.createWriteStream(config.outputFileRoot + '.md', { encoding: 'utf-8' });
    diagramOutputFile.write(await mermaid(blockNumber, asDateString(timestamp)));
    diagramOutputFile.end();

    // delve
    /*
    const system = new PAMSystem();
    for (const [address, measures] of allMeasures) {
        const node = allNodes.get(address);
        for (const measure of measures) {
            system.defCalculation(`${await node?.name()}.${measure.name}`, measure.calculation);
        }
    }

    const delver = new PAMRunner(system, [], []);
    await delver.data();

    await delver.done(config.outputFileRoot);
    */

    const measuresOutputFile = fs.createWriteStream(config.outputFileRoot + '-measures.yml', { encoding: 'utf-8' });
    const results = await calculateAllMeasures();
    measuresOutputFile.write(yaml.dump(results));
    measuresOutputFile.end();
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
