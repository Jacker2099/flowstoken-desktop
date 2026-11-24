import { describe, expect, it } from "vitest";
import {
	type AutomationDraft,
	automationDraftFrom,
	automationDraftToInput,
	automationDraftToPatch,
	canSubmitAutomationDraft,
	emptyAutomationDraft,
} from "./automation-draft";

function draftWith(patch: Partial<AutomationDraft>): AutomationDraft {
	return { ...emptyAutomationDraft({ conversationCwd: "C:/default", template: "t", now: 0 }), ...patch };
}

describe("automation draft title", () => {
	it("lets a new task be created with only a prompt and titles it from the prompt's first line", () => {
		const draft = draftWith({ prompt: "\n  Summarize today's commits  \nThen email me" });
		expect(canSubmitAutomationDraft(draft)).toBe(true);
		expect(automationDraftToInput(draft).name).toBe("Summarize today's commits");
	});

	it("skips the leading skill token, falls back to the skill name, and truncates long lines", () => {
		expect(automationDraftToInput(draftWith({ prompt: "@skill:review Check open PRs" })).name).toBe("Check open PRs");
		expect(automationDraftToInput(draftWith({ prompt: "@skill:review " })).name).toBe("review");
		expect(automationDraftToInput(draftWith({ prompt: "长".repeat(50) })).name).toBe(`${"长".repeat(40)}…`);
	});

	it("keeps an explicit title and still requires a prompt", () => {
		expect(automationDraftToInput(draftWith({ name: "  Daily  ", prompt: "Summarize" })).name).toBe("Daily");
		expect(canSubmitAutomationDraft(draftWith({ name: "Daily", prompt: "   " }))).toBe(false);
	});
});

describe("automation draft activeHours/idleOnly mapping", () => {
	const defaults = { conversationCwd: "C:/conv", template: "tpl", now: 1000 };

	it("round-trips active hours and idleOnly through input and draft", () => {
		const source = {
			name: "t",
			prompt: "p",
			schedule: { kind: "daily" as const, hour: 9, minute: 0 },
			runTarget: { mode: "new-session" as const, projectCwd: "C:/p" },
			activeHours: { startHour: 22, endHour: 7 },
			idleOnly: true,
			enabled: true,
		};
		const draft = automationDraftFrom(source, defaults);
		expect(draft.activeHoursEnabled).toBe(true);
		expect(draft.activeHoursStart).toBe(22);
		expect(draft.activeHoursEnd).toBe(7);
		expect(draft.idleOnly).toBe(true);

		const input = automationDraftToInput(draft);
		expect(input.activeHours).toEqual({ startHour: 22, endHour: 7 });
		expect(input.idleOnly).toBe(true);
	});

	it("omits activeHours when disabled and clears it explicitly in the patch", () => {
		const draft = { ...emptyAutomationDraft(defaults), name: "t", prompt: "p" };
		expect(automationDraftToInput(draft).activeHours).toBeUndefined();
		expect(automationDraftToInput(draft).idleOnly).toBe(false);
		expect(automationDraftToPatch(draft).activeHours).toBeNull();
	});
});
