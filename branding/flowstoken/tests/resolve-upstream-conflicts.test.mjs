import assert from "node:assert/strict";
import test from "node:test";
import { mergeJson, resolveAddOnlyHunks } from "../../../scripts/flowstoken/resolve-upstream-conflicts.mjs";

test("JSON: keys FlowsToken changed keep ours, everything else follows upstream", () => {
	const base = { version: "0.5.59", a: "x", nested: { k1: "base", k2: "base" }, removedUpstream: 1 };
	const ours = { version: "0.6.0", a: "x", nested: { k1: "ours", k2: "base" }, removedUpstream: 1, ftOnly: true };
	const theirs = { version: "0.5.60", a: "y", nested: { k1: "theirs", k2: "theirs", k3: "new" } };
	assert.deepEqual(mergeJson(base, ours, theirs), {
		version: "0.6.0",
		a: "y",
		nested: { k1: "ours", k2: "theirs", k3: "new" },
		ftOnly: true,
	});
});

test("text: both sides appending to the same union keeps both with one terminator", () => {
	const text = ['\t| "tabRemote"', "<<<<<<< ours", '\t| "tabFlowstoken";', "||||||| base", "=======", '\t| "tabSshHosts";', ">>>>>>> theirs", "", "next"].join("\n");
	assert.equal(resolveAddOnlyHunks(text), ['\t| "tabRemote"', '\t| "tabSshHosts"', '\t| "tabFlowstoken";', "", "next"].join("\n"));
});

test("text: a hunk that edits existing lines is refused", () => {
	const text = ["<<<<<<< ours", "const a = 1;", "||||||| base", "const a = 0;", "=======", "const a = 2;", ">>>>>>> theirs"].join("\n");
	assert.equal(resolveAddOnlyHunks(text), null);
});

test("text: real upstream shape — both sides un-terminate the last item and append one", () => {
	const text = ["<<<<<<< HEAD", '\t| "tabRemote"', '\t| "tabFlowstoken";', "||||||| base", '\t| "tabRemote";', "=======", '\t| "tabRemote"', '\t| "tabSshHosts";', ">>>>>>> upstream/main"].join("\n");
	assert.equal(resolveAddOnlyHunks(text), ['\t| "tabRemote"', '\t| "tabSshHosts"', '\t| "tabFlowstoken";'].join("\n"));
});

test("text: upstream renaming the shared item is refused", () => {
	const text = ["<<<<<<< HEAD", '\t| "tabRemote"', '\t| "tabFlowstoken";', "||||||| base", '\t| "tabRemote";', "=======", '\t| "tabRemoteHosts"', '\t| "tabSshHosts";', ">>>>>>> upstream/main"].join("\n");
	assert.equal(resolveAddOnlyHunks(text), null);
});
