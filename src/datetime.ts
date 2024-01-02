export function asDatetime(timestamp: number): string {
    return new Date(timestamp * 1000).toISOString();
}

export function asTimestamp(datetime: string): number {
    const parsedUnixTimestamp = new Date(datetime).getTime();
    return isNaN(parsedUnixTimestamp) ? 0 : Math.floor(parsedUnixTimestamp / 1000);
}
