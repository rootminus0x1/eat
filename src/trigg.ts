/**
 * triggers
 * create transactions (in most cases - eth price changes and time rolling are also triggers but don't return transactions)
 *
 */

// TODO: make them contain only raw info
import { ContractTransactionReceipt, ContractTransactionResponse, Log, ethers } from 'ethers';
import { decodeError, nodes } from './graph';
import { log } from './logging';
import { ContractWithAddress } from './Blockchain';
import { addressToName, friendlyArgs } from './friendly';
import { ConfigFormatApply } from './config';
import { DecodedError } from 'ethers-decode-error';

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

type Event = {
    address: string;
    raw: any;
    contract?: string;
    name?: string;
} & Partial<{ error: string }> &
    Partial<{ argNames: string[]; argValues?: any[]; argTypes?: string[] }>;

export type TriggerOutcome = {
    trigger: Trigger;
} & Partial<{ error: string }> &
    Partial<{ events: Event[]; gas: bigint }> &
    Partial<{ value: any }>;

export const doTrigger = async (trigger: Trigger, addEvents: boolean = false): Promise<TriggerOutcome> => {
    let result: TriggerOutcome = { trigger: trigger };
    try {
        //const args = (overrideArgs.length ? overrideArgs : trigger.args || []).map((a: any) => parseArg(a));
        const pullResult = await trigger.pull(...(trigger.args || []));
        if (typeof pullResult === 'object') {
            // TODO: generate user functions elsewhere
            // const tx = await contracts[event.e].connect(users[event.user])[event.function](...args);
            const tx: ContractTransactionResponse = pullResult;
            const receipt = await tx.wait();
            if (receipt) {
                result.gas = receipt.gasUsed;
                if (addEvents) {
                    result.events = [];
                    for (const event of receipt.logs) {
                        const resultEvent: Event = { address: event.address, raw: event.toJSON() };
                        const node = nodes.get(event.address);
                        if (node) {
                            const contractInstance = addressToName(event.address);
                            const contract = await node.getContract();
                            if (contract) {
                                resultEvent.contract = await node.contractNamish();
                                const parsed = contract.interface.parseLog({
                                    topics: event.topics.slice(),
                                    data: event.data,
                                });
                                if (parsed) {
                                    resultEvent.name = parsed.name;
                                    resultEvent.argNames = parsed.fragment.inputs.map((i) => i.name);
                                    resultEvent.argTypes = parsed.fragment.inputs.map((i) => i.type);
                                    resultEvent.argValues = parsed.args;
                                } else {
                                    resultEvent.error =
                                        ' ! could not parse the event log based on dug up contract interface';
                                }
                            } else {
                                resultEvent.error = ' ! not a contract';
                            }
                        } else {
                            resultEvent.error = ' ! not an address dug up';
                        }
                        result.events.push(resultEvent);
                    }
                }
            }
        } else {
            result.value = pullResult;
        }
    } catch (e: any) {
        const decodedError: DecodedError = await decodeError(e);
        //log(`Error: "${e.message}" => Decoded: ${decodedError.reason}`);
        result.error = decodedError.reason || e.message;
    }
    return result;
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
