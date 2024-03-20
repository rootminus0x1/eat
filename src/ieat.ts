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
    doStuff: () => Promise<void>;
}

const logCustomError = (signature: string) => {
    const hash = keccak256(Buffer.from(signature));
    const errorSelector = '0x' + hash.slice(2, 10);
    log(`${errorSelector} => ${signature}`);
};

export const eatMain = async (runs: IEat[], loud: boolean = false): Promise<void> => {
    await setupBlockchain();

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

        // and do stuff, comparing it to base, as needed
        await run.doStuff();

        await snapshot.restore();
    }
};
