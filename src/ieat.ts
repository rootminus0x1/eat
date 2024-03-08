import { takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';
import { setupBlockchain } from './Blockchain';
import { writeDiagram } from './config';
import { dig, digUsers } from './dig';
import { mermaid } from './mermaid';
import { Reading } from './read';
import { delve } from './delve';

export interface IEat {
    name: string;
    addContracts: () => Promise<void>;
    //addUsers: () => Promise<void>;
    doStuff: (base: Reading[]) => Promise<void>;
}

export const eatMain = async (runs: IEat[], loud: boolean = false): Promise<void> => {
    await setupBlockchain();

    await dig('blockchain', loud);
    if (loud) writeDiagram('blockchain', await mermaid());

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

        // and do stuff, comparing it to base, as needed
        await run.doStuff(base);

        await snapshot.restore();
    }
};
