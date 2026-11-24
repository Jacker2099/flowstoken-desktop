import { describe, expect, it } from "vitest";
import { isAutomationActiveHours, isWithinActiveHours } from "./automation.js";

function at(hour: number): Date {
	return new Date(2026, 0, 5, hour, 30, 0);
}

describe("isWithinActiveHours", () => {
	it("covers the whole day when start equals end", () => {
		expect(isWithinActiveHours({ startHour: 9, endHour: 9 }, at(3))).toBe(true);
		expect(isWithinActiveHours({ startHour: 0, endHour: 0 }, at(15))).toBe(true);
	});

	it("includes both boundaries for same-day windows", () => {
		const window = { startHour: 9, endHour: 18 };
		expect(isWithinActiveHours(window, at(9))).toBe(true);
		expect(isWithinActiveHours(window, at(18))).toBe(true);
		expect(isWithinActiveHours(window, at(8))).toBe(false);
		expect(isWithinActiveHours(window, at(19))).toBe(false);
	});

	it("wraps overnight windows across midnight", () => {
		const window = { startHour: 22, endHour: 7 };
		expect(isWithinActiveHours(window, at(22))).toBe(true);
		expect(isWithinActiveHours(window, at(3))).toBe(true);
		expect(isWithinActiveHours(window, at(7))).toBe(true);
		expect(isWithinActiveHours(window, at(12))).toBe(false);
		expect(isWithinActiveHours(window, at(21))).toBe(false);
	});
});

describe("isAutomationActiveHours", () => {
	it("accepts valid windows and rejects invalid shapes", () => {
		expect(isAutomationActiveHours({ startHour: 0, endHour: 23 })).toBe(true);
		expect(isAutomationActiveHours({ startHour: -1, endHour: 12 })).toBe(false);
		expect(isAutomationActiveHours({ startHour: 9, endHour: 24 })).toBe(false);
		expect(isAutomationActiveHours({ startHour: 9.5, endHour: 12 })).toBe(false);
		expect(isAutomationActiveHours({ startHour: 9, endHour: 12, extra: 1 })).toBe(false);
		expect(isAutomationActiveHours({ startHour: 9 })).toBe(false);
		expect(isAutomationActiveHours(null)).toBe(false);
	});
});
