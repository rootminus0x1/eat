import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { BlockchainAddress } from './Blockchain';

// the nodes, also contains static information about the nodes, name, etc
export type GraphNode = {
    name: string;
    signer?: SignerWithAddress;
    leaf?: boolean;
} & BlockchainAddress;
// the links - between a from address (key) and to list of named addresses (value)
export type Link = { name: string; address: string };

export type Measure = {
    name: string;
    calculation: () => Promise<bigint | bigint[]>;
    type: string; // solidity type
};

export type MeasureOnAddress = {
    name: string;
    calculation: (address: string) => Promise<bigint | bigint[]>;
    type: string; // solidity type
};

export const nodes = new Map<string, GraphNode>(); // address to object
export const links = new Map<string, Link[]>(); // address to array of links, from -> to:Link[]
export const backLinks = new Map<string, Link[]>(); // reverse of above, to -> from:Link[]

/* measurements schema (this is an extract from the ABI)
we use the $ prefix on item names to avoid a clash with solidity names that cannot have a $
solidity names that have a unicode characters in will be translated to (e.g. \uXXXX)
contracTypeA:
  decimals: uint8
  getReceivers:
    _ratios: uint256[]
    $input:
      - name: address
contractTypeB
    :
*/
export const measurementsSchema: any = {};

/* measurements
old:
- name: of variable
    :
- name: of action
  user: fMinter
  contract: Market
  function: mintFToken
  args: '["1000 ether","fMinter",0]'
  gas: '335120'
- address: 0x...
  name: contractNameA
  contract: contractTypeA
  measurements:
    - name: decimals
      type: uint8 <-- new: schema.contractNameA.decimals
      value: 8
    - name: getReceivers._ratios
      type: uint256[]
      target: contractNameB
      value: []

new:
$action:
  - $name: Market.mintFToken
    user: fMinter
    contract: Market
    function: mintFToken
    args: '["1000 ether","fMinter",0]'
    gas: '335120'
$measurements:
  - contractNameA:
      $contract: contractTypeA
      $address: 0x...
      decimals: 8
      getReceivers:
        $input: [contractNameB]
        _ratios: []
*/
export const measurements: any = {};

//export const measures = new Map<string, Measure[]>();
//export const measuresOnAddress = new Map<string, MeasureOnAddress[]>();

// for use in actions
export const contracts: any = {};
export const users: any = {};
