/** Resolve presentation aliases while leaving the saved billing/model key intact. */
export function modelOptionFromIndex<T>(index: ReadonlyMap<string, T>, key: string): T | undefined {
	const direct = index.get(key);
	if (direct) return direct;
	const slash = key.indexOf("/");
	if (slash < 0) return undefined;
	const provider = key.slice(0, slash);
	const model = key.slice(slash + 1);
	if (provider === "flowstoken-normal") return index.get(`flowstoken-default/${model}`);
	if (provider === "flowstoken-default") return index.get(`flowstoken-normal/${model}`);
	return undefined;
}
