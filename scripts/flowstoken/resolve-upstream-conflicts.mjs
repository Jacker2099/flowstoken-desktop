#!/usr/bin/env node
// Resolves the merge conflicts of an upstream (Open Vetta) sync with fixed, reviewable rules and refuses
// everything else, so an automatic sync either lands a FlowsToken-preserving merge or stops.
//
//   *.json                      3-way key merge: keys FlowsToken changed keep our value, the rest follow upstream
//   .github/release-notes/*.md  keep ours when we have the file (release notes are per product version)
//   bun.lock                    take upstream; the workflow re-runs `bun install` afterwards
//   text hunks where both sides only ADDED lines (empty merge-base section) keep both, upstream first
//
// Any other conflict exits 2 and lists the files. Requires `merge.conflictStyle=diff3` for text hunks.
// usage: node scripts/flowstoken/resolve-upstream-conflicts.mjs   (run inside a conflicted merge)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const stage = (n, path) => {
	try {
		return git("show", `:${n}:${path}`);
	} catch {
		return undefined;
	}
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mergeJson(base, ours, theirs) {
	if (same(ours, base)) return theirs;
	if (same(theirs, base) || same(ours, theirs)) return ours;
	if (isObject(ours) && isObject(theirs)) {
		const b = isObject(base) ? base : {};
		const out = {};
		for (const key of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
			const value = mergeJson(b[key], ours[key], theirs[key]);
			if (value !== undefined) out[key] = value;
		}
		return out;
	}
	return ours;
}

function detectIndent(text) {
	const m = /\n([ \t]+)"/.exec(text ?? "");
	return m ? m[1] : "\t";
}

/** Resolves diff3 hunks whose base section is empty (both sides appended). Returns null if any hunk is not. */
export function resolveAddOnlyHunks(text) {
	const lines = text.split("\n");
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (!lines[i].startsWith("<<<<<<< ")) {
			out.push(lines[i]);
			continue;
		}
		const ours = [];
		const base = [];
		const theirs = [];
		let section = ours;
		let j = i + 1;
		for (; j < lines.length && !lines[j].startsWith(">>>>>>> "); j++) {
			if (lines[j].startsWith("||||||| ")) section = base;
			else if (lines[j] === "=======") section = theirs;
			else section.push(lines[j]);
		}
		if (j >= lines.length) return null;
		// Both sides may have turned the last list item into a non-terminal one before appending
		// (`| "a";` -> `| "a"` + new item). Strip the identical leading lines and accept the hunk only when
		// the merge base equals them modulo a trailing `;`/`,` terminator, i.e. both sides purely appended.
		let prefix = 0;
		while (prefix < ours.length && prefix < theirs.length && ours[prefix] === theirs[prefix]) prefix++;
		const stripTerm = (l) => l.replace(/[;,]\s*$/, "");
		const common = ours.slice(0, prefix);
		const baseLines = base.filter((l) => l.trim() !== "");
		const baseMatches =
			baseLines.length === 0 ||
			(baseLines.length === common.length && baseLines.every((l, k) => stripTerm(l) === stripTerm(common[k])));
		if (!baseMatches) return null;
		const merged = [...common, ...theirs.slice(prefix), ...ours.slice(prefix)];
		// Two union terminators appended at the same spot: only the last line keeps the ';'.
		for (let k = 0; k < merged.length - 1; k++) {
			if (/^\s*\|.*;\s*$/.test(merged[k]) && /^\s*\|/.test(merged[k + 1])) merged[k] = merged[k].replace(/;\s*$/, "");
		}
		out.push(...merged);
		i = j;
	}
	return out.join("\n");
}

function main() {
	const conflicted = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
	const unresolved = [];
	for (const path of conflicted) {
		let resolved = false;
		if (path.endsWith(".json")) {
			const [b, o, t] = [1, 2, 3].map((n) => stage(n, path));
			try {
				const merged = mergeJson(b ? JSON.parse(b) : undefined, o ? JSON.parse(o) : undefined, t ? JSON.parse(t) : undefined);
				if (merged !== undefined) {
					writeFileSync(path, `${JSON.stringify(merged, null, detectIndent(o ?? t))}\n`);
					resolved = true;
				}
			} catch {
				resolved = false;
			}
		} else if (/^\.github\/release-notes\/.+\.md$/.test(path) && stage(2, path) !== undefined) {
			writeFileSync(path, stage(2, path));
			resolved = true;
		} else if (path === "bun.lock" && stage(3, path) !== undefined) {
			writeFileSync(path, stage(3, path));
			resolved = true;
		} else if (existsSync(path)) {
			const merged = resolveAddOnlyHunks(readFileSync(path, "utf8"));
			if (merged !== null) {
				writeFileSync(path, merged);
				resolved = true;
			}
		}
		if (resolved) {
			git("add", "--", path);
			console.log(`resolved ${path}`);
		} else {
			unresolved.push(path);
		}
	}
	if (unresolved.length > 0) {
		console.error(`unresolved conflicts (${unresolved.length}):\n${unresolved.join("\n")}`);
		process.exit(2);
	}
	console.log(`all ${conflicted.length} conflicts resolved`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
