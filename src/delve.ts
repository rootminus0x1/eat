import axios from 'axios';

import { asDate } from './datetime';
import { ContractWithAddress, UserWithAddress, deploy, getUser, getContract } from './blockchain';
import { PAMSystem } from './PokeAndMeasure';
import { Contract } from 'ethers';

// TODO: add this to a coingecko file, and generalise for other currencies and cache, etc.

// Fetch the current ETH price in USD - should be historic!
export const getEthPrice = async (timestamp: number): Promise<bigint> => {
    const options: Intl.DateTimeFormatOptions = {
        year: '2-digit', // Two-digit representation of the year
        month: '2-digit', // Two-digit representation of the month
        day: '2-digit', // Two-digit representation of the day
    };
    const formattedDate = new Intl.DateTimeFormat('en-US', options).format(asDate(timestamp));

    const url = `https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range?vs_currency=usd&from=${
        timestamp - 1000
    }&to=${timestamp + 4000}&precision=full`;
    console.log(`COINGECKO: ${url}`);
    const response = await axios.get(url);

    if (response.status !== 200) {
        throw Error('something went wrong while querying coingecko');
    }
    if (response.data.prices.length > 0) {
        const historicPrice = BigInt(response.data.prices[0][1] * 1e18);
        console.log(`result = ${historicPrice}, of ${response.data.prices.length} data points`);
        return historicPrice;
    } else {
        throw Error(`Failed to fetch historic ETH price: ${JSON.stringify(response.data)}`);
    }
};

export const addUser = async (system: PAMSystem, name: string, types: string[] = []): Promise<UserWithAddress> => {
    const user = await getUser(name);
    types.map((type) => system.defThing(user, type));
    return user;
};

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
