import { ContractWithAddress, UserWithAddress, deploy, getUser, getContract } from './blockchain-old';
import { PAMSystem } from './PokeAndMeasure';
import { Contract } from 'ethers';
import { Graph } from './graph';

export const addUser = async (system: PAMSystem, name: string, types: string[] = []): Promise<UserWithAddress> => {
    const user = await getUser(name);
    types.map((type) => system.defThing(user, type));
    return user;
};

// TODO: add Contract may be useful if the contract is not part of the dig Graph
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

export const sort = <K, V>(unsorted: Map<K, V>, field: (v: V) => string) => {
    return Array.from(unsorted.entries()).sort((a, b) =>
        field(a[1]).localeCompare(field(b[1]), 'en', { sensitivity: 'base' }),
    );
};

// returning an object allows us to print it in differnt formats and cheaply, e.g. JSON.stringify
// all numbers are converted to strings
// TODO: convert the numbers using some formatting defined in config?

// TODO: add linked from, with name
export const calculateMeasures = async (graph: Graph): Promise<Object> => {
    const result: any = {}; // use any to shut typescript up here :-)

    for (const [address, node] of sort(graph.nodes, (v) => v.name)) {
        const measures = graph.measures.get(address);
        if (measures) {
            let values: any = {};
            for (const measure of measures) {
                let value: any = { type: measure.type };
                try {
                    // TODO: remove the string and replace with specific formatting
                    value.value = (await measure.calculation()).toString();
                } catch (e: any) {
                    value.error = e.message;
                }
                values[measure.name] = value;
            }
            result[address] = { name: node.name, contractNamish: await node.contractNamish(), measurements: values };
        }
    }
    return result;
};
