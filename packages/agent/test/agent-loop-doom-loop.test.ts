import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.js";
import { createDoomLoopDetector, doomLoopResultText, stableSignature } from "../src/loop/doom-loop.js";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.js";
import {
	createAssistantMessage,
	createModel,
	createUserMessage,
	identityConverter,
	MockAssistantStream,
} from "./support/agent-loop-fixtures.js";

type ScriptEntry =
	| { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
	| { type: "text"; text: string };

/**
 * Scripted model: each LLM call consumes one script entry. Entries past the end
 * repeat the final one, simulating a model that is stuck and never recovers.
 */
function scriptedStreamFn(script: ScriptEntry[]) {
	let callIndex = 0;
	return () => {
		const stream = new MockAssistantStream();
		queueMicrotask(() => {
			const entry = script[Math.min(callIndex, script.length - 1)];
			callIndex++;
			if (entry.type === "toolCall") {
				const message = createAssistantMessage(
					[{ type: "toolCall", id: entry.id, name: entry.name, arguments: entry.arguments }],
					"toolUse",
				);
				stream.push({ type: "done", reason: "toolUse", message });
			} else {
				const message = createAssistantMessage([{ type: "text", text: entry.text }]);
				stream.push({ type: "done", reason: "stop", message });
			}
		});
		return stream;
	};
}

function createEchoTool(
	execute: (params: {
		value: string;
	}) => Promise<{ content: { type: "text"; text: string }[]; details: Record<string, unknown> }>,
) {
	const toolSchema = Type.Object({ value: Type.String() });
	const tool: AgentTool<typeof toolSchema, Record<string, unknown>> = {
		name: "echo",
		label: "Echo",
		description: "Echo tool",
		parameters: toolSchema,
		execute: async (_toolCallId, params) => execute(params),
	};
	return tool;
}

function stuckScript(name: string, args: Record<string, unknown>, length = 30): ScriptEntry[] {
	return Array.from({ length }, (_, index) => ({ type: "toolCall", id: `call-${index}`, name, arguments: args }));
}

async function runLoop(
	tools: AgentContext["tools"],
	script: ScriptEntry[],
	configOverrides?: Partial<AgentLoopConfig>,
): Promise<{ messages: AgentMessage[]; events: AgentEvent[] }> {
	const context: AgentContext = { systemPrompt: "", messages: [], tools };
	const config: AgentLoopConfig = {
		model: createModel(),
		convertToLlm: identityConverter,
		limits: { maxModelCalls: 40 },
		...configOverrides,
	};
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, scriptedStreamFn(script));
	for await (const event of stream) events.push(event);
	return { messages: await stream.result(), events };
}

function toolResultTexts(messages: AgentMessage[]): string[] {
	return messages
		.filter((message) => message.role === "toolResult")
		.flatMap((message) =>
			(message.role === "toolResult" ? message.content : []).map((part) => (part.type === "text" ? part.text : "")),
		);
}

