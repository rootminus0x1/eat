import { Graph } from './graph';

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

export type MeasurementForContract = {
    address: string;
    name: string;
    contract: string;
    measurements: Measurement[];
} & Partial<{
    action: string;
    success: boolean;
    gas: bigint;
}>;
export type Measurements = MeasurementForContract[];

// returning an object allows us to print it in differnt formats and cheaply, e.g. JSON.stringify
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

    const m: Measurement[] = [{ name: 'x', type: 'y', error: 'eek' }];
    if (m[0] as { error: string } | undefined) console.log((m[0] as any).error);

    // loop through actioned measurements
    for (let a = 0; a < actionedMeasurements.length; a++) {
        const address = actionedMeasurements[a].address;
        const name = actionedMeasurements[a].name;
        const contract = actionedMeasurements[a].contract;
        const measurements = actionedMeasurements[a].measurements;

        if (
            !baseMeasurements[a] ||
            address !== baseMeasurements[a]?.address ||
            name !== baseMeasurements[a]?.name ||
            contract !== baseMeasurements[a]?.contract ||
            measurements.length !== baseMeasurements[a].measurements.length
        )
            throw Error('attempt to diff measurements of different structures');

        const deltas: Measurement[] = [];
        for (let m = 0; m < measurements.length; m++) {
            const name = measurements[m].name;
            const type = measurements[m].type;
            if (
                !baseMeasurements[a].measurements[m] ||
                name !== baseMeasurements[a].measurements[m].name ||
                type !== baseMeasurements[a].measurements[m].type
            )
                throw Error('attempt to diff measurements of different structures');

            const base = baseMeasurements[a].measurements[m] as any;
            const actioned = measurements[m] as any;
            // TODO: handle arrays of values wherever a "value:" or "delta:" is written below
            if (base.error && actioned.error) {
                // both errors
                if (base.error !== actioned.error)
                    deltas.push({ name: name, type: type, error: `"${base.error}" => "${actioned.error}"` });
            } else if (base.error && !actioned.error) {
                // different kind of result
                deltas.push({ name: name, type: type, error: `"${base.error}" => value`, value: actioned.value });
            } else if (!base.error && actioned.error) {
                // different kind of result
                deltas.push({ name: name, type: type, error: `value => "${actioned.error}"`, value: base.value });
            } else {
                // both values
                if (base.value !== actioned.value)
                    deltas.push({ name: name, type: type, delta: ((actioned.value as bigint) - base.value) as bigint });
            }
        }
        if (deltas.length > 0) results.push({ address: address, name: name, contract: contract, measurements: deltas });
    }
    return results;
};
