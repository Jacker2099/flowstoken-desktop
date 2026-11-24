/**
 * Doom-loop detection: the agent sometimes retries the exact same tool call over and
 * over, getting the exact same result each time (a grep that matches nothing, a command
 * that keeps failing identically). No loop limit catches this because every individual
 * call is legal — the failure mode is the repetition itself.
 *
 * Detection is deliberately narrow: only *consecutive* calls with identical tool name,
 * identical arguments AND identical outcome count as a loop. Polling commands whose
 * output changes, batch operations with per-item arguments, and re-checks after doing
 * other work in between all break the chain and are never blocked.
 */

export interface DoomLoopOptions {
	/** Consecutive identical call+result repetitions before further repeats are blocked. Default 3. */
	readonly maxConsecutiveRepeats?: number;
	/** Blocked retry attempts of the same call before the run is terminated. Default 2. */
	readonly maxBlockedAttempts?: number;
}

export interface DoomLoopBlock {
	readonly terminal: boolean;
	readonly message: string;
}

export interface DoomLoopDetector {
	/**
	 * Called before executing a tool call. When a block is returned the call must not
	 * execute; the caller synthesizes an error tool result carrying `message` instead.
	 */
	checkBeforeExecution(toolName: string, args: unknown): DoomLoopBlock | undefined;
	/** Records the outcome of an executed (never blocked) tool call. */
	recordResult(toolName: string, args: unknown, resultText: string, isError: boolean): void;
	/** True once the agent kept retrying after warnings; the host should end the run. */
	readonly terminate: boolean;
}

const DEFAULT_MAX_CONSECUTIVE_REPEATS = 3;
const DEFAULT_MAX_BLOCKED_ATTEMPTS = 2;

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
	if (value === undefined) return fallback;
	if (Number.isSafeInteger(value) && value > 0) return value;
	throw new RangeError(`Doom-loop option ${name} must be a positive safe integer`);
}

/** Deterministic serialization: object keys sorted recursively so equal values compare equal. */
export function stableSignature(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableSignature).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, entryValue]) => entryValue !== undefined)
			.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0));
		return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSignature(entryValue)}`).join(",")}}`;
	}
	return String(value);
}

function resultSignature(resultText: string, isError: boolean): string {
	// Full equality is unnecessary; length plus edge samples keep the comparison cheap for huge outputs.
	const head = resultText.slice(0, 200);
	const tail = resultText.length > 200 ? resultText.slice(-200) : "";
	return `${isError ? "error" : "ok"}:${resultText.length}:${head}:${tail}`;
}

export function createDoomLoopDetector(options?: DoomLoopOptions): DoomLoopDetector {
	const maxConsecutiveRepeats = positiveInteger(
		options?.maxConsecutiveRepeats,
		DEFAULT_MAX_CONSECUTIVE_REPEATS,
		"maxConsecutiveRepeats",
	);
	const maxBlockedAttempts = positiveInteger(
		options?.maxBlockedAttempts,
		DEFAULT_MAX_BLOCKED_ATTEMPTS,
		"maxBlockedAttempts",
	);

	let lastKey: string | undefined;
	let lastCallSignature: string | undefined;
	let consecutive = 0;
	let blockedAttempts = 0;
	let terminate = false;

	return {
		checkBeforeExecution(toolName, args) {
			if (terminate) {
				return {
					terminal: true,
					message: doomLoopMessage(toolName, maxConsecutiveRepeats, true),
				};
			}
			const callSignature = `${toolName}:${stableSignature(args)}`;
			const chainActive = callSignature === lastCallSignature && consecutive >= maxConsecutiveRepeats;
			if (!chainActive) return undefined;
			blockedAttempts += 1;
			if (blockedAttempts >= maxBlockedAttempts) terminate = true;
			return {
				terminal: terminate,
				message: doomLoopMessage(toolName, maxConsecutiveRepeats, terminate),
			};
		},

		recordResult(toolName, args, resultText, isError) {
			const callSignature = `${toolName}:${stableSignature(args)}`;
			const key = `${callSignature}\n${resultSignature(resultText, isError)}`;
			if (key === lastKey) {
				consecutive += 1;
			} else {
				consecutive = 1;
				blockedAttempts = 0;
				lastKey = key;
			}
			lastCallSignature = callSignature;
		},

		get terminate() {
			return terminate;
		},
	};
}

function doomLoopMessage(toolName: string, repeats: number, terminal: boolean): string {
	const base =
		`This exact "${toolName}" call was already executed ${repeats} consecutive times with identical ` +
		"arguments and identical results, which means retrying it cannot make progress. The call was not executed. " +
		"Do not repeat the same call again: change the arguments, use a different tool, or explain the blockage to the user.";
	return terminal ? `${base} The agent run has been stopped to prevent an infinite loop.` : base;
}

/** Extracts the comparable text of a tool result for repetition detection. */
export function doomLoopResultText(content: readonly { type: string; text?: string }[]): string {
	return content.map((part) => (part.type === "text" ? (part.text ?? "") : `<${part.type}>`)).join("\n");
}
