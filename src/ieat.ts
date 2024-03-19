import { keccak256 } from 'ethers';

import { takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';
import { setupBlockchain } from './Blockchain';
import { writeDiagram, writeReadings } from './config';
import { dig, digSource, digUsers } from './dig';
import { mermaid } from './mermaid';
import { Reading } from './read';
import { delve } from './delve';
import { log } from './logging';

export interface IEat {
    name: string;
    addContracts: () => Promise<void>;
    //addUsers: () => Promise<void>;
    doStuff: (base: Reading[]) => Promise<void>;
}

const logCustomError = (signature: string) => {
    const hash = keccak256(Buffer.from(signature));
    const errorSelector = '0x' + hash.slice(2, 10);
    log(`${errorSelector} => ${signature}`);
};

export const eatMain = async (runs: IEat[], loud: boolean = false): Promise<void> => {
    await setupBlockchain();

    logCustomError('ErrorCallerNotFUSD()');

    /// @dev Thrown when token mint is paused.
    logCustomError('ErrorMintPaused()');

    /// @dev Thrown when fToken mint is paused in stability mode.
    logCustomError('ErrorFTokenMintPausedInStabilityMode()');

    /// @dev Thrown when mint with zero amount base token.
    logCustomError('ErrorMintZeroAmount()');

    /// @dev Thrown when the amount of fToken is not enough.
    logCustomError('ErrorInsufficientFTokenOutput()');

    /// @dev Thrown when the amount of xToken is not enough.
    logCustomError('ErrorInsufficientXTokenOutput()');

    /// @dev Thrown when token redeem is paused.
    logCustomError('ErrorRedeemPaused()');

    /// @dev Thrown when xToken redeem is paused in stability mode.
    logCustomError('ErrorXTokenRedeemPausedInStabilityMode()');

    /// @dev Thrown when redeem with zero amount fToken or xToken.
    logCustomError('ErrorRedeemZeroAmount()');

    /// @dev Thrown when the amount of base token is not enough.
    logCustomError('ErrorInsufficientBaseOutput()');

    /// @dev Thrown when the stability ratio is too large.
    logCustomError('ErrorStabilityRatioTooLarge()');

    /// @dev Thrown when the default fee is too large.
    logCustomError('ErrorDefaultFeeTooLarge()');

    /// @dev Thrown when the delta fee is too small.
    logCustomError('ErrorDeltaFeeTooSmall()');

    /// @dev Thrown when the sum of default fee and delta fee is too large.
    logCustomError('ErrorTotalFeeTooLarge()');

    /// @dev Thrown when the given address is zero.
    logCustomError('ErrorZeroAddress()');

    await dig('blockchain', loud);
    writeDiagram('blockchain', await mermaid());
    await digSource();

    const snapshot = await takeSnapshot();
    for (const run of runs) {
        await run.addContracts();

        // redig after adding contracts
        await dig(run.name);
        // and add the users
        await digUsers();
        // diagramming it all
        writeDiagram(`${run.name}-base`, await mermaid());

        // now collect a base set of readings
        const [base] = await delve(run.name);
        writeReadings(`${run.name}-base`, base);

        // and do stuff, comparing it to base, as needed
        await run.doStuff(base);

        await snapshot.restore();
    }
};
