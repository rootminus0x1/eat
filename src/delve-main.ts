import * as dotenv from 'dotenv';
import * as dotenvExpand from 'dotenv-expand';
dotenvExpand.expand(dotenv.config());

import { parseEther, formatEther, MaxUint256, Wallet } from 'ethers';

import { ethers, network } from 'hardhat';
import { reset } from '@nomicfoundation/hardhat-network-helpers';

import { getConfig } from './config';
import { ContractWithAddress, UserWithAddress, deploy, getContract } from './blockchain';
import { asDatetime } from './datetime';
import { PAMSystem, PAMRunner } from './PokeAndMeasure';
import { addUser } from './delve';

async function main() {
    const config = getConfig();

    await reset(process.env.MAINNET_RPC_URL, config.block);
    const block = await ethers.provider.getBlockNumber();
    const dt = asDatetime((await ethers.provider.getBlock(block))?.timestamp || 0);
    console.log(`${network.name} ${block} ${dt}`);

    /* replacement contracts
    // FractionalToken.sol
    let fToken: ContractWithAddress<FractionalToken>;
    // FxVault.sol
    // HarvestableTreasury.sol
    // LeveragedToken.sol
    let xToken: ContractWithAddress<LeveragedToken>;
    // Market.sol
    // TODO: Aladdin uses FxMarket, not Market, with 0 as RebalancePoolRegistry
    let market: ContractWithAddress<Market>;
    // RebalancePool.sol
    let rebalancePool: ContractWithAddress<RebalancePool>;
    // ReservePool.sol
    let reservePool: ContractWithAddress<ReservePool>;
    // StableCoinMath.sol
    // Treasury.sol
    let treasury: ContractWithAddress<Treasury>;
    // WrappedTokenTreasury.sol

    // oracle/FxETHTwapOracle.sol
    // rate-provider/ChainlinkWstETHRateProvider.sol
    // rate-provider/wBETHRateProvider.sol
    // rebalancer/RebalanceWithBonusToken.sol

    // steth/stETHGateway.sol
    // steth/stETHTreasury.sol

    // wrapper/FxTokenBalancerV2Wrapper.sol
    // wrapper/wstETHWrapper.sol


    let index = system.defVariable('index', parseEther('0'));
    let ethPrice = system.defVariable('ethPrice', parseEther('2000'));

    // stability mode triggers
    let stabilityRatio = system.defVariable('stabilityRatio', parseEther('1.3'));
    let liquidationRatio = system.defVariable('liquidationRatio', parseEther('1.2'));
    let selfLiquidationRatio = system.defVariable('selfLiquidationRatio', parseEther('1.14'));
    let recapRatio = system.defVariable('recapRatio', parseEther('1'));
    let rebalancePoolliquidatableRatio = system.defVariable('rebalancePoolliquidatableRatio', parseEther('1.3055'));

    // Fees
    let fTokenMintFeeDefault = system.defVariable('fTokenMintFeeDefault', parseEther('0.0025'));
    let fTokenMintFeeExtra = system.defVariable('fTokenMintFeeExtra', parseEther('0'));
    let fTokenRedeemFeeDefault = system.defVariable('fTokenRedeemFeeDefault', parseEther('0.0025'));
    let fTokenRedeemFeeExtra = system.defVariable('fTokenRedeemFeeExtra', parseEther('-0.0025'));

    let xTokenMintFeeDefault = system.defVariable('xTokenMintFeeDefault', parseEther('0.01'));
    let xTokenMintFeeExtra = system.defVariable('xTokenMintFeeExtra', parseEther('-0.01'));
    let xTokenRedeemFeeDefault = system.defVariable('xTokenRedeemFeeDefault', parseEther('0.01'));
    let xTokenRedeemFeeExtra = system.defVariable('xTokenRedeemFeeExtra', parseEther('0.07'));

    let rebalancePoolLiquidation = system.defAction('rebalancePool.liquidate(-1)', async () => {
      const deposited = await fToken.balanceOf(rebalancePool); // TODO: add a -1 input to liquidate function
      return rebalancePool.connect(liquidator).liquidate(deposited, 0n);
    });
    let fHolderLiquidation = system.defAction('fHolderLiquidate(-1)', async () => {
      const balance = await fToken.balanceOf(fHolderLiquidator);
      return market.connect(fHolderLiquidator).liquidate(balance, fHolderLiquidator.address, 0n);
    });
    let fMint = system.defAction('fMinter.mint(100)', async () => {
      // TODO: access the Calculation for this
      let fNav = await treasury.getCurrentNav().then((res) => res._fNav);
      return market.connect(fMinter).mintFToken((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
    });
    let fRedeem = system.defAction('fHolderRedeemer.Redeem(100)', async () => {
      return market.connect(fHolderRedeemer).redeem(parseEther('100'), 0n, fHolderRedeemer.address, 0n);
    });
    let xMint = system.defAction('xMinter.mint(100)', async () => {
      let xNav = await treasury.getCurrentNav().then((res) => res._xNav);
      return market.connect(xMinter).mintXToken((xNav * parseEther('100')) / ethPrice.value, xMinter.address, 0n);
    });
    let xRedeem = system.defAction('xHolderRedeemer.Redeem(100)', async () => {
      return market.connect(xHolderRedeemer).redeem(0n, parseEther('100'), xHolderRedeemer.address, 0n);
    });



    let owner = system.defType('owner');

    beforeEach(async () => {

      system.defThing(platform, owner);




      xToken = await deploy('LeveragedToken', deployer);
      system.defThing(xToken, token);

      // TODO: upgradeable and constructors are incompatible (right?), so the constructor should be removed
      // and the ratio passed into the initialise function, or maybe the Market.mint() function?
      // both of these functions only get called once (check this), although the market can be changed so
      // could be called on each market... seems like an arbitrary thing that should maybe be designed out?
      treasury = await deploy('Treasury', deployer, parseEther('0.5')); // 50/50 split between f & x tokens
      market = await deploy('Market', deployer);

      rebalancePool = await deploy('RebalancePool', deployer);
      system.defThing(rebalancePool, owner);
      system.defThing(rebalancePool, token);
      reservePool = await deploy('ReservePool', deployer, market.address, fToken.address);
      system.defThing(reservePool, owner);


      await fToken.initialize(treasury.address, 'Fractional ETH', 'fETH');
      await xToken.initialize(treasury.address, fToken.address, 'Leveraged ETH', 'xETH');

      await treasury.initialize(
        market.address,
        weth.address,
        fToken.address,
        xToken.address,
        oracle.address,
        beta.initialValue,
        baseTokenCap.initialValue,
        ZeroAddress, // rate provider - used to convert between wrapped and unwrapped, 0 address means 1:1 ratio
      );

      await market.initialize(treasury.address, platform.address);
      await market.updateMarketConfig(
        stabilityRatio.initialValue,
        liquidationRatio.initialValue,
        selfLiquidationRatio.initialValue,
        recapRatio.initialValue,
      );

      if (fees.initialValue !== 0n) {
        // implement fees
        console.log('including fees');
        await market.updateMintFeeRatio(fTokenMintFeeDefault.initialValue, fTokenMintFeeExtra.initialValue, true);
        await market.updateRedeemFeeRatio(fTokenRedeemFeeDefault.initialValue, fTokenRedeemFeeExtra.initialValue, true);
        await market.updateMintFeeRatio(xTokenMintFeeDefault.initialValue, xTokenMintFeeExtra.initialValue, false);
        await market.updateRedeemFeeRatio(xTokenRedeemFeeDefault.initialValue, xTokenRedeemFeeExtra.initialValue, false);
      }

      // rebalance pool
      await rebalancePool.initialize(treasury, market);
      await rebalancePool.updateLiquidator(liquidator.address);
      await rebalancePool.updateLiquidatableCollateralRatio(rebalancePoolliquidatableRatio.initialValue);

      // reserve pool
      await market.updateReservePool(reservePool.address);

      system.initialise();
    });

    context('navsby', async () => {
      it('ethPrice', async () => {
        let rt = new RegressionTest(
          'Aladdin',
          rs,
          [index, ethPrice],
          [fMint, fRedeem, xMint, xRedeem, rebalancePoolLiquidation, fHolderLiquidation],
        );

        await oracle.setPrice(ethPrice.value);
        await treasury.initializePrice();

        // set up the market
        // allow initial mint
        await weth.deposit({ value: initialCollateral.initialValue });
        await weth.approve(market.address, MaxUint256);
        await market.mint(initialCollateral.value, platform.address, 0, 0);

        // fUser and rebalanceUser mintFTokens
        const fTokensEth = initialCollateral.initialValue / 2n;

        // TODO add to actions as an intialiser function
        await weth.connect(rebalanceUser).deposit({ value: fTokensEth / 4n });
        await weth.connect(rebalanceUser).approve(market.address, MaxUint256);
        await market.connect(rebalanceUser).mintFToken(MaxUint256, rebalanceUser.address, 0n);

        await weth.connect(fHolderLiquidator).deposit({ value: fTokensEth / 4n });
        await weth.connect(fHolderLiquidator).approve(market.address, MaxUint256);
        await market.connect(fHolderLiquidator).mintFToken(MaxUint256, fHolderLiquidator.address, 0n);

        await weth.connect(fHolderRedeemer).deposit({ value: fTokensEth / 4n });
        await weth.connect(fHolderRedeemer).approve(market.address, MaxUint256);
        await market.connect(fHolderRedeemer).mintFToken(MaxUint256, fHolderRedeemer.address, 0n);

        await weth.connect(fMinter).deposit({ value: fTokensEth / 4n });
        await weth.connect(fMinter).approve(market.address, MaxUint256);

        await weth.connect(xHolderRedeemer).deposit({ value: fTokensEth / 4n });
        await weth.connect(xHolderRedeemer).approve(market.address, MaxUint256);
        await market.connect(xHolderRedeemer).mintXToken(MaxUint256, xHolderRedeemer.address, 0n);

        await weth.connect(xMinter).deposit({ value: fTokensEth / 4n });
        await weth.connect(xMinter).approve(market.address, MaxUint256);

        // set up rebalance Pool
        await fToken.connect(rebalanceUser).approve(rebalancePool.address, MaxUint256);
        await rebalancePool.connect(rebalanceUser).deposit(MaxUint256, rebalanceUser.address);

        let maxIndex = parseEther('40');
        for (; index.value <= maxIndex; index.value += parseEther('1')) {
          // TODO: make this an action
          ethPrice.value = (ethPrice.initialValue * (maxIndex - index.value)) / maxIndex;
          await oracle.setPrice(ethPrice.value);

          await rt.data();
        }
*/

    let system = new PAMSystem();

    /////////////////////////
    // define types, relations between types and their actions
    let tokenHolder = system.defType('tokenHolder');
    let token = system.defType('token', [
        {
            name: 'supply',
            calc: (token: any) => {
                return token.totalSupply();
            },
        },
    ]);
    system.defRelation(tokenHolder, token, [
        {
            name: 'has',
            calc: (a: any, b: any) => {
                return b.balanceOf(a);
            },
        },
    ]);

    // TODO: make all users part of system and add them via config
    let deployer = await addUser(system, 'deployer'); // deploys all the contracts
    let admin = await addUser(system, 'admin'); // bao admin
    let liquidator = await addUser(system, 'liquidator'); // bot that liquidates the rebalancePool (somehow)
    let fMinter = await addUser(system, 'fMinter', [tokenHolder]); // user who mints fTokens
    let rebalanceUser = await addUser(system, 'rebalanceUser', [tokenHolder]); // mints fTokens and deposits in rebalancePool
    let fHolderLiquidator = await addUser(system, 'fHolderLiquidator', [tokenHolder]); // user who mints/liquidates fTokens
    let fHolderRedeemer = await addUser(system, 'fHolderRedeemer', [tokenHolder]); // user who mint/redeems fTokens
    let xMinter = await addUser(system, 'xMinter', [tokenHolder]); // user who mint/redeems xTokens
    let xHolderRedeemer = await addUser(system, 'xHolderRedeemer', [tokenHolder]); // user who mint/redeems xTokens

    let beta = system.defVariable('beta', parseEther('0.1'));
    let baseTokenCap = system.defVariable('baseTokenCap', parseEther('200'));
    let initialCollateral = system.defVariable('initialCollateral', parseEther('100'));
    let fees = system.defVariable('fees', 0n); // 1n to switch them on, 0n to switch them off
    //let additionalCollateral = (baseTokenCap - initialCollateral) / 100n;

    // TODO: this is the first deployed contract
    //const oracle = await deploy('MockFxPriceOracle', deployer);

    // TODO: make all contracts part of system and add them via config
    let treasury = await getContract('0x0e5CAA5c889Bdf053c9A76395f62267E653AFbb0', deployer);

    let fToken = await getContract('0x53805A76E1f5ebbFE7115F16f9c87C2f7e633726', deployer);
    system.defThing(fToken, token);

    let market = await getContract('0xe7b9c7c9cA85340b8c06fb805f7775e3015108dB', deployer);

    let baseToken = await getContract('0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', deployer);
    system.defThing(baseToken, token);

    let stEthWhale = await ethers.getImpersonatedSigner('0x95ed9BC02Be94C17392fE819A93dC57E73E1222E');
    if (!(await (baseToken.connect(stEthWhale) as any).transfer(fMinter.address, parseEther('10')))) {
        throw Error('could not get enough stETH, find another whale');
    }

    /////////////////////////
    // define the actions
    let fMint = system.defAction('fMinter.mint(100)', async () => {
        // TODO: access the Calculation for this
        await baseToken.as(fMinter).approve(market.address, MaxUint256);
        let fNav = await treasury.getCurrentNav().then((res) => res._fNav);
        return market.as(fMinter).mintFToken((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
    });

    /////////////////////////
    // define the variables
    // TODO: set up variables from config, and access it via system
    let ethPrice = system.defVariable('ethPrice', parseEther('2000'));

    /////////////////////////
    // define the calculations
    // TODO: generate all the non-parameter functions for all the contracts from the ABI
    system.defCalculation(`${fToken.name}.nav`, async () => {
        return treasury.getCurrentNav().then((res) => res._fNav);
    });
    //system.defCalculation(`${xToken.name}.nav`, async () => {
    //    return treasury.getCurrentNav().then((res) => res._xNav);
    //});
    system.defCalculation(`${treasury.name}.collateralRatio`, async () => {
        return treasury.collateralRatio();
    });
    system.defCalculation(`${treasury.name}.totalBaseToken`, async () => {
        return treasury.totalBaseToken();
    });

    let delver = new PAMRunner(system, [ethPrice], [fMint]);
    await delver.data();

    await delver.done(config.outputFileRoot);
}

// use this pattern to be able to use async/await everywhere and properly handle errors.
main().catch((error) => {
    console.error('Error: %s', error);
    process.exitCode = 1;
});
