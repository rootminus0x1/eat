import { ethers } from 'hardhat';

import { Graph } from './graph';
import { Blockchain } from './Blockchain';
import { dig } from './dig';
import { ContractTransactionResponse, MaxUint256, parseEther } from 'ethers';
import { ConfigAction } from './config';

// TODO: add Contract may be useful if the contract is not part of the dig Graph
/*
export const addContract = async (
    system: PAMSystem,
    address: string,
    signer: UserWithAddress,
    types: string[] = [],
): Promise<ContractWithAddress<Contract>> => {
    // create the contract
    const contract = await getContract(address, signer);
    // add its types
    types.map((type) => system.defThing(contract, type));
    if (contract.tokenSymbol) {
        system.defThing(contract, 'token');
    }
    // set up calls to the parameterless view/pure functions that return a single number
    // TODO: handle multiple number returns
    contract.interface.forEachFunction((func) => {
        if (
            func.inputs.length == 0 &&
            (func.stateMutability === 'view' || func.stateMutability === 'pure') &&
            func.outputs.length == 1 &&
            func.outputs[0].type === 'uint256'
        ) {
            system.defCalculation(`${contract.name}.${func.name}`, async () => {
                return contract[func.name]();
            });
        }
    });

    return contract;
};
*/

/*
export const calculateAllActions async (): Promise<Object> => {
    for (let action of ['', ...this.actions]) {
        let dataLine = this.independents.map((variable) => this.formatEther(variable.value));

        let result = '-'; // no action
        let actionGas = 0n;
        const fn = this.system.actions.get(action);
        if (fn) {
            try {
                let tx = await fn();
                let receipt = await tx.wait();
                actionGas = receipt ? receipt.gasUsed : MaxInt256;
                result = '\\o/'; // success
            } catch (e: any) {
                result = this.formatError(e); // failure
            }
        }
        dataLine.push(action);
        dataLine.push(result);
        dataLine.push(this.formatWei(actionGas));
        dataLine.push('$' + formatEther(actionGas * 50n * 10n ** 9n * 2500n));
    }
}
*/

type ActionFunction = () => Promise<ContractTransactionResponse>;
type Actions = Map<string, ActionFunction>;

