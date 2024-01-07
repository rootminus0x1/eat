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
import { allNodes, Link, allLinks, Measure, allMeasures, graphNode, allBackLinks } from './graph';
import { BlockchainAddress } from './BlockchainAddress';
import { calculateAllMeasures } from './delve';
import { ContractTransactionResponse, isAddress, MaxInt256, parseEther } from 'ethers';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';

async function main() {
    const configs = getConfig();
    for (const config of configs) {
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

                    allNodes.set(address, Object.assign({ name: name, stopper: stopper }, blockchainAddress));

                    if (!stopper) {
                        const digResults = await digDeep(blockchainAddress);
                        // set the links
                        allLinks.set(address, digResults.links);
                        // and backlinks
                        digResults.links.forEach((link) =>
                            allBackLinks.set(
                                link.address,
                                (allBackLinks.get(link.address) ?? []).concat({ address: address, name: link.name }),
                            ),
                        );

                        // add more addresses to be dug up
                        digResults.links.forEach((link) => addresses.push(link.address));
                        allMeasures.set(address, digResults.measures);
                    }
                }
            }
        }

        // output a diagram
        // TODO: add this output to the config/command line
        // TODO: factor out writing files, all it needs is a function to generate a string
        const diagramOutputFile = fs.createWriteStream(config.outputFileRoot + '-diagram.md', { encoding: 'utf-8' });
        diagramOutputFile.write(await mermaid(blockNumber, asDateString(timestamp)));
        diagramOutputFile.end();

        // make node names unique
        const nodeNames = new Map<string, string[]>();
        for (const [address, node] of allNodes) {
            nodeNames.set(node.name, (nodeNames.get(node.name) ?? []).concat(address));
        }
        for (const [name, addresses] of nodeNames) {
            if (addresses.length > 1) {
                //console.log(`${name} is used for ${addresses}`);
                // find the links to get some name for them
                let unique = 0;
                for (const address of addresses) {
                    const node = allNodes.get(address);
                    if (node) {
                        //console.log(`for ${address},`);
                        const backLinks = allBackLinks.get(address);
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

        const measuresOutputFile = fs.createWriteStream(config.outputFileRoot + '-measures.yml', { encoding: 'utf-8' });
        const results = await calculateAllMeasures();
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
        const treasuryNode = allNodes.get("stETHTreasury");
        if (! treasuryNode) throw Error("could not find stETHTreasury contract");
        const treasury: any = treasuryNode.getContract(fMinter);
        // TODO: access the Calculation for this
        const fNav = await treasury.getCurrentNav().then((res: any) => res._fNav);
        */

            const marketNode = allNodes.get('0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB');
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
