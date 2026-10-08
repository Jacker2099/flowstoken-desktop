import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function resolveDesktopExecutableName(env = process.env) {
	const value = env.VETTA_EXECUTABLE_NAME?.trim() || env.VETTA_PRODUCT_NAME?.trim();
	return value && value.length > 0 ? value : "Vetta";
}

const platform = process.platform;
const architecture = process.arch;

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`[desktop-upgrade-e2e] ${name} is required`);
	return value;
}

function version(value, name) {
	if (!VERSION_PATTERN.test(value)) throw new Error(`[desktop-upgrade-e2e] ${name} must be x.y.z`);
	return value;
}

function compareVersions(left, right) {
	const a = left.split(".").map(Number);
	const b = right.split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		if (a[index] !== b[index]) return a[index] - b[index];
	}
	return 0;
}

function feedBase(value) {
	const url = new URL(value);
	const isLocalHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
	if (url.protocol !== "https:" && !isLocalHttp) {
		throw new Error("[desktop-upgrade-e2e] update URL must use HTTPS (or local HTTP for a fixture feed)");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("[desktop-upgrade-e2e] update URL must not contain credentials, query, or hash");
	}
	return `${url.toString().replace(/\/+$/, "")}/`;
}

function metadataFile() {
	if (platform === "win32") return "latest.yml";
	if (platform === "darwin") return "latest-mac.yml";
	return "latest-linux.yml";
}

function artifactMatches(fileName) {
	const lower = fileName.toLowerCase();
	if (platform === "win32") return lower.endsWith(".exe") && lower.includes("-win-x64");
	if (platform === "linux") return lower.endsWith(".appimage");
	if (!lower.endsWith(".zip")) return false;
	return architecture === "arm64" ? lower.includes("arm64") : !lower.includes("arm64");
}

async function fetchResponse(url) {
	const response = await fetch(url, { headers: { "cache-control": "no-cache" } });
	if (!response.ok) throw new Error(`[desktop-upgrade-e2e] HTTP ${response.status}: ${url}`);
	return response;
}

async function download(url, destination) {
	const response = await fetchResponse(url);
	if (!response.body) throw new Error(`[desktop-upgrade-e2e] empty response body: ${url}`);
	await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function resolveCandidate(baseUrl, expectedVersion) {
	const metadataUrl = new URL(metadataFile(), baseUrl);
	const document = parse(await (await fetchResponse(metadataUrl)).text());
	if (document?.version !== expectedVersion) {
		throw new Error(
			`[desktop-upgrade-e2e] ${metadataFile()} is ${String(document?.version)}, expected ${expectedVersion}`,
		);
	}
	const files = Array.isArray(document.files) ? document.files : [];
	const selected = files.find((file) => typeof file?.url === "string" && artifactMatches(basename(file.url)));
	const reference = selected?.url ?? document.path;
	if (typeof reference !== "string" || !artifactMatches(basename(reference))) {
		throw new Error(`[desktop-upgrade-e2e] no ${platform}/${architecture} update artifact in ${metadataFile()}`);
	}
	return { metadataUrl: metadataUrl.toString(), artifactUrl: new URL(reference, metadataUrl).toString() };
}

function baselineArtifactName(buildVersion) {
	const productName = resolveDesktopExecutableName();
	if (platform === "win32") return `${productName}-${buildVersion}-win-x64.exe`;
	if (platform === "linux") return `${productName}-${buildVersion}.AppImage`;
	return architecture === "arm64" ? `${productName}-${buildVersion}-arm64-mac.zip` : `${productName}-${buildVersion}-mac.zip`;
}

async function installBaseline(installerPath, installRoot) {
	if (platform === "win32") {
		const args = [
			"/VERYSILENT",
			"/SUPPRESSMSGBOXES",
			"/NORESTART",
			"/CLOSEAPPLICATIONS",
			`/DIR=${installRoot}`,
		];
		await new Promise((resolve, reject) => {
			const child = spawn(installerPath, args, { stdio: "inherit", windowsHide: true });
			child.once("error", reject);
			child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Inno exited with ${code}`))));
		});
		return join(installRoot, `${resolveDesktopExecutableName()}.exe`);
	}
	if (platform === "linux") {
		await chmod(installerPath, 0o755);
		return installerPath;
	}
	const extractedRoot = join(installRoot, "extracted");
	await mkdir(extractedRoot, { recursive: true });
	await new Promise((resolve, reject) => {
		const child = spawn("ditto", ["-x", "-k", installerPath, extractedRoot], { stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ditto exited with ${code}`))));
	});
	const appPath = join(extractedRoot, `${resolveDesktopExecutableName()}.app`);
	const installedApp = join(installRoot, `${resolveDesktopExecutableName()}.app`);
	await rm(installedApp, { recursive: true, force: true });
	await rename(appPath, installedApp);
	return join(installedApp, "Contents", "MacOS", resolveDesktopExecutableName());
}

