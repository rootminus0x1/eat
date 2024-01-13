import * as yaml from 'js-yaml'; // config files are in yaml
import yargs from 'yargs/yargs';
import lodash from 'lodash';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { Format, getConfig, write, writeYaml } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { Blockchain } from './Blockchain';
import { dig, digGraph } from './dig';
import { Measurement, calculateDeltaMeasures, calculateMeasures, setupActions } from './delve';
import { Contract, ContractTransactionResponse, MaxInt256, MaxUint256, formatUnits, parseEther } from 'ethers';
import { ensureDirectory } from './eat-cache';
import { ethers } from 'hardhat';
import { any } from 'hardhat/internal/core/params/argumentTypes';

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

        const formatFromConfig = (address: any): any => {
            // "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"
            if (typeof address === 'object' && typeof address.measurements === 'object') {
                let newAddress: any = undefined;
                address.measurements.forEach((measurement: Measurement, index: number) => {
                    if (measurement && config.format && (measurement.value || measurement.delta)) {
                        for (const anyformat of config.format) {
                            const format: Format = anyformat; // TODO: make config fully typed
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
                                if (format.unit) {
                                    const formatByUnits = (field: string) => {
                                        newAddress.measurements[index][field] = formatUnits(
                                            (measurement as any)[field] as bigint, // << this should handle bigint[] too
                                            format.unit,
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

        const actions = await setupActions(config, graph, blockchain);

        for (const [name, action] of actions) {
            let error: string | undefined = undefined;
            let gas: bigint | undefined = undefined;
            try {
                let tx = await action();
                let receipt = await tx.wait();
                gas = receipt ? receipt.gasUsed : MaxInt256;
            } catch (e: any) {
                error = e.message; // failure
            }

            const allActionedMeasurements = await calculateMeasures(graph);
            // TODO: add in the measure name, gas etc.
            allActionedMeasurements.unshift({
                name: name,
                addressName: 'address', // foreign key
                userName: 'user',
                functionName: 'func',
                arguments: ['hello', 'world'],
                error: error,
                gas: gas,
            });
            // need to know the contact, etc.

            const allDeltaMeasurements = calculateDeltaMeasures(allBaseMeasurements, allActionedMeasurements);
            writeYaml(config, `${name}.measures.delta.yml`, allDeltaMeasurements, formatFromConfig);

            writeYaml(config, `${name}.measures.yml`, allActionedMeasurements, formatFromConfig);

            console.log(`${name}: result: ${error ? error : '\\o/ gas:' + gas}`);
        }
    }
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
