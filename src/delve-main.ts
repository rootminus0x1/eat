import * as fs from 'fs';

import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { parseEther } from 'ethers';

import { ethers } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';

import { getConfig } from './config';
import { ContractWithAddress, UserWithAddress, deploy, getUser, getContract } from './blockchain';

import { DelveSetup, Delver } from './delve';

async function main() {
    const config = getConfig();

    await reset(process.env.MAINNET_RPC_URL, config.block);
    let block = await ethers.provider.getBlockNumber();
    // asDatetime((await ethers.provider.getBlock(block))?.timestamp || 0));

    // TODO: revisit aliases
    let setup = new DelveSetup(
        new Map([
            ['FractionalToken', 'fToken'],
            ['LeveragedToken', 'xToken'],
        ]),
    );

    // TODO: make all users part of setup and add them via config
    let fMinter = await getUser('fMinter');

    // TODO: make all contracts part of setup and add them via config
    let treasury = await getContract('0x0e5CAA5c889Bdf053c9A76395f62267E653AFbb0');
    let fToken = await getContract('0x53805A76E1f5ebbFE7115F16f9c87C2f7e633726');

    /*
    // define types
    let tokenHolder = setup.defType('tokenHolder');
    let token = setup.defType('token');

    let market = await getContract('0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB');

    let fMint = setup.defAction('fMinter.mint(100)', async () => {
        // TODO: access the Calculation for this
        // let fNav = await treasury["getCurrentNav"]().then((res) => res._fNav);
        return market['mintFToken'](parseEther('100'), fMinter.address, 0n);
        // return market.connect(fMinter)["mintFToken"]((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
    });
    */

    // TODO: set up variables from config, and access it via setup (maybe rename setup)
    let ethPrice = setup.defVariable('ethPrice', parseEther('2000'));

    setup.defCalculation('FractionalToken.nav', async () => {
        return treasury['getCurrentNav']().then((res) => res._fNav);
    });

    // TODO: setup should do this automatically for all things of type token holder
    setup.defCalculation('fMinter.FractionalToken', async () => {
        return fToken['balanceOf'](fMinter.address);
    });

    let delver = new Delver(setup, [ethPrice], []);
    await delver.data();

    await delver.done(config.outputFileRoot);

    /*
    // define users, tokens


    defThing(FractionalToken, token);

    // define actions, taken by users, on contracts
    let fMint = defAction('fMint', async () => {});

    // define measures: tokens, users, calls on contracts
    defRelation(tokenHolder, {
        name: 'has',
        calc: (a: any, b: any) => {
            return b.balanceOf(a);
        },
    });
    */
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
