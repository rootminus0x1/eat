import * as fs from 'fs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { ethers } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';
import { Contract, FunctionFragment, ZeroAddress, TransactionReceipt } from 'ethers';

import { getConfig } from './config';
import { EatContract } from './eatcontract';

async function main() {
    const config = getConfig();
    const outputFilePath = config.outputFileRoot + '.md';
    const outputFile = fs.createWriteStream(config.outputFileRoot + '.csv', { encoding: 'utf-8' });

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let block = await ethers.provider.getBlockNumber();
    // asDatetime((await ethers.provider.getBlock(block))?.timestamp || 0));

    outputFile.end();
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