function statePath(home) {
	return join(home, "desktop-upgrade-e2e.json");
}

async function launch(binary, environment, logPath) {
	const log = createWriteStream(logPath, { flags: "a" });
	await new Promise((resolve, reject) => {
		log.once("open", resolve);
		log.once("error", reject);
	});
	const child = spawn(binary, [], { env: environment, stdio: ["ignore", log, log], detached: false });
	child.once("error", (error) => log.write(`${error.stack ?? error}\n`));
	return child;
}

async function waitForVerification(paths, child, timeoutMs, installGraceMs = 0) {
	const deadline = Date.now() + timeoutMs;
	let lastState;
	let installingSince;
	while (Date.now() < deadline) {
		for (const path of paths) {
			try {
				const candidate = JSON.parse(await readFile(path, "utf8"));
				const stamp = (s) => {
					const t = Date.parse(s?.updatedAt ?? "");
					return Number.isFinite(t) ? t : -1;
				};
				if (!lastState || stamp(candidate) > stamp(lastState)) lastState = candidate;
			} catch (error) {
				if (error instanceof SyntaxError) continue;
				if (error instanceof Error && !error.message.includes("ENOENT")) throw error;
			}
		}
		if (lastState?.phase === "verified") return { state: lastState, installStalled: false };
		if (lastState?.phase === "failed") throw new Error(lastState.error || "upgrade probe failed");
		if (installGraceMs > 0 && lastState?.phase === "installing") {
			installingSince ??= Date.now();
			if (Date.now() - installingSince >= installGraceMs) {
				return { state: lastState, installStalled: true };
			}
		} else {
			installingSince = undefined;
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	if (!child.killed) child.kill();
	throw new Error(`[desktop-upgrade-e2e] timed out waiting for verification; last state=${JSON.stringify(lastState)}`);
}

function taskkill(args) {
	try {
		execFileSync("taskkill", args, { stdio: "ignore" });
	} catch {
		// The target may already have exited; cleanup is best-effort.
	}
}

/**
 * Windows baselines released before the executable-name fix spawn the Inno
 * installer through electron-updater's NSIS path, so it opens an interactive
 * wizard that can never finish on a headless runner. Once the baseline has
 * proven the real feed/download/install trigger ("installing"), this takes
 * over with the same silent background-update command a fixed build runs:
 * the real installer, the real versioned store, and a real relaunched process.
 */
async function installCandidateWithInno(root, candidate, candidateVersion, baselineVersion) {
	const executableName = resolveDesktopExecutableName();
	const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const storeRoot = join(localAppData, executableName);
	const installerName = basename(decodeURIComponent(new URL(candidate.artifactUrl).pathname));

	for (const image of [installerName, installerName.replace(/\.exe$/i, ".tmp")]) {
		taskkill(["/F", "/T", "/IM", image]);
	}
	// Give Inno's setup mutex a beat to release after the stalled wizard dies.
	await new Promise((resolve) => setTimeout(resolve, 2000));

	const cachedInstaller = join(localAppData, "vetta-updater", "pending", installerName);
	const installerPath = join(root, installerName);
	if (existsSync(cachedInstaller)) {
		await copyFile(cachedInstaller, installerPath);
	} else {
		await download(candidate.artifactUrl, installerPath);
	}

	const progressPath = join(root, "inno-progress.txt");
	const installLogPath = join(root, "inno-install.log");
	const args = [
		"/VERYSILENT",
		"/SUPPRESSMSGBOXES",
		"/NORESTART",
		"/NOCLOSEAPPLICATIONS",
		"/NORESTARTAPPLICATIONS",
		"/SP-",
		"/VETTAUPDATE=true",
		`/VETTASTOREROOT=${storeRoot}`,
		`/VETTAPROGRESS=${progressPath}`,
		`/LOG=${installLogPath}`,
	];
	await new Promise((resolve, reject) => {
		const child = spawn(installerPath, args, { stdio: "inherit", windowsHide: true });
		child.once("error", reject);
		child.once("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`Inno update exited with ${code}; see ${installLogPath}`)),
		);
	});

	const versionDir = join(storeRoot, "versions", candidateVersion);
	const executablePath = join(versionDir, `${executableName}.exe`);
	for (const requiredPath of [
		executablePath,
		join(versionDir, "resources", "app.asar"),
		join(versionDir, ".install-complete"),
	]) {
		if (!existsSync(requiredPath)) {
			throw new Error(`[desktop-upgrade-e2e] simulated Inno update missing ${requiredPath}`);
		}
	}
	await writeFile(
		join(storeRoot, "current.json"),
		`${JSON.stringify({ version: candidateVersion, previousVersion: baselineVersion, pending: true })}\n`,
		"utf8",
	);
	return executablePath;
}

async function main() {
	if (!["win32", "darwin", "linux"].includes(platform)) {
		throw new Error(`[desktop-upgrade-e2e] unsupported platform: ${platform}`);
	}
	const baseUrl = feedBase(required("VETTA_DESKTOP_UPGRADE_URL"));
	const baselineVersion = version(required("VETTA_DESKTOP_UPGRADE_BASELINE"), "baseline version");
	const candidateVersion = version(required("VETTA_DESKTOP_UPGRADE_CANDIDATE"), "candidate version");
	if (compareVersions(candidateVersion, baselineVersion) <= 0) {
		throw new Error("[desktop-upgrade-e2e] candidate version must be greater than baseline version");
	}

	const requestedWorkdir = process.env.VETTA_DESKTOP_UPGRADE_WORKDIR?.trim();
	const root = await import("node:fs/promises").then(({ mkdtemp }) =>
		mkdtemp(join(requestedWorkdir || tmpdir(), "vetta-upgrade-e2e-")),
	);
	const home = join(root, "home");
	const installRoot = join(root, "installed");
	const state = statePath(home);
	const logPath = join(root, "desktop.log");
	await mkdir(home, { recursive: true });
	await mkdir(installRoot, { recursive: true });
	const baselinePath = join(root, baselineArtifactName(baselineVersion));
	const baselineUrl = new URL(baselineArtifactName(baselineVersion), baseUrl).toString();
	console.log(`[desktop-upgrade-e2e] downloading baseline ${baselineUrl}`);
	await download(baselineUrl, baselinePath);
	const binary = await installBaseline(baselinePath, installRoot);
	await writeFile(
		state,
		`${JSON.stringify({ phase: "pending", baselineVersion, expectedVersion: candidateVersion }, null, 2)}\n`,
		"utf8",
	);
	const candidate = await resolveCandidate(baseUrl, candidateVersion);
	console.log(`[desktop-upgrade-e2e] candidate ${candidate.artifactUrl}`);
	const environment = {
		...process.env,
		VETTA_E2E: "1",
		VETTA_E2E_UPGRADE: "1",
		VETTA_E2E_UPDATE_URL: baseUrl,
		VETTA_E2E_UPGRADE_STATE: state,
		VETTA_HOME: home,
		VETTA_CONFIG_DIR: ".vetta-upgrade-e2e",
		VETTA_SPEECH_INPUT_ENABLED: "false",
	};
	const child = await launch(binary, environment, logPath);
	// ShipIt/NSIS relaunch the app without our env, so the updated process can only
	// report through the ~/.vetta fallback marker; poll both copies.
	const watchPaths = [state, join(homedir(), ".vetta", "desktop-upgrade-e2e.json")];
	const verifyDeadline = (platform === "linux" ? 10 : 15) * 60 * 1000;
	let result;
	if (platform === "win32") {
		// 修复前的 Windows 基线走到 install 时会用 NSIS 参数拉起 Inno 安装器：
		// 交互式向导在无人值守 runner 上永远等不到点击。停滞超过宽限期就由脚本
		// 用同一套静默后台更新参数跑完真实安装器，再验证重启后的新版本进程。
		const installGraceMs = 2 * 60 * 1000;
		const first = await waitForVerification(watchPaths, child, verifyDeadline, installGraceMs);
		if (first.installStalled) {
			console.log(
				"[desktop-upgrade-e2e] baseline stalled at installing; driving the Inno background update directly",
			);
			taskkill(["/F", "/T", "/PID", String(child.pid)]);
			const executablePath = await installCandidateWithInno(
				root,
				candidate,
				candidateVersion,
				baselineVersion,
			);
			const updated = await launch(executablePath, environment, logPath);
			result = (await waitForVerification(watchPaths, updated, 10 * 60 * 1000)).state;
		} else {
			result = first.state;
		}
	} else {
		result = (await waitForVerification(watchPaths, child, verifyDeadline)).state;
	}
	console.log(`[desktop-upgrade-e2e] verified ${result.currentVersion}; log=${logPath}`);
	await rm(join(homedir(), ".vetta", "desktop-upgrade-e2e.json"), { force: true });
	await rm(root, { recursive: true, force: true });
}

export { artifactMatches, baselineArtifactName, compareVersions, metadataFile };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
