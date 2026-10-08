// Disposable native E2E boundary: never installed into the application or a real user profile.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const MARKER = "login-recovery-fixture.json";
const PROFILE_PREFIX = "flowstoken-login-e2e-";
const GROUPS = [
	{ id: "default", providerId: "flowstoken-default", title: "Ordinary fixture", tokenName: "FlowsToken-Desktop-普通", tokenId: 101 },
	{ id: "smart", providerId: "flowstoken-smart", title: "Smart fixture", tokenName: "FlowsToken-Desktop-智能", tokenId: 102 },
	{ id: "vip", providerId: "flowstoken-official", title: "Official fixture", tokenName: "FlowsToken-Desktop-官方", tokenId: 103 },
];
const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");
const writeJson = (file, value) => {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
};

function validateProfile(home) {
	if (!home || !path.isAbsolute(home)) throw new Error("Login recovery requires its disposable absolute profile");
	const real = fs.realpathSync(home);
	if (path.dirname(real) !== fs.realpathSync(os.tmpdir()) || !path.basename(real).startsWith(PROFILE_PREFIX))
		throw new Error("Login recovery may only use a dedicated temporary profile");
	const marker = JSON.parse(fs.readFileSync(path.join(real, MARKER), "utf8"));
	if (marker.kind !== "flowstoken-login-recovery" || marker.schema !== 1 || marker.home !== real)
		throw new Error("Login recovery profile marker is invalid");
	if (!["fresh", "mixed-legacy"].includes(marker.profile) || typeof marker.initiallyAuthenticated !== "boolean" ||
		!["embedded", "system-browser"].includes(marker.authMode) ||
		!marker.records || typeof marker.records !== "object" ||
		Object.entries(marker.records).some(([name, hash]) => !/^[a-f\d]{64}\.credential\.json$/.test(name) || !/^[a-f\d]{64}$/.test(hash)))
		throw new Error("Login recovery fixture identity is invalid");
	return marker;
}

function prepareLoginRecoveryProfile() {
	if (process.env.VETTA_E2E_LOGIN_RECOVERY !== "1") throw new Error("Login recovery mode must be explicit");
	if (process.env.VETTA_E2E_PACKAGED === "1") throw new Error("Login recovery uses the newly built source app only");
	const profile = process.env.VETTA_E2E_LOGIN_RECOVERY_PROFILE || "mixed-legacy";
	if (!["fresh", "mixed-legacy"].includes(profile)) throw new Error("Unknown login recovery profile");
	const authMode = process.env.VETTA_E2E_LOGIN_RECOVERY_AUTH || "embedded";
	if (!["embedded", "system-browser"].includes(authMode)) throw new Error("Unknown login recovery authorization mode");
	if (process.env.VETTA_E2E_LOGIN_HOME) {
		const existing = validateProfile(process.env.VETTA_E2E_LOGIN_HOME);
		if (existing.profile !== profile || existing.authMode !== authMode) throw new Error("Login recovery profile changed within one run");
		return existing;
	}
	const home = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), PROFILE_PREFIX)));
	fs.mkdirSync(path.join(home, "chromium"), { mode: 0o700 });
	const providers = {};
	const records = {};
	for (const group of profile === "mixed-legacy" ? GROUPS : []) {
		providers[group.providerId] = {
			source: "template", templateId: group.providerId, api: "openai-completions", baseUrl: "https://www.flowstoken.com/v1",
			credentialRef: `legacy-managed-${group.id}`,
			managedGroup: { source: "flowstoken", groupId: group.id, accountId: 7, tokenId: group.tokenId },
			models: [{ id: "fixture-chat", name: "Fixture Chat", input: ["text"] }],
		};
	}
	if (profile === "mixed-legacy") {
		providers.openai = { source: "template", templateId: "openai", credentialRef: "personal-encrypted", models: [{ id: "gpt-preserved" }] };
		providers["personal-legacy"] = { apiKey: "fixture-legacy-plaintext-preserved", models: [{ id: "legacy-preserved" }] };
	}
	for (const provider of Object.values(providers)) {
		if (!provider.credentialRef) continue;
		const ref = { namespace: "models", ownerId: provider.credentialRef, name: "api-key" };
		const name = `${sha256(JSON.stringify([ref.namespace, ref.ownerId, ref.name]))}.credential.json`;
		const file = path.join(home, "desktop-app", "credentials", name);
		writeJson(file, {
			schemaVersion: 1, ref, backend: "electron-safe-storage", ciphertext: Buffer.from("deliberately-not-decryptable-fixture").toString("base64"),
			createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
		});
		records[name] = sha256(fs.readFileSync(file));
	}
	writeJson(path.join(home, "agent", "models.json"), { ...(profile === "mixed-legacy" ? { defaultModel: "flowstoken-default/fixture-chat" } : {}), providers });
	const marker = {
		kind: "flowstoken-login-recovery", schema: 1, home, profile, authMode, records,
		initiallyAuthenticated: profile === "mixed-legacy" && process.env.VETTA_E2E_LOGIN_RECOVERY_SIGNIN !== "1",
		customProviders: profile === "mixed-legacy" ? { openai: providers.openai, "personal-legacy": providers["personal-legacy"] } : {},
	};
	writeJson(path.join(home, MARKER), marker);
	process.env.VETTA_E2E_LOGIN_HOME = home;
	return marker;
}