describe("doom-loop detection in agentLoop", () => {
	it("blocks the exact repeat after the threshold and terminates when the model keeps retrying", async () => {
		const executions: string[] = [];
		const tool = createEchoTool(async (params) => {
			executions.push(params.value);
			return { content: [{ type: "text", text: "same output" }], details: {} };
		});

		const { messages, events } = await runLoop([tool], stuckScript("echo", { value: "hello" }));

		// 3 real executions (default threshold), then two blocked attempts: warning + terminal stop.
		expect(executions).toEqual(["hello", "hello", "hello"]);
		const texts = toolResultTexts(messages);
		const warnings = texts.filter((text) => text.includes("was not executed"));
		expect(warnings.length).toBe(2);
		expect(warnings[0]).toContain('"echo"');
		expect(warnings[0]).toContain("3 consecutive times");
		expect(warnings[0]).not.toContain("has been stopped");
		expect(warnings[1]).toContain("has been stopped");
		// The run ends instead of consuming the whole script / hitting the model-call limit.
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		const toolExecutionEnds = events.filter((event) => event.type === "tool_execution_end");
		expect(toolExecutionEnds.length).toBe(5);
	});

	it("never blocks when results keep changing", async () => {
		let counter = 0;
		const tool = createEchoTool(async () => {
			counter++;
			return { content: [{ type: "text", text: `output ${counter}` }], details: {} };
		});
		const script = [...stuckScript("echo", { value: "poll" }, 6), { type: "text" as const, text: "finished" }];

		const { messages } = await runLoop([tool], script);

		expect(counter).toBe(6);
		expect(toolResultTexts(messages).every((text) => !text.includes("was not executed"))).toBe(true);
	});

	it("never blocks when arguments differ between calls", async () => {
		const executions: string[] = [];
		const tool = createEchoTool(async (params) => {
			executions.push(params.value);
			return { content: [{ type: "text", text: "identical output" }], details: {} };
		});
		const script: ScriptEntry[] = [
			...Array.from({ length: 6 }, (_, index) => ({
				type: "toolCall" as const,
				id: `call-${index}`,
				name: "echo",
				arguments: { value: `item-${index}` },
			})),
			{ type: "text", text: "done" },
		];

		const { messages } = await runLoop([tool], script);

		expect(executions.length).toBe(6);
		expect(toolResultTexts(messages).every((text) => !text.includes("was not executed"))).toBe(true);
	});

	it("breaks the chain when a different call intervenes, then re-detects a fresh chain", async () => {
		const executions: string[] = [];
		const tool = createEchoTool(async (params) => {
			executions.push(params.value);
			return { content: [{ type: "text", text: `same ${params.value}` }], details: {} };
		});
		const x = (index: number): ScriptEntry => ({
			type: "toolCall",
			id: `x-${index}`,
			name: "echo",
			arguments: { value: "x" },
		});
		const y = (index: number): ScriptEntry => ({
			type: "toolCall",
			id: `y-${index}`,
			name: "echo",
			arguments: { value: "y" },
		});
		// x,x,x arms the chain; the blocked retry is attempted; then y breaks the chain;
		// x,x,x again re-arms it — proving detection restarts rather than staying permanently armed.
		const script = [x(0), x(1), x(2), x(3), y(0), x(4), x(5), x(6), x(7), { type: "text" as const, text: "end" }];

		const { messages } = await runLoop([tool], script);

		const texts = toolResultTexts(messages);
		const warnings = texts.filter((text) => text.includes("was not executed"));
		expect(warnings.length).toBeGreaterThanOrEqual(2);
		// x executed at least the 6 non-blocked times (3 + 3), y once.
		expect(executions.filter((value) => value === "y").length).toBe(1);
	});

	it("respects custom thresholds", async () => {
		const executions: string[] = [];
		const tool = createEchoTool(async (params) => {
			executions.push(params.value);
			return { content: [{ type: "text", text: "same output" }], details: {} };
		});

		const { messages } = await runLoop([tool], stuckScript("echo", { value: "hello" }), {
			doomLoop: { maxConsecutiveRepeats: 2, maxBlockedAttempts: 1 },
		});

		expect(executions).toEqual(["hello", "hello"]);
		const warnings = toolResultTexts(messages).filter((text) => text.includes("was not executed"));
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("2 consecutive times");
		expect(warnings[0]).toContain("has been stopped");
	});

	it("does nothing when disabled, leaving repetition to the generic limits", async () => {
		let counter = 0;
		const tool = createEchoTool(async () => {
			counter++;
			return { content: [{ type: "text", text: "same output" }], details: {} };
		});

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			doomLoop: false,
			limits: { maxModelCalls: 6 },
		};
		const stream = agentLoop(
			[createUserMessage("go")],
			context,
			config,
			undefined,
			scriptedStreamFn(stuckScript("echo", { value: "hello" })),
		);
		const events: AgentEvent[] = [];
		let failure: unknown;
		try {
			for await (const event of stream) events.push(event);
			await stream.result();
		} catch (error) {
			failure = error;
		}

		// The repetition is only stopped by the generic model-call budget, never by doom-loop blocking.
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("model_calls limit exceeded");
		expect(counter).toBeGreaterThan(3);
		const blocked = events.filter(
			(event) =>
				event.type === "tool_execution_end" &&
				typeof event.result.details === "object" &&
				event.result.details !== null &&
				"doomLoop" in event.result.details,
		);
		expect(blocked.length).toBe(0);
	});

	it("detects error loops the same way as success loops", async () => {
		const tool = createEchoTool(async () => {
			throw new Error("permission denied");
		});

		const { events, messages } = await runLoop([tool], stuckScript("echo", { value: "hello" }));

		const warnings = toolResultTexts(messages).filter((text) => text.includes("was not executed"));
		expect(warnings.length).toBe(2);
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
	});

	it("keeps tool execution events consistent for blocked calls", async () => {
		const tool = createEchoTool(async () => ({ content: [{ type: "text", text: "same output" }], details: {} }));

		const { events } = await runLoop([tool], stuckScript("echo", { value: "hello" }));

		const starts = events.filter((event) => event.type === "tool_execution_start").length;
		const ends = events.filter((event) => event.type === "tool_execution_end").length;
		expect(starts).toBe(ends);
		for (const end of events.filter((event) => event.type === "tool_execution_end")) {
			if (end.type !== "tool_execution_end") continue;
			if (
				end.isError &&
				typeof end.result.details === "object" &&
				end.result.details !== null &&
				"doomLoop" in end.result.details
			) {
				expect(end.result.content[0].type).toBe("text");
			}
		}
	});
});

describe("stableSignature", () => {
	it("is invariant to object key order", () => {
		expect(stableSignature({ a: 1, b: { c: 2, d: 3 } })).toBe(stableSignature({ b: { d: 3, c: 2 }, a: 1 }));
	});

	it("distinguishes different values", () => {
		expect(stableSignature({ a: 1 })).not.toBe(stableSignature({ a: 2 }));
		expect(stableSignature([1, 2])).not.toBe(stableSignature([2, 1]));
	});

	it("drops undefined object entries like JSON serialization does", () => {
		expect(stableSignature({ a: undefined, b: 1 })).toBe(stableSignature({ b: 1 }));
	});
});

describe("doomLoopResultText", () => {
	it("joins text content and marks non-text parts", () => {
		expect(
			doomLoopResultText([{ type: "text", text: "alpha" }, { type: "image" }, { type: "text", text: "beta" }]),
		).toBe("alpha\n<image>\nbeta");
	});
});

describe("createDoomLoopDetector unit behavior", () => {
	it("does not arm before the threshold", () => {
		const detector = createDoomLoopDetector({ maxConsecutiveRepeats: 3 });
		detector.recordResult("echo", { v: 1 }, "same", false);
		detector.recordResult("echo", { v: 1 }, "same", false);
		expect(detector.checkBeforeExecution("echo", { v: 1 })).toBeUndefined();
		detector.recordResult("echo", { v: 1 }, "same", false);
		expect(detector.checkBeforeExecution("echo", { v: 1 })).toBeDefined();
	});

	it("rejects invalid thresholds", () => {
		expect(() => createDoomLoopDetector({ maxConsecutiveRepeats: 0 })).toThrow(RangeError);
		expect(() => createDoomLoopDetector({ maxBlockedAttempts: -1 })).toThrow(RangeError);
	});
});
