/**
 * triggers
 * create transactions (in most cases - eth price changes and time rolling are also triggers but don't return transactions)
 *
 */

// TODO: make them contain only raw info
import { log } from './logging';

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

export const doTrigger = async (trigger: Trigger): Promise<TriggerOutcome> => {
    let gas: bigint | undefined = undefined;
    let value: any = undefined;
    let error: string | undefined = undefined;
    try {
        //const args = (overrideArgs.length ? overrideArgs : trigger.args || []).map((a: any) => parseArg(a));
        const tx = await trigger.pull(...(trigger.args || []));
        if (typeof tx === 'object') {
            // TODO: generate user functions elsewhere
            // const tx = await contracts[event.contract].connect(users[event.user])[event.function](...args);
            // TODO: get the returned values out
            // would be nice to capture any log events emitted too :-) see expect.to.emit
            const receipt = await tx.wait();
            gas = receipt?.gasUsed;
        } else {
            value = tx;
        }
        // TODO: parse the results into events, etc
    } catch (e: any) {
        error = e.message;
    }
    return {
        trigger: trigger,
        value: value,
        error: error,
        gas: gas,
    };
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
