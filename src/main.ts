import * as fs from 'fs';
import * as yaml from 'js-yaml'; // config files are in yaml
import yargs from 'yargs/yargs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers, network } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

import { getConfig } from './config';
import { mermaid } from './mermaid';
import { asDateString } from './datetime';
import { dig, digDeep, DigDeepResults } from './dig';
import { Graph } from './graph';
import { calculateMeasures } from './delve';
import { ContractTransactionResponse, isAddress, MaxInt256, parseEther } from 'ethers';
import { ensureDirectory } from './eat-cache';

class Blockchain {
    private allSigners = ethers.getSigners();
    private allocatedSigners = 0;

    public timestamp = 0;

    constructor(public blockNumber: number) {}

    public getUser = async (name: string): Promise<SignerWithAddress> => {
        await this.allSigners;
        return (await this.allSigners)[this.allocatedSigners++] as SignerWithAddress;
    };

    public reset = async (quiet: boolean) => {
        await reset(process.env.MAINNET_RPC_URL, this.blockNumber);
        this.blockNumber = await ethers.provider.getBlockNumber();
        this.timestamp = (await ethers.provider.getBlock(this.blockNumber))?.timestamp || 0;
        if (!quiet)
            console.log(`${network.name} ${this.blockNumber} ${asDateString(this.timestamp)} UX:${this.timestamp}`);
    };
}

async function main() {
    // process the command line
    const argv: any = yargs(process.argv.slice(2))
        .options({
            nodiagram: { type: 'boolean', default: false },
            nomeasures: { type: 'boolean', default: false },
            showconfig: { type: 'boolean', default: false },
            quiet: { type: 'boolean', default: false },
            defaultconfig: { type: 'string', default: 'test/default-config.yml' },
        })
        .parse();

    const configs = getConfig(argv._, argv.defaultconfig);
    for (const config of configs) {
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
        const done = new Set<string>();
        let addresses = config.start;

        const graph = new Graph();
        while (addresses && addresses.length) {
            const address = addresses[0];
            addresses.shift();
            if (!done.has(address)) {
                done.add(address);
                const blockchainAddress = dig(address);
                if (blockchainAddress) {
                    const stopper = config.stopafter?.includes(address);
                    const name =
                        (await blockchainAddress.erc20Symbol()) ||
                        (await blockchainAddress.implementationContractName()) ||
                        (await blockchainAddress.contractName()) ||
                        ((await blockchainAddress.isAddress())
                            ? address.slice(0, 5) + '..' + address.slice(-3)
                            : address);

                    graph.nodes.set(address, Object.assign({ name: name, stopper: stopper }, blockchainAddress));

                    if (!stopper) {
                        const digResults = await digDeep(blockchainAddress);
                        // set the links
                        graph.links.set(address, digResults.links);
                        // and backlinks
                        digResults.links.forEach((link) =>
                            graph.backLinks.set(
                                link.address,
                                (graph.backLinks.get(link.address) ?? []).concat({ address: address, name: link.name }),
                            ),
                        );

                        // add more addresses to be dug up
                        digResults.links.forEach((link) => addresses.push(link.address));
                        graph.measures.set(address, digResults.measures);
                    }
                }
            }
        }

        // output a diagram
        // TODO: add this output to the config/command line
        if (!config.nodiagram) {
            const diagramOutputFile = fs.createWriteStream(config.outputFileRoot + config.configName + '-diagram.md', {
                encoding: 'utf-8',
            });
            diagramOutputFile.write(
                await mermaid(graph, blockchain.blockNumber, asDateString(blockchain.timestamp), config.diagram),
            );
            diagramOutputFile.end();
        }

        // make node names unique
        const nodeNames = new Map<string, string[]>();
        for (const [address, node] of graph.nodes) {
            nodeNames.set(node.name, (nodeNames.get(node.name) ?? []).concat(address));
        }
        for (const [name, addresses] of nodeNames) {
            if (addresses.length > 1) {
                //console.log(`${name} is used for ${addresses}`);
                // find the links to get some name for them
                let unique = 0;
                for (const address of addresses) {
                    const node = graph.nodes.get(address);
                    if (node) {
                        //console.log(`for ${address},`);
                        const backLinks = graph.backLinks.get(address);
                        let done = false;
                        if (backLinks && backLinks.length == 1) {
                            const index = backLinks[0].name.match(/\[\d+\]$/);
                            if (index && index.length == 1) {
                                node.name += index[0];
                                done = true;
                            }
                        }
                        if (!done) {
                            node.name += `_${unique}`;
                            unique++;
                        }
                        //console.log(`${address} name becomes '${node.name}'`);
                    }
                }
            }
        }

        const measuresOutputFile = fs.createWriteStream(config.outputFileRoot + config.configName + '-measures.yml', {
            encoding: 'utf-8',
        });
        const results = await calculateMeasures(graph);
        measuresOutputFile.write(yaml.dump(results));
        measuresOutputFile.end();

        let allSigners = ethers.getSigners();
        let allocatedSigners = 0;

        async function getUser(name: string): Promise<SignerWithAddress> {
            return (await allSigners)[allocatedSigners++];
            //console.log("%s = %s", signer.address, name);
            //return Object.assign(signer, { name: name }) as UserWithAddress;
        }

        // get all the users
        const allUsers = new Map<string, SignerWithAddress>();
        if (config.users)
            for (const name of config.users) {
                allUsers.set(name, await getUser(name));
            }
        type ActionFunction = () => Promise<ContractTransactionResponse>;
        const allActions = new Map<string, ActionFunction>();

        allActions.set('fMinter.mint(1 ETH)', async () => {
            const fMinter = allUsers.get('fMinter');
            if (!fMinter) throw Error('could not find fMinter user');

            /*
        const treasuryNode = graph.nodes.get("stETHTreasury");
        if (! treasuryNode) throw Error("could not find stETHTreasury contract");
        const treasury: any = treasuryNode.getContract(fMinter);
        // TODO: access the Calculation for this
        const fNav = await treasury.getCurrentNav().then((res: any) => res._fNav);
        */

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