// TODO: return users and contracts for complex user defined actions
export const setupActions = async (config: any, graph: Graph, blockchain: Blockchain): Promise<Actions> => {
    const contracts: any = {};
    for (const [name, address] of graph.namedAddresses) {
        // wrap contract in a proxy

        // TODO: intercept all calls for each contract into structure for action information
        /*
        class Proxy <T extends Object> {
            private className: string;
            constructor(private wrapped: T, private name: string) {
                this.className = wrapped.constructor.name;
            }
            private intercept = (target: any, func: string, receiver: any) => {
                return (...args: any[]) => {
                    console.log(`name: ${this.name}, contract: ${this.className}, ${func}(${JSON.stringify(args)})`);
                    return target[func].apply(this.wrapped, args);
                }
            }

            public create = () {
                const hander
            }

        }
        */
        contracts[name] = await graph.nodes.get(address)?.getContract();
    }

    // TODO: all graphnodes that aren't contracts get treated as wallets.
    // like owners, and other special addresses, we set them up as impersonated signers

    const users: any = {};
    for (const user of config.users) {
        const signer = await blockchain.getSigner(user.name);
        users[user.name] = signer; // to be used in actions
        graph.nodes.set(signer.address, Object.assign({ name: user.name, signer: signer }, dig(signer.address)));
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

    const actions: Actions = new Map<string, ActionFunction>();

    /*
    TODO: check each argument against the ABI for the contract to see what kind of conversion is needed
    for (const configAction of config.actions) {
        const action: ConfigAction = configAction;
        actions.set(
            'fMinter_mint_1ETH',
            //`${action.user} => ${action.contract}(${JSON.stringify(action.args})`,
            async () => {
                // process the args
                const workingArgs: (string | bigint)[] = [];
                for (const arg of action.args) {
                    if (typeof arg === 'bigint')
                        workingArgs.push(arg);
                    else if
                }

                }
                return contracts[action.contract].connect(users[action.user])[action.function](...workingA`rgs);
            },
        );
    }
    */

    actions.set('fMinter_mint_1ETH', async () => {
        // TODO: add actions to config
        //return market.mintFToken((fNav * parseEther('100')) / ethPrice.value, fMinter.address, 0n);
        return contracts.Market.connect(users.fMinter).mintFToken(parseEther('1'), users.fMinter.address, 0n);
    });

    // TODO: all erc20 graphnodes are added to tokens for wallets to hold
    // TODO: some non-erc20 graphnodes are defined in config

    return actions;
};

export const sort = <K, V>(unsorted: Map<K, V>, field: (v: V) => string) => {
    return Array.from(unsorted.entries()).sort((a, b) =>
        field(a[1]).localeCompare(field(b[1]), 'en', { sensitivity: 'base' }),
    );
};

export type MeasurementValue = bigint | bigint[];
export type Measurement = {
    name: string;
    type: string;
    // TODO: revisit the design of deltas and values/errors overlaying each other
    // value can hold a value or a delta value for comparisons
    delta?: MeasurementValue;
    value?: MeasurementValue;
    // error can hold an error, a change in error message or indicate a change from a value to/from an error
    error?: string;
};

export type Variable = {
    name: string;
    value: bigint;
};

export type Action = {
    name: string;
    // the function gets evaluated by eval()?
    addressName: string; // foreign key
    userName: string;
    functionName: string;
    arguments: string[];
    gas?: bigint;
    error?: string;
};

export type ContractMeasurements = {
    address: string;
    name: string; // node name
    contract: string; // contract nameish
    measurements: Measurement[];
} /*
& Partial<{
    action: string;
    success: boolean;
    gas: bigint;
}>*/;

export type Measurements = (Partial<Variable> & Partial<Action> & Partial<ContractMeasurements>)[];

export const calculateMeasures = async (graph: Graph): Promise<Measurements> => {
    const result: Measurements = [];

    for (const [address, node] of sort(graph.nodes, (v) => v.name)) {
        const measures = graph.measures.get(address);
        if (measures && measures.length > 0) {
            let values: Measurement[] = [];
            for (const measure of measures) {
                try {
                    const value = await measure.calculation();
                    values.push({ name: measure.name, type: measure.type, value: value });
                } catch (e: any) {
                    values.push({ name: measure.name, type: measure.type, error: e.message });
                }
            }
            result.push({
                address: address,
                name: node.name,
                contract: await node.contractNamish(),
                measurements: values,
            });
        }
    }
    return result;
};

export const calculateDeltaMeasures = (
    baseMeasurements: Measurements,
    actionedMeasurements: Measurements,
): Measurements => {
    const results: Measurements = [];

    // loop through actioned measurements, just the actual measurements
    const actionedContractMeasurements: Measurements = actionedMeasurements.filter((m: any) =>
        m.measurements ? true : false,
    );
    if (baseMeasurements.length !== actionedContractMeasurements.length)
        throw Error(
            `contract measurements differ: baseMeasurements ${baseMeasurements.length} actionedMeasurements ${actionedContractMeasurements.length}`,
        );

    for (let a = 0; a < actionedContractMeasurements.length; a++) {
        const baseContract = baseMeasurements[a] as ContractMeasurements;
        const actionedContract = actionedContractMeasurements[a] as ContractMeasurements;

        if (
            actionedContract.address !== baseContract.address ||
            actionedContract.name !== baseContract.name ||
            actionedContract.contract !== baseContract.contract
        )
            throw Error(
                `contract measurements[${a}] mismatch base: ${JSON.stringify(baseContract)}; actioned: ${JSON.stringify(
                    actionedContract,
                )}`,
            );

        if (actionedContract.measurements.length !== baseContract.measurements.length)
            throw Error(`contract measurements[${a}] mismatch on number of measurements`);

        const deltas: Measurement[] = [];
        for (let m = 0; m < actionedContract.measurements.length; m++) {
            const baseMeasurement = baseContract.measurements[m];
            const actionedMeasurement = actionedContract.measurements[m];

            if (actionedMeasurement.name !== baseMeasurement.name || actionedMeasurement.type !== baseMeasurement.type)
                throw Error('attempt to diff measurements of different structures');

            // TODO: handle arrays of values wherever a "value:" or "delta:" is written below
            if (baseMeasurement.error && actionedMeasurement.error) {
                // both errors
                if (baseMeasurement.error !== actionedMeasurement.error)
                    deltas.push({
                        name: actionedMeasurement.name,
                        type: actionedMeasurement.type,
                        error: `"${baseMeasurement.error}" => "${actionedMeasurement.error}"`,
                    });
            } else if (baseMeasurement.error && !actionedMeasurement.error) {
                // different kind of result
                deltas.push({
                    name: actionedMeasurement.name,
                    type: actionedMeasurement.type,
                    error: `"${baseMeasurement.error}" => value`,
                    value: actionedMeasurement.value,
                });
            } else if (!baseMeasurement.error && actionedMeasurement.error) {
                // different kind of result
                deltas.push({
                    name: actionedMeasurement.name,
                    type: actionedMeasurement.type,
                    error: `value => "${actionedMeasurement.error}"`,
                    value: baseMeasurement.value,
                });
            } else {
                // both values
                if (baseMeasurement.value !== actionedMeasurement.value)
                    // TODO: handle arrays of bigints
                    deltas.push({
                        name: actionedMeasurement.name,
                        type: actionedMeasurement.type,
                        delta: (actionedMeasurement.value as bigint) - (baseMeasurement.value as bigint),
                    });
            }
        }
        if (deltas.length > 0)
            results.push({
                address: actionedContract.address,
                name: actionedContract.name,
                contract: actionedContract.contract,
                measurements: deltas,
            });
    }
    return results;
};
