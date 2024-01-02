import { Contract } from 'ethers';

import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers';
import { ethers } from 'hardhat';

import { EatContract } from './eatcontract';

export type ContractWithAddress<T extends Contract> = T & {
    name: string;
    address: string;
    as: (signer: SignerWithAddress) => T; // TODO: this function should be connect, but typescript can't work out which connect to use
};

export type UserWithAddress = SignerWithAddress & { name: string; address: string };

export async function deploy<T extends Contract>(
    factoryName: string,
    deployer: SignerWithAddress /*HardhatEthersSigner*/,
    ...deployArgs: any[]
): Promise<ContractWithAddress<T>> {
    const contractFactory = await ethers.getContractFactory(factoryName, deployer);
    const contract = await contractFactory.deploy(...deployArgs);
    await contract.waitForDeployment();
    let address = await contract.getAddress();

    // TODO: if the contract is a ERC20 token, get it's name from there

    return Object.assign(contract as T, {
        name: factoryName,
        address: address,
        as: (signer: SignerWithAddress): T => {
            return contract.connect(signer) as T;
        },
    }) as ContractWithAddress<T>;
}

// TODO: see if we can merge/use this with dig
// maybe by rolling all of this into EatContract
// TODO: merge the addition of connect with the above, also the ERC20 name
export async function getContract(address: string, signer: SignerWithAddress): Promise<ContractWithAddress<Contract>> {
    // look up etherscan
    const contract = new EatContract(address);
    const source = await contract.sourceCode();
    if (!source) throw Error(`unable to locate contract ABI: ${address}`);
    let abi = source.ABI;
    let name = source.ContractName;
    if (source.Proxy) {
        const implementation = new EatContract(source.Implementation);
        const source2 = await implementation.sourceCode();
        if (!source2) throw Error(`unable to locate implementation contract ABI: ${source.Implementation}`);
        abi = source2.ABI; // TODO: merge the contract ABIs, exclude constructor, etc.
        name = source2.ContractName;
    }
    // look up the ERC20 name
    const erc20Token = new ethers.Contract(
        address,
        ['function name() view returns (string)', 'function symbol() view returns (string)'],
        ethers.provider,
    );
    try {
        const erc20Name = await erc20Token.name();
        const erc20Symbol = await erc20Token.symbol();
        if (erc20Name && erc20Symbol) name = erc20Symbol;
    } catch (error) {}
    // put it all together
    const econtract = new ethers.Contract(address, abi, signer);
    return Object.assign(econtract, {
        name: name,
        address: address,
        as: (signer: SignerWithAddress): Contract => {
            return econtract.connect(signer) as Contract;
        },
    }) as ContractWithAddress<Contract>;
}

let allSigners = ethers.getSigners();
let allocatedSigners = 0;

export async function getUser(name: string): Promise<UserWithAddress> {
    let signer = (await allSigners)[allocatedSigners++] as SignerWithAddress;
    //console.log("%s = %s", signer.address, name);
    return Object.assign(signer, { name: name }) as UserWithAddress;
}

/* find a block given a date/time
export type NamedAddress = { name: string; address: string }

export type User = NamedAddress & SignerWithAddress;
export type Token<T extends BaseContract> = NamedAddress & ContractWithAddress<T>;
export type Contract<T extends BaseContract> = NamedAddress & ContractWithAddress<T>;
*/

/*
const Web3 = require('web3');
const web3 = new Web3('YOUR_ETH_NODE_URL');

const targetTimestamp = Math.floor(Date.now() / 1000); // Replace this with your target timestamp

async function findBlockNumber() {
  const latestBlock = await web3.eth.getBlock('latest');
  const latestTimestamp = latestBlock.timestamp;
  const averageBlockTime = 15; // Ethereum block time in seconds

  // Estimate the target block number
  const estimatedBlockNumber = Math.floor(latestBlock.number - (latestTimestamp - targetTimestamp) / averageBlockTime);

  // Fetch the block details at the estimated block number
  const estimatedBlock = await web3.eth.getBlock(estimatedBlockNumber, true);

  if (estimatedBlock.timestamp === targetTimestamp) {
    console.log(`Block number containing the timestamp: ${estimatedBlockNumber}`);
    return;
  }

  // If the estimated timestamp is too low, perform a linear search forward
  for (let i = estimatedBlockNumber + 1; i <= latestBlock.number; i++) {
    const block = await web3.eth.getBlock(i, true);
    if (block.timestamp === targetTimestamp) {
      console.log(`Block number containing the timestamp: ${i}`);
      return;
    } else if (block.timestamp > targetTimestamp) {
      break; // Stop searching if we've passed the target timestamp
    }
  }

  // If the estimated timestamp is too high, perform a linear search backward
  for (let i = estimatedBlockNumber - 1; i >= 0; i--) {
    const block = await web3.eth.getBlock(i, true);
    if (block.timestamp === targetTimestamp) {
      console.log(`Block number containing the timestamp: ${i}`);
      return;
    } else if (block.timestamp < targetTimestamp) {
      break; // Stop searching if we've passed the target timestamp
    }
  }

  console.log('Timestamp not found in the available blocks.');
}

findBlockNumber();
*/
