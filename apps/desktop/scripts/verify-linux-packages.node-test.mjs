import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	parseDebContents,
	parseDebFields,
	parseRpmFields,
	readExpectedVersion,
	verifyLinuxPackageInspection,
} from "./verify-linux-packages.mjs";

const paths = [
	"/opt/Vetta/Vetta",
	"/opt/Vetta/resources/package-type",
	"/usr/share/applications/vetta.desktop",
	"/usr/share/icons/hicolor/512x512/apps/vetta.png",
];

test("Linux package inspection accepts matching Debian and RPM packages", () => {
	assert.doesNotThrow(() =>
		verifyLinuxPackageInspection({
			expectedVersion: "1.2.3",
			deb: { name: "vetta", version: "1.2.3", arch: "amd64", paths },
			rpm: { name: "vetta", version: "1.2.3", arch: "x86_64", paths },
		}),
	);
});

test("Linux package inspection rejects wrong identities and incomplete payloads", () => {
	assert.throws(
		() =>
			verifyLinuxPackageInspection({
				expectedVersion: "1.2.3",
				deb: { name: "vetta", version: "1.2.2", arch: "amd64", paths },
				rpm: { name: "vetta", version: "1.2.3", arch: "x86_64", paths },
			}),
		/Debian version 1\.2\.2 does not match 1\.2\.3/,
	);
	assert.throws(
		() =>
			verifyLinuxPackageInspection({
				expectedVersion: "1.2.3",
				deb: { name: "vetta", version: "1.2.3", arch: "amd64", paths },
				rpm: { name: "vetta", version: "1.2.3", arch: "x86_64", paths: paths.slice(1) },
			}),
		/RPM package is missing \/opt\/Vetta\/Vetta/,
	);
});

test("package command output parsers normalize Debian and RPM metadata", () => {
	assert.deepEqual(
		parseDebFields("Package: vetta\nVersion: 1.2.3\nArchitecture: amd64\nDescription: Vetta\n"),
		{ name: "vetta", version: "1.2.3", arch: "amd64" },
	);
	assert.deepEqual(parseRpmFields("vetta\n1.2.3\nx86_64\n"), {
		name: "vetta",
		version: "1.2.3",
		arch: "x86_64",
	});
	assert.deepEqual(
		parseDebContents(
			"-rwxr-xr-x root/root 123 2026-01-01 00:00 ./opt/Vetta/Vetta\n" +
				"lrwxrwxrwx root/root 0 2026-01-01 00:00 ./usr/bin/vetta -> /opt/Vetta/Vetta\n",
		),
		["/opt/Vetta/Vetta", "/usr/bin/vetta"],
	);
});

test("native package verification uses the release manifest version", async () => {
	const releaseDir = await mkdtemp(join(tmpdir(), "vetta-linux-packages-"));
	try {
		await writeFile(join(releaseDir, "latest-linux.yml"), "version: 9.8.7\n");
		assert.equal(await readExpectedVersion(releaseDir), "9.8.7");
	} finally {
		await rm(releaseDir, { recursive: true, force: true });
	}
});

test("Linux package inspection accepts FlowsToken install paths from env", () => {
	const previousProduct = process.env.VETTA_PRODUCT_NAME;
	const previousExecutable = process.env.VETTA_EXECUTABLE_NAME;
	process.env.VETTA_PRODUCT_NAME = "FlowsToken";
	process.env.VETTA_EXECUTABLE_NAME = "FlowsToken";
	const flowPaths = [
		"/opt/FlowsToken/FlowsToken",
		"/opt/FlowsToken/resources/package-type",
		"/usr/share/applications/flowstoken.desktop",
		"/usr/share/icons/hicolor/512x512/apps/flowstoken.png",
	];
	try {
		assert.doesNotThrow(() =>
			verifyLinuxPackageInspection({
				expectedVersion: "1.2.3",
				deb: { name: "vetta", version: "1.2.3", arch: "amd64", paths: flowPaths },
				rpm: { name: "vetta", version: "1.2.3", arch: "x86_64", paths: flowPaths },
			}),
		);
	} finally {
		if (previousProduct === undefined) delete process.env.VETTA_PRODUCT_NAME;
		else process.env.VETTA_PRODUCT_NAME = previousProduct;
		if (previousExecutable === undefined) delete process.env.VETTA_EXECUTABLE_NAME;
		else process.env.VETTA_EXECUTABLE_NAME = previousExecutable;
	}
});
