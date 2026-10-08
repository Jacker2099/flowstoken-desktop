import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const { prepareLoginRecoveryProfile, validateProfile } = require("./login-recovery-fixture.cjs");
const preload = path.join(import.meta.dirname, "login-recovery-fixture.cjs");

function withProfile(profile, run) {
	const keys = ["VETTA_E2E_LOGIN_RECOVERY", "VETTA_E2E_LOGIN_RECOVERY_PROFILE", "VETTA_E2E_LOGIN_RECOVERY_AUTH", "VETTA_E2E_LOGIN_HOME", "VETTA_E2E_PACKAGED"];
	const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	let marker;
	try {
		process.env.VETTA_E2E_LOGIN_RECOVERY = "1";
		process.env.VETTA_E2E_LOGIN_RECOVERY_PROFILE = profile;
		delete process.env.VETTA_E2E_LOGIN_RECOVERY_AUTH;
		delete process.env.VETTA_E2E_LOGIN_HOME;
		delete process.env.VETTA_E2E_PACKAGED;
		marker = prepareLoginRecoveryProfile();
		run(marker);
	} finally {
		if (marker) rmSync(marker.home, { recursive: true, force: true });
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

test("fresh and mixed legacy seeds are separate disposable profiles with explicit markers", () => {
	for (const profile of ["fresh", "mixed-legacy"]) withProfile(profile, (marker) => {
		assert.equal(validateProfile(marker.home).profile, profile);
		const models = JSON.parse(readFileSync(path.join(marker.home, "agent", "models.json"), "utf8"));
		assert.equal(Object.keys(models.providers).length, profile === "fresh" ? 0 : 5);
		assert.equal(Object.keys(marker.records).length, profile === "fresh" ? 0 : 4);
		assert.equal(prepareLoginRecoveryProfile().home, marker.home);
		assert.throws(() => validateProfile(process.cwd()), /dedicated temporary profile/);
	});
});

test("preloading in a normal Node worker never accesses Electron APIs and blocks external HTTP options", () => {
	withProfile("fresh", (marker) => {
		const output = execFileSync(process.execPath, ["--require", preload, "--eval", `
const assert = require('node:assert/strict');
assert.equal(process.versions.electron, undefined);
assert.throws(() => require('node:https').request({ hostname: 'fixture.invalid', path: '/test' }), /External network is blocked/);
assert.throws(() => new (require('node:net').Socket)().connect({host: 'fixture.invalid', port: 443}), /External network is blocked/);
assert.throws(() => new (require('node:net').Socket)().connect([{host: 'fixture.invalid', port: 443}]), /External network is blocked/);
const udp = require('node:dgram').createSocket('udp4');
assert.throws(() => udp.send(Buffer.from('test'), 5353, '224.0.0.251'), /External network is blocked/);
assert.throws(() => udp.connect(5353, '224.0.0.251'), /External network is blocked/);
assert.throws(() => require('node:child_process').execSync('sw_vers -productVersion; echo bypass'), /Shell execution is blocked/);
assert.throws(() => require('node:child_process').spawn('/bin/sh', ['-c', 'exit 0']), /External subprocess is blocked/);
assert.throws(() => require('node:child_process').spawn(process.execPath, ['--version'], { shell: true }), /External subprocess is blocked/);
assert.throws(() => require('node:child_process').spawn(process.execPath, ['--version'], { env: {} }), /cannot remove the isolated/);
if (process.platform === 'darwin') assert.match(require('node:child_process').execSync('sw_vers -productVersion', {encoding: 'utf8'}), /^\\d+\\./);
udp.close();
process.stdout.write('guarded-node-worker');
`], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", VETTA_E2E: "1", VETTA_HOME: marker.home } });
		assert.equal(output, "guarded-node-worker");
	});
});

test("packaged apps and unrecognized profile kinds cannot enter source-login fixture mode", () => {
	withProfile("fresh", () => {
		process.env.VETTA_E2E_PACKAGED = "1";
		assert.throws(() => prepareLoginRecoveryProfile(), /newly built source app only/);
		delete process.env.VETTA_E2E_PACKAGED;
		process.env.VETTA_E2E_LOGIN_RECOVERY_PROFILE = "user-profile";
		assert.throws(() => prepareLoginRecoveryProfile(), /Unknown login recovery profile/);
		process.env.VETTA_E2E_LOGIN_RECOVERY_PROFILE = "fresh";
		process.env.VETTA_E2E_LOGIN_RECOVERY_AUTH = "real-browser";
		assert.throws(() => prepareLoginRecoveryProfile(), /Unknown login recovery authorization mode/);
	});
});