function loopback(host) {
	return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(String(host).toLowerCase());
}

function requestHost(input, next) {
	if (Array.isArray(input)) return requestHost(input[0], input[1]);
	if (typeof input === "number") return typeof next === "string" ? next : "localhost";
	if (typeof input === "string" && (input.startsWith("/") || input.startsWith("\\\\.\\pipe\\"))) return "localhost";
	if (input?.socketPath || (input?.path && !input.hostname && !input.host && !input.servername)) return "localhost";
	if (typeof input === "string" || input instanceof URL) return new URL(input).hostname;
	const host = input?.hostname || input?.host || input?.servername || "localhost";
	if (loopback(host)) return host;
	return String(host).replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
}

function installNodeNetworkFence(home) {
	const marker = Symbol.for("flowstoken.loginRecovery.networkFence");
	if (globalThis[marker]) return;
	globalThis[marker] = true;
	const guard = (host) => {
		if (loopback(host)) return;
		// WDIO's Node-side CDP client uses the local driver's wildcard bind address.
		if (!process.versions.electron && host === "0.0.0.0") return;
		fs.appendFileSync(path.join(home, `blocked-network-${process.pid}.log`), `${String(host).replace(/[\r\n]/g, "")}\n`, { mode: 0o600 });
		throw new Error("External network is blocked by the isolated login recovery fixture");
	};
	for (const moduleName of ["node:http", "node:https"]) {
		const transport = require(moduleName);
		for (const name of ["request", "get"]) {
			const original = transport[name];
			transport[name] = function (...args) { guard(requestHost(args[0], args[1])); return original.apply(this, args); };
		}
	}
	for (const [moduleName, names] of [["node:net", ["connect", "createConnection"]], ["node:tls", ["connect"]]]) {
		const transport = require(moduleName);
		for (const name of names) {
			const original = transport[name];
			transport[name] = function (...args) { guard(requestHost(args[0], args[1])); return original.apply(this, args); };
		}
	}
	const socketPrototype = require("node:net").Socket.prototype;
	const originalSocketConnect = socketPrototype.connect;
	socketPrototype.connect = function (...args) { guard(requestHost(args[0], args[1])); return originalSocketConnect.apply(this, args); };
	const datagram = require("node:dgram");
	const originalDatagramConnect = datagram.Socket.prototype.connect;
	datagram.Socket.prototype.connect = function (port, address, ...args) {
		guard(typeof address === "string" ? address : "localhost");
		return originalDatagramConnect.call(this, port, address, ...args);
	};
	const originalDatagramSend = datagram.Socket.prototype.send;
	datagram.Socket.prototype.send = function (...args) {
		const address = typeof args[3] === "number" ? args[4] : args[2];
		try { guard(typeof address === "string" ? address : "localhost"); }
		catch (error) {
			const callback = args.at(-1);
			if (typeof callback !== "function") throw error;
			queueMicrotask(() => callback(error));
			return;
		}
		return originalDatagramSend.apply(this, args);
	};
	const originalFetch = globalThis.fetch;
	if (originalFetch) globalThis.fetch = (input, init) => { guard(new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname); return originalFetch(input, init); };
	const childProcess = require("node:child_process");
	const originalExecFileSync = childProcess.execFileSync;
	const allowedExecutables = new Set();
	if (!process.versions.electron) {
		allowedExecutables.add(fs.realpathSync(process.execPath));
		const { createRequire } = require("node:module");
		const tsxRequire = createRequire(require.resolve("tsx/package.json"));
		const esbuildRequire = createRequire(tsxRequire.resolve("esbuild/package.json"));
		const esbuildBinary = esbuildRequire.resolve(`@esbuild/${process.platform}-${process.arch}/${process.platform === "win32" ? "esbuild.exe" : "bin/esbuild"}`);
		allowedExecutables.add(fs.realpathSync(esbuildBinary));
		for (const file of [process.env.CHROMEDRIVER_PATH, require("electron")]) {
			if (typeof file === "string" && path.isAbsolute(file) && fs.existsSync(file)) allowedExecutables.add(fs.realpathSync(file));
		}
	}
	for (const name of ["exec", "execSync"]) childProcess[name] = (command, options) => {
		// electron-liquid-glass checks only the OS version. Execute the fixed
		// binary directly instead of permitting an arbitrary shell command.
		if (name === "execSync" && process.platform === "darwin" && command === "sw_vers -productVersion")
			return originalExecFileSync("/usr/bin/sw_vers", ["-productVersion"], options);
		throw new Error("Shell execution is blocked by the login recovery fixture");
	};
	for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
		const original = childProcess[name];
		childProcess[name] = function (file, ...args) {
			const options = args.find((value) => value && typeof value === "object" && !Array.isArray(value));
			if (options?.shell || !path.isAbsolute(file) || !fs.existsSync(file) || !allowedExecutables.has(fs.realpathSync(file)))
				throw new Error("External subprocess is blocked by the login recovery fixture");
			if (options?.env && (options.env.VETTA_E2E_LOGIN_HOME !== home || (fs.realpathSync(file) === fs.realpathSync(process.execPath) && !options.env.NODE_OPTIONS?.includes(__filename))))
				throw new Error("Subprocess cannot remove the isolated login recovery boundary");
			return original.call(this, file, ...args);
		};
	}
	const originalFork = childProcess.fork;
	childProcess.fork = function (modulePath, ...args) {
		const options = args.find((value) => value && typeof value === "object" && !Array.isArray(value));
		if (process.versions.electron || options?.execPath || (options?.env && (options.env.VETTA_E2E_LOGIN_HOME !== home || !options.env.NODE_OPTIONS?.includes(__filename))))
			throw new Error("Subprocess cannot remove the isolated login recovery boundary");
		return originalFork.call(this, modulePath, ...args);
	};
	require("node:module").syncBuiltinESMExports();
}

