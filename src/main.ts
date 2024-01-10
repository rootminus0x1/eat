import * as yaml from 'js-yaml'; // config files are in yaml
import yargs from 'yargs/yargs';
import lodash from 'lodash';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

import { getConfig, write, writeYaml } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { Blockchain } from './Blockchain';
import { digGraph } from './dig';
import { Measurement, calculateMeasures } from './delve';
import { ContractTransactionResponse, MaxInt256, formatEther, parseEther } from 'ethers';
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

        const formatUint256 = (value: any): any => {
            // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
            if (typeof value === 'object' && typeof value.measurements === 'object') {
                value = lodash.cloneDeep(value);
                for (const name of Object.keys(value.measurements)) {
                    // value.contract
                    const measurement = value.measurements[name];
                    if (measurement.type === 'uint256') {
                        measurement.value = formatEther(measurement.value);
                    }
                }
                return value;
            }
        };

        const formatFromConfig = (address: any): any => {
            // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
            if (typeof address === 'object' && typeof address.measurements === 'object') {
                let newAddress: any = undefined;
                address.measurements.forEach((measurement: Measurement, index: number) => {
                    // TODO: work out why we need an "as any" below (2 places)
                    if ((measurement as any).value && config.format && measurement)
                        for (const format of config.format) {
                            if (
                                (!format.type || format.type === measurement.type) &&
                                (!format.name || format.name === measurement.name) &&
                                (!format.contract || format.contract === address.contract)
                            ) {
                                // we're about to change it so clone it
                                if (!newAddress) newAddress = lodash.cloneDeep(address);
                                // TODO: handle values that are arrays
                                // we have a match - so what kind of formatting
                                if (format.digits) {
                                    newAddress.measurements[index].value = formatEther((measurement as any).value);
                                    break; // only do one format, the first
                                }
                            }
                        }
                });
                return newAddress;
            }
        };

        const allMeasuresUnformatted = await calculateMeasures(graph);
        // const allMeasures = lodash.cloneDeepWith(allMeasuresUnformatted, );

        writeYaml(config, 'measures.yml', allMeasuresUnformatted, formatFromConfig);
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
