import * as yaml from 'js-yaml'; // config files are in yaml
import yargs from 'yargs/yargs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

import { getConfig, write, writeYaml } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { Blockchain } from './Blockchain';
import { digGraph } from './dig';
import { calculateMeasures } from './delve';
import { ContractTransactionResponse, MaxInt256, parseEther } from 'ethers';
import { ensureDirectory } from './eat-cache';

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

        writeYaml(config, 'measures.yml', await calculateMeasures(graph));

        // get all the users
        const allUsers = new Map<string, SignerWithAddress>();
        if (config.users)
            for (const name of config.users) {
                allUsers.set(name, await blockchain.getUser(name));
            }
        type ActionFunction = () => Promise<ContractTransactionResponse>;
        const allActions = new Map<string, ActionFunction>();

        allActions.set('fMinter.mint(1 ETH)', async () => {
            const fMinter = allUsers.get('fMinter');
            if (!fMinter) throw Error('could not find fMinter user');

            // const treasuryNode = graph.nodes.get("stETHTreasury");
            // if (! treasuryNode) throw Error("could not find stETHTreasury contract");
            // const treasury: any = treasuryNode.getContract(fMinter);
            // // TODO: access the Calculation for this
            // const fNav = await treasury.getCurrentNav().then((res: any) => res._fNav);
            //

            const marketNode = graph.nodes.get('0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB');
            if (!marketNode) throw Error('could not find Market contract');
            const market = await marketNode.getContract(fMinter);

            //return market.mintFToken((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
            return market.mintFToken(parseEther('1'), fMinter.address, 0n);
        });

        for (const [name, action] of allActions) {
            let result = '-';
            let actionGas = 0n;
            try {
                let tx = await action();
                let receipt = await tx.wait();
                actionGas = receipt ? receipt.gasUsed : MaxInt256;
                result = '\\o/'; // success
            } catch (e: any) {
                result = e.message; // failure
            }

            console.log(`${name}: result: ${result}, gas:${actionGas}`);
        }
    }
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
