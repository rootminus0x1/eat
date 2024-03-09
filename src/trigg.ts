/**
 * triggers
 * create transactions (in most cases - eth price changes and time rolling are also triggers but don't return transactions)
 *
 */

// TODO: make them contain only raw info
import { ContractTransactionReceipt, ContractTransactionResponse, Log, ethers } from 'ethers';
import { GraphNode, contracts, nodes } from './graph';
import { log } from './logging';
import { ContractWithAddress } from './Blockchain';
import { addressToName, friendlyArgs, nameToAddress } from './friendly';
import { ConfigFormatApply } from './config';

export type TriggerTemplate = {
    name: string;
    // TODO: merge these two fields below with readertemplate
    argTypes: string[];
    pull: (...args: any[]) => Promise<any>; // async fuction that executes (pulls) the trigger to make the effect
    // TODO: add list of events that can be parsed for results, for this contract
};
export type Trigger = TriggerTemplate & {
    args: any[]; // these are the args for the pull function
};
export type TriggerOutcome = {
    trigger: Trigger;
} & Partial<{ error: string }> &
    Partial<{ events: any[]; gas: bigint }> &
    Partial<{ value: any }>;

export const doTrigger = async (trigger: Trigger, addEvents: boolean = false): Promise<TriggerOutcome> => {
    let result: TriggerOutcome = { trigger: trigger };
    try {
        //const args = (overrideArgs.length ? overrideArgs : trigger.args || []).map((a: any) => parseArg(a));
        const pullResult = await trigger.pull(...(trigger.args || []));
        if (typeof pullResult === 'object') {
            // TODO: generate user functions elsewhere
            // const tx = await contracts[event.contract].connect(users[event.user])[event.function](...args);
            const tx: ContractTransactionResponse = pullResult;
            if (addEvents) {
                const receipt = await tx.wait();

                if (receipt) {
                    result.gas = receipt.gasUsed;
                    result.events = [];
                    for (const event of receipt.logs) {
                        let resultLog: any = event.toJSON();
                        const node = nodes.get(event.address);
                        if (node) {
                            // TODO: move this to friendly?
                            const contractInstance = addressToName(event.address);
                            const contract = await node.getContract();
                            if (contract) {
                                const parsed = contract.interface.parseLog({
                                    topics: event.topics.slice(),
                                    data: event.data,
                                });
                                if (parsed) {
                                    let parsed2 = `${contractInstance}.${parsed.name}`;
                                    parsed2 += friendlyArgs(
                                        parsed.args,
                                        parsed.fragment.inputs.map((i) => i.type),
                                        parsed.fragment.inputs.map((i) => i.name),
                                        new Map<string, ConfigFormatApply>([['uint256', { unit: 'ether' }]]),
                                    );
                                    resultLog = parsed2;
                                } else {
                                    resultLog += ' ! could not parse the event log based on dug up contract interface';
                                }
                            } else {
                                resultLog += ' ! not a contract';
                            }
                        } else {
                            resultLog += ' ! not an address dug up';
                        }
                        result.events.push(resultLog);
                    }
                }
            }
        } else {
            result.value = pullResult;
        }
    } catch (e: any) {
        result.error = e.message;
    }
    return result;
    {
    }
};

// generate multiple triggers based on some sequance generator

export function makeTrigger(base: TriggerTemplate, ...args: any[]): Trigger {
    return Object.assign({}, base, { args: args }); // override the args
}

export function makeTriggerSeries(base: TriggerTemplate, start: bigint, finish: bigint, step: bigint = 1n): Trigger[] {
    const result: Trigger[] = [];
    for (let i = start; (step > 0 && i <= finish) || (step < 0 && i >= finish); i += step) {
        result.push(makeTrigger(base, i));
    }
    return result;
}

export function makeTriggerList(maker: (arg: bigint) => Trigger, values: bigint[], tolerance: bigint = 1n): Trigger[] {
    const result: Trigger[] = [];
    for (let i of values) {
        result.push(maker(i));
    }
    return result;
}