function installElectronBoundary(marker) {
	if (!process.versions.electron || process.type !== "browser") return;
	if (globalThis.__flowstokenLoginRecoveryFixture) return;
	if (process.env.VETTA_E2E !== "1" || fs.realpathSync(process.env.VETTA_HOME) !== marker.home)
		throw new Error("Electron login recovery requires E2E mode and its dedicated profile");
	const { app, BrowserWindow, nativeTheme, net, session, safeStorage, shell } = require("electron");
	if (app.isReady()) throw new Error("Login fixture must load before app.ready");
	writeJson(path.join(marker.home, "fixture-installed.json"), { electron: process.versions.electron, role: process.type, ready: false });
	app.setPath("userData", path.join(marker.home, "chromium"));
	const state = { installedBeforeReady: true, authMode: marker.authMode, initiallyAuthenticated: marker.initiallyAuthenticated, authenticated: marker.initiallyAuthenticated, loginWindowsOpened: 0, systemBrowserLaunches: 0, desktopExchanges: 0, importedRefreshCookies: 0, safeStorage: { isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 }, requests: [], blocked: [], unhandledErrors: [], rateLimitUntil: 0, rateLimitedResponses: 0 };
	const cookieStores = new WeakMap();
	const authorizationCodes = new Map();
	const user = { id: 7, username: "login-e2e", display_name: "Login Recovery E2E", quota: 500000, used_quota: 0, request_count: 0 };
	const sessionId = "00000000-0000-4000-8000-000000000007";
	const refreshCookie = () => ({ name: "new_api_refresh", value: `fixture-refresh.${sessionId}`, domain: "www.flowstoken.com", hostOnly: true, path: "/api/user/auth", secure: true, httpOnly: true, sameSite: "strict", expirationDate: Math.floor(Date.now() / 1000) + 3600 });
	const recordUnhandled = (error) => {
		state.unhandledErrors.push(error instanceof Error ? error.name : typeof error);
		writeJson(path.join(marker.home, "unhandled-errors.json"), state.unhandledErrors);
	};
	process.on("unhandledRejection", recordUnhandled);
	process.on("uncaughtExceptionMonitor", recordUnhandled);
	const tokens = marker.profile === "fresh" ? [] : GROUPS.map((group) => ({ id: group.tokenId, name: group.tokenName, group: group.id, status: 1 }));
	for (const method of Object.keys(state.safeStorage)) {
		Object.defineProperty(safeStorage, method, { configurable: true, value: () => {
			state.safeStorage[method]++;
			writeJson(path.join(marker.home, "safe-storage-call.json"), state.safeStorage);
			throw new Error(`Unexpected safeStorage.${method} in isolated startup`);
		} });
	}
	const catalog = {
		schema: 2, revision: "native-login-fixture", generated: 1, pricingVersion: "native-fixture", newWindowDays: 30,
		iconBase: "https://www.flowstoken.com/brand/vendor-icons/",
		groups: GROUPS.map((group) => ({
			id: group.id, providerId: group.providerId, title: group.title, titles: { en: group.title, zh: group.title }, subtitle: "", defaultModel: "fixture-chat",
			vendors: [{ id: "fixture", name: "Fixture", icon: null, mono: false, models: [{ id: "fixture-chat", name: "Fixture Chat", released: null, tags: [], vision: false, image: false, kind: "chat" }] }],
		})),
	};
	const externalFetch = async (input, init = {}, currentSession) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (loopback(url.hostname)) throw new Error("Unexpected loopback fetch in the account boundary");
		state.requests.push({ host: url.hostname, path: url.pathname, method: init.method || "GET" });
		if (url.origin === "https://www.flowstoken.com") {
			if (url.pathname === "/brand/desktop-catalog-v2.json") return Response.json(catalog);
			if (url.pathname.startsWith("/api/")) {
				if (Date.now() < state.rateLimitUntil) {
					state.rateLimitedResponses++;
					return Response.json({ success: false, message: "fixture rate limit" }, { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil((state.rateLimitUntil - Date.now()) / 1000))) } });
				}
				let data;
				if (url.pathname === "/api/user/auth/desktop/exchange") {
					const input = JSON.parse(String(init.body));
					const grant = authorizationCodes.get(input.code);
					if (init.method !== "POST" || !grant || input.client_id !== "flowstoken-desktop" || input.redirect_uri !== grant.redirectUri ||
						crypto.createHash("sha256").update(input.code_verifier).digest("base64url") !== grant.challenge || !currentSession || currentSession === accountSession)
						throw new Error("Invalid isolated desktop authorization exchange or staging boundary");
					authorizationCodes.delete(input.code);
					cookieStores.set(currentSession, [refreshCookie()]);
					state.desktopExchanges++;
					return Response.json({ success: true, data: { access_token: "fixture-account-access", session: { sid: sessionId }, user } });
				}
				const authenticated = url.pathname === "/api/user/auth/refresh"
					? currentSession === accountSession && cookieStores.get(currentSession)?.some((cookie) => cookie.name === "new_api_refresh" && cookie.value === refreshCookie().value)
					: new Headers(init.headers).get("Authorization") === "Bearer fixture-account-access";
				if (!authenticated) return Response.json({ success: false, message: "fixture signed out" }, { status: 401 });
				if (url.pathname === "/api/user/auth/refresh") data = { access_token: "fixture-account-access", session: { sid: sessionId }, user };
				else if (url.pathname === "/api/user/self/groups") data = { default: {}, smart: {}, vip: {} };
				else if (url.pathname === "/api/log/self") data = { items: [] };
				else if (url.pathname === "/api/token/" && (init.method || "GET") === "GET") data = { items: [...tokens] };
				else if (url.pathname === "/api/token/" && init.method === "POST") {
					const input = JSON.parse(String(init.body));
					const group = GROUPS.find((entry) => entry.id === input.group && entry.tokenName === input.name);
					if (!group || tokens.some((entry) => entry.group === group.id)) throw new Error("Unexpected or duplicate fixture token creation");
					tokens.push({ id: group.tokenId, name: group.tokenName, group: group.id, status: 1 });
					data = {};
				}
				else {
					const group = GROUPS.find((entry) => url.pathname === `/api/token/${entry.tokenId}/key`);
					if (group) data = { key: `fixture-managed-${group.id}` };
					else throw new Error(`Unexpected account fixture endpoint: ${url.pathname}`);
				}
				return Response.json({ success: true, data });
			}
		}
		if (url.origin === "https://models.dev" && url.pathname === "/api.json") return Response.json({ openai: { models: {} } });
		state.blocked.push({ host: url.hostname, path: url.pathname });
		throw new Error("Unconfigured external request blocked by login recovery fixture");
	};
	const realNetFetch = net.fetch.bind(net);
	net.fetch = (input, init) => loopback(new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname) ? realNetFetch(input, init) : externalFetch(input, init);
	const realNetRequest = net.request.bind(net);
	net.request = (options) => {
		if (!loopback(typeof options === "string" ? new URL(options).hostname : options.hostname || (options.url ? new URL(options.url).hostname : options.host)))
			throw new Error("Unconfigured Electron request blocked by login recovery fixture");
		return realNetRequest(options);
	};
	const installed = new WeakSet();
	let accountSession;
	let systemBrowserSession;
	const installSession = (current) => {
		if (installed.has(current)) return;
		installed.add(current);
		current.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*", "ws://*/*", "wss://*/*"] }, (details, callback) => {
			const url = new URL(details.url);
			const fixturePage = url.origin === "https://www.flowstoken.com" &&
				((current === accountSession && ["/login", "/console"].includes(url.pathname)) || (current === systemBrowserSession && url.pathname === "/auth/desktop"));
			callback({ cancel: !loopback(url.hostname) && !fixturePage });
		});
		const original = current.fetch.bind(current);
		current.fetch = (input, init) => loopback(new URL(typeof input === "string" || input instanceof URL ? input : input.url).hostname) ? original(input, init) : externalFetch(input, init, current);
		cookieStores.set(current, []);
		current.cookies.get = async (filter = {}) => (cookieStores.get(current) || []).filter((cookie) => !filter.name || cookie.name === filter.name).map((cookie) => ({ ...cookie }));
		current.cookies.set = async (details) => {
			if (current !== accountSession || details.url !== "https://www.flowstoken.com/api/user/auth" || details.name !== "new_api_refresh" ||
				details.value !== refreshCookie().value || details.path !== "/api/user/auth" || details.domain !== undefined ||
				details.secure !== true || details.httpOnly !== true || details.sameSite !== "strict")
				throw new Error("Unexpected isolated cookie import");
			cookieStores.set(current, [{ ...details, domain: "www.flowstoken.com", hostOnly: true }]);
			state.authenticated = true;
			state.importedRefreshCookies++;
		};
		current.cookies.remove = async (_url, name) => { cookieStores.set(current, (cookieStores.get(current) || []).filter((cookie) => cookie.name !== name)); };
		current.cookies.flushStore = async () => {};
		current.clearStorageData = async () => { cookieStores.set(current, []); };
	};
	shell.openExternal = async (target) => {
		if (marker.authMode !== "system-browser") throw new Error("External browser launch blocked by isolated fixture");
		const url = new URL(target);
		const redirect = new URL(url.searchParams.get("redirect_uri"));
		const stateValue = url.searchParams.get("state");
		const challenge = url.searchParams.get("code_challenge");
		if (url.origin !== "https://www.flowstoken.com" || url.pathname !== "/auth/desktop" || url.searchParams.get("client_id") !== "flowstoken-desktop" ||
			url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(stateValue) || !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
			redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || Number(redirect.port) < 1024 || redirect.pathname !== "/flowstoken/callback" || redirect.search || redirect.hash || redirect.username || redirect.password)
			throw new Error("Unsafe external authorization fixture URL");
		state.systemBrowserLaunches++;
		const externalWindow = new BrowserWindow({ width: 700, height: 500, title: "Fixture system browser", webPreferences: { session: systemBrowserSession, nodeIntegration: false, contextIsolation: true, sandbox: true } });
		await externalWindow.loadURL(url.toString());
	};
	app.on("session-created", installSession);
	app.once("ready", () => {
		installSession(session.defaultSession);
		const account = session.fromPartition("persist:flowstoken-account");
		accountSession = account;
		installSession(account);
		if (marker.initiallyAuthenticated) cookieStores.set(account, [refreshCookie()]);
		systemBrowserSession = session.fromPartition("flowstoken-login-fixture-system-browser", { cache: false });
		installSession(systemBrowserSession);
		systemBrowserSession.protocol.handle("https", (request) => {
			const url = new URL(request.url);
			if (url.origin !== "https://www.flowstoken.com" || url.pathname !== "/auth/desktop") return new Response("Blocked", { status: 403 });
			const redirectUri = url.searchParams.get("redirect_uri");
			const approve = new URL(redirectUri);
			const deny = new URL(redirectUri);
			const code = crypto.randomBytes(32).toString("base64url");
			authorizationCodes.set(code, { redirectUri, challenge: url.searchParams.get("code_challenge") });
			approve.searchParams.set("state", url.searchParams.get("state"));
			approve.searchParams.set("code", code);
			deny.searchParams.set("state", url.searchParams.get("state"));
			deny.searchParams.set("error", "access_denied");
			const html = `<!doctype html><html><body><h1>Isolated authorized website session</h1><a id="fixture-approve" href="${approve.toString().replaceAll("&", "&amp;")}">Authorize desktop</a><a id="fixture-deny" href="${deny.toString().replaceAll("&", "&amp;")}">Deny authorization</a></body></html>`;
			return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
		});
		account.protocol.handle("https", (request) => {
			const url = new URL(request.url);
			if (url.origin !== "https://www.flowstoken.com" || !["/login", "/console"].includes(url.pathname))
				return new Response("Blocked by isolated fixture", { status: 403 });
			if (url.pathname === "/console") { state.authenticated = true; cookieStores.set(account, [refreshCookie()]); }
			const html = url.pathname === "/login"
				? '<!doctype html><html><body><h1>Isolated sign-in page</h1><button id="fixture-sign-in" onclick="location.href=\'/console\'">Complete fixture sign-in</button></body></html>'
				: '<!doctype html><html><body>Fixture sign-in complete</body></html>';
			return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
		});
	});
	app.on("browser-window-created", (_event, window) => {
		if (window.webContents.session === accountSession) state.loginWindowsOpened++;
		window.once("show", () => {
			if (window.isDestroyed() || !window.webContents.getURL().includes("/index.html")) return;
			const native = { source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
			void window.webContents.executeJavaScript(`({ mode: document.documentElement.dataset.mode, colorScheme: getComputedStyle(document.documentElement).colorScheme, background: getComputedStyle(document.documentElement).getPropertyValue('--background') })`)
				.then((renderer) => { state.firstVisibleTheme = { native, renderer }; })
				.catch(() => { state.firstVisibleTheme = { error: "Could not read the first shown frame" }; });
		});
	});
	const audit = () => {
		const models = JSON.parse(fs.readFileSync(path.join(marker.home, "agent", "models.json"), "utf8"));
		return {
			...state, home: marker.home, profile: marker.profile,
			mockKeychainSwitch: app.commandLine.hasSwitch("use-mock-keychain"),
			preservedCiphertext: Object.entries(marker.records).every(([name, hash]) => sha256(fs.readFileSync(path.join(marker.home, "desktop-app", "credentials", name))) === hash),
			preservedCustomProviders: Object.entries(marker.customProviders).every(([id, provider]) => JSON.stringify(models.providers[id]) === JSON.stringify(provider)),
			managedBindings: GROUPS.map(({ providerId }) => ({ providerId, binding: models.providers[providerId]?.managedGroup, hasPlaintextKey: Object.hasOwn(models.providers[providerId] || {}, "apiKey") })),
		};
	};
	Object.defineProperty(globalThis, "__flowstokenLoginRecoveryFixture", { value: {
		audit,
		rateLimit: (seconds) => {
			if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 20) throw new Error("Invalid fixture cooldown");
			state.rateLimitUntil = Date.now() + seconds * 1000;
			return state.rateLimitUntil;
		},
	} });
	app.on("will-quit", () => writeJson(path.join(marker.home, "native-login-audit.json"), audit()));
}

function installLoginRecoveryElectronBoundary() {
	if (process.env.VETTA_E2E_LOGIN_RECOVERY !== "1" || !process.versions.electron || process.type !== "browser")
		throw new Error("Login recovery bootstrap requires the isolated Electron browser process");
	const marker = validateProfile(process.env.VETTA_E2E_LOGIN_HOME);
	installNodeNetworkFence(marker.home);
	installElectronBoundary(marker);
}

module.exports = { prepareLoginRecoveryProfile, validateProfile, installLoginRecoveryElectronBoundary };

if (process.env.VETTA_E2E_LOGIN_RECOVERY === "1" && process.env.VETTA_E2E_LOGIN_HOME) {
	const marker = validateProfile(process.env.VETTA_E2E_LOGIN_HOME);
	installNodeNetworkFence(marker.home);
	// A WDIO/Node process must never require Electron's native API module.
	if (process.versions.electron && process.type === "browser") installElectronBoundary(marker);
	else if (process.versions.electron && !process.type) throw new Error("Cannot identify the Electron preload role safely");
}
