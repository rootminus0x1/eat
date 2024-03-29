import { Contract, Interface } from 'ethers';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ErrorDecoder } from 'ethers-decode-error';
import type { DecodedError } from 'ethers-decode-error';

import { IBlockchainAddress } from './Blockchain';
import { log } from './logging';
import { Reader, ReaderTemplate, ReadingValue, callReader } from './read';
import { TriggerTemplate } from './trigg';
import { fieldToName, nameToAddress } from './friendly';
import { readingDelta } from './delve';

// the nodes, also contains static information about the nodes, name, etc
export type SuffixMatch = Map<string, string[]> | undefined;
export type GraphNode = {
    name: string;
    contract?: string;
    signer?: SignerWithAddress;
    leaf?: boolean;
    address: string;
    suffix?: SuffixMatch; // used to help uniquify a name
} & IBlockchainAddress<Contract>;
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };
export type Role = { id: string; name: string; addresses: string[] };

export let nodes: Map<string, GraphNode>; // address to object
export let links: Map<string, Link[]>; // address to array of links, from -> to:Link[]
export let backLinks: Map<string, Link[]>; // reverse of above, to -> from:Link[]
export let roles: Map<string, Role[]>; // address to array of roles
// TODO: add all view & pure functions to the readers

export let readerTemplates: Map<string, ReaderTemplate[]>; // contract address to readers

export const findReader = (id: string, fn: string, field: string = '', ...args: any[]): Reader => {
    const address = nameToAddress(id);
    const forContract = readerTemplates.get(address);
    if (forContract) {
        const readers = forContract.filter((r: ReaderTemplate) => {
            if (r.function !== fn) return false; // mismatched function name
            if (r.argTypes.length !== args.length) return false;

            if (field !== undefined && r.field !== undefined) return field === fieldToName(r.field);
            if (r.field !== undefined) return fieldToName(r.field) === field;
            else return true;
        });
        if (readers.length > 1) throw Error(`more than one Reader matches ${fn}${field ? '.' + field : ''} on ${id}`);
        if (readers.length === 0)
            throw Error(
                `no Reader on ${id}, with ${fn}${args.length ? '(' + args + ')' : ''}${field ? '.' + field : ''}`,
            );
        return Object.assign(
            { args: args.map((arg, i) => (readers[0].argTypes[i] === 'address' ? nameToAddress(arg) : arg)) },
            readers[0],
        );
    }
    throw Error(`no Reader found on: ${id}`);
};

export const augment = (rt: Reader, augmentation: string) => {
    rt.augmentation = rt.augmentation ? rt.augmentation + '-' + augmentation : augmentation;
    return rt;
};

export const findDeltaReader = async (id: string, fn: string, field: string = '', ...args: any[]): Promise<Reader> => {
    const baseReader = findReader(id, fn, field, ...args);
    const base = await callReader(baseReader);
    return augment(
        Object.assign({}, baseReader, {
            read: async (...args: any[]): Promise<ReadingValue> => {
                const again = await callReader(baseReader); // call it again
                const delta = readingDelta(again, base, baseReader.formatting, baseReader.type);
                if (delta.value === undefined) {
                    log(
                        `undefined delta: ${id}.${fn}${field ? '.' + field : ''}(${args
                            .map((a) => a.toString())
                            .join(',')})`,
                    );
                }
                return delta.value || 0n; // TODO: fix this
            },
        }),
        'changes',
    );
};

export let triggerTemplate: Map<string, TriggerTemplate>;

// for use in code - no type checking at the moment
export let contracts: any;

// not resettable: contracts deployed programmatically, not from a blockchain fork
export let users: any = {};
export let localNodes = new Map<string, GraphNode>();

let errorDecoder: ErrorDecoder | undefined = undefined;

export const decodeError = async (err: any): Promise<DecodedError> => {
    if (errorDecoder === undefined) {
        const abis: Interface[] = [];
        for (const [address, node] of nodes) {
            const contract = await node.getContract();
            if (contract?.interface) {
                abis.push(contract?.interface);
            }
        }
        errorDecoder = ErrorDecoder.create(abis);
    }
    return await errorDecoder.decode(err);
};

export const resetGraph = () => {
    // log('resetting graph');
    nodes = new Map<string, GraphNode>(); // address to object
    links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
    backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]
    roles = new Map<string, Role[]>(); // address to array of roles
    readerTemplates = new Map<string, ReaderTemplate[]>();
    triggerTemplate = new Map<string, TriggerTemplate>();

    // for use in code - no type checking at the moment
    contracts = {};
    errorDecoder = undefined;
};
