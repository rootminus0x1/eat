import axios from 'axios';

import { asDate } from './datetime';
import { getCachedValue, saveCacheValue } from './eat-cache';

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

    let got: bigint;
    let cached = await getCachedValue(url);
    if (cached) {
        got = BigInt(cached);
    } else {
        const response = await axios.get(url);
        let responseGot: number | undefined;
        if (response.status === 200 && response.data?.prices?.length > 0 && response.data.prices[0].length) {
            responseGot = response.data.prices[0][1];
        }
        if (responseGot) {
            got = BigInt(responseGot * 1e18);
            saveCacheValue(url, got.toString());
        } else {
            throw Error(`Failed to fetch historic ETH price: ${JSON.stringify(response.data)}`);
        }
    }
    return got;
};
