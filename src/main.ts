import yargs from 'yargs/yargs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { getConfig, write } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { Blockchain } from './Blockchain';
import { digGraph } from './dig';
import { setupActions, calculateActions } from './delve';
import { ensureDirectory } from './eat-cache';
import { parseEther } from 'ethers';

async function main() {
    // process the command line
    const argv: any = yargs(process.argv.slice(2))
        .options({
            nodiagram: { type: 'boolean', default: false },
            nomeasures: { type: 'boolean', default: false },
            showconfig: { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
            defaultconfigs: { type: 'string', default: 'test/default-configs' },
        })
        .parse();

    for (const config of getConfig(argv._, argv.defaultconfigs)) {
        if (!config.quiet) console.log(`config: ${config.configName}  from ${config.configFilePath}`);
        if (argv.showconfig) {
            console.log(config);
            break;
        }

        ensureDirectory(config.outputFileRoot);

        const blockchain = new Blockchain(config.block);
        // TODO: make this work when disconnected
        await blockchain.reset(config.quiet);

        // spider across the blockchain, following addresses contained in contracts, until we stop or are told to stop
        // we build up the graph structure as we go for future processing

        const graph = await digGraph(config.start, config.stopafter);

        // output a diagram
        if (!config.nodiagram) {
            write(
                config,
                'diagram.md',
                await mermaid(graph, blockchain.blockNumber, asDateString(blockchain.timestamp), config.diagram),
            );
        }

        const [actions, contracts, users] = await setupActions(config, graph, blockchain);

        actions.set('fMinter_mint_1ETH', async () => {
            // TODO: add actions to config
            //return market.mintFToken((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
            return contracts.Market.connect(users.fMinter).mintFToken(parseEther('1'), users.fMinter.address, 0n);
        });

        calculateActions(actions, config, graph);
    }
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
