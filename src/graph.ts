import { EATAddress } from './EATAddress';
export type Link = { toAddress: string; linkName: string };

// the nodes, also contains static information about the nodes, name, etc
export const allNodes = new Map<string, EATAddress>(); // address to object

// the links - between a from address (key) and to list of named addresses (value)
export const allLinks = new Map<string, Link[]>(); // address to array of links
