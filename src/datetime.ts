export function asDate(timestamp: number): Date {
    return new Date(timestamp * 1000);
}

export const asDateString = (timestamp: number): string => {
    return asDate(timestamp).toISOString();
};

export function asTimestamp(datetime: string): number {
    const parsedUnixTimestamp = new Date(datetime).getTime();
    return isNaN(parsedUnixTimestamp) ? 0 : Math.floor(parsedUnixTimestamp / 1000);
}
