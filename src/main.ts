import * as yaml from 'js-yaml'; // config files are in yaml
import yargs from 'yargs/yargs';
import lodash from 'lodash';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { getConfig, write, writeYaml } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { Blockchain } from './Blockchain';
import { digGraph } from './dig';
import { Measurement, calculateDeltaMeasures, calculateMeasures } from './delve';
import { ContractTransactionResponse, MaxInt256, MaxUint256, formatUnits, parseEther } from 'ethers';
import { ensureDirectory } from './eat-cache';
import { ethers } from 'hardhat';

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

        const formatFromConfig = (address: any): any => {
            // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
            if (typeof address === 'object' && typeof address.measurements === 'object') {
                let newAddress: any = undefined;
                address.measurements.forEach((measurement: Measurement, index: number) => {
                    if (measurement && config.format && (measurement.value || measurement.delta)) {
                        for (const format of config.format) {
                            // TODO: could some things,
                            // like timestamps be represented as date/times
                            // or numbers
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
                                    const formatByUnits = (field: string) => {
                                        newAddress.measurements[index][field] = formatUnits(
                                            (measurement as any)[field] as bigint, // << this should handle bigint[] too
                                            format.digits,
                                        );
                                    };
                                    // TODO: make this more dynamic
                                    if (measurement.value) formatByUnits('value');
                                    if (measurement.delta) formatByUnits('delta');
                                }
                                break; // only do one format, the first
                            }
                        }
                    }
                });
                return newAddress;
            }
        };

        const allBaseMeasurements = await calculateMeasures(graph);
        writeYaml(config, 'measures.yml', allBaseMeasurements, formatFromConfig);

        // get all the things
        const contracts: any = {};
        for (const [name, address] of graph.namedAddresses) {
            contracts[name] = await graph.nodes.get(address)?.getContract();
        }

        // get all the users
        const users: any = {};
        if (config.users) {
            for (const name of config.users) {
                users[name] = await blockchain.getUser(name);
            }
            // TODO: make the users do something under config
            // get some stETH for some users and let market use it
            const stEthWhale = await ethers.getImpersonatedSigner('0x95ed9BC02Be94C17392fE819A93dC57E73E1222E');
            for (const user of [users.fMinter, users.xMinter]) {
                if (!(await contracts.Lido.connect(stEthWhale).transfer(user.address, parseEther('10')))) {
                    throw Error('could not get enough stETH, find another whale');
                }
                await contracts.Lido.connect(user).approve(contracts.Market.address, MaxUint256);
            }

            type ActionFunction = () => Promise<ContractTransactionResponse>;
            const allActions = new Map<string, ActionFunction>();

            allActions.set('fMinter_mint_1ETH', async () => {
                // TODO: add actions to config
                //return market.mintFToken((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
                return contracts.Market.connect(users.fMinter).mintFToken(parseEther('1'), users.fMinter.address, 0n);
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

                const allActionedMeasurements = await calculateMeasures(graph);

                const allDeltaMeasurements = calculateDeltaMeasures(allBaseMeasurements, allActionedMeasurements);
                writeYaml(config, `${name}.measures.delta.yml`, allDeltaMeasurements, formatFromConfig);
                // TODO: add in the measure name, gas etc.
                // need to know the contact, etc.

                writeYaml(config, `${name}.measures.yml`, allActionedMeasurements, formatFromConfig);

                console.log(`${name}: result: ${result}, gas:${actionGas}`);
            }
        }
    }
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
