// Read-only diagnostics for this fixture's reported native processes. No kill API is bound.
let loaded;

function bindings() {
	if (process.platform !== "win32") throw new Error("Native process witness requires Windows");
	if (loaded) return loaded;
	const koffi = require("koffi");
	const kernel = koffi.load("kernel32.dll");
	const fileTime = koffi.struct({ low: "uint32_t", high: "uint32_t" });
	const entry = koffi.struct({
		dwSize: "uint32_t",
		cntUsage: "uint32_t",
		th32ProcessID: "uint32_t",
		th32DefaultHeapID: "uintptr_t",
		th32ModuleID: "uint32_t",
		cntThreads: "uint32_t",
		th32ParentProcessID: "uint32_t",
		pcPriClassBase: "int32_t",
		dwFlags: "uint32_t",
		szExeFile: koffi.array("uint16_t", 260),
	});
	const outTime = koffi.out(koffi.pointer(fileTime));
	loaded = {
		koffi,
		entrySize: koffi.sizeof(entry),
		pidOffset: koffi.offsetof(entry, "th32ProcessID"),
		parentOffset: koffi.offsetof(entry, "th32ParentProcessID"),
		OpenProcess: kernel.func("__stdcall", "OpenProcess", "void *", ["uint32_t", "int32_t", "uint32_t"]),
		CloseHandle: kernel.func("__stdcall", "CloseHandle", "int32_t", ["void *"]),
		GetLastError: kernel.func("__stdcall", "GetLastError", "uint32_t", []),
		GetProcessTimes: kernel.func("__stdcall", "GetProcessTimes", "int32_t", [
			"void *",
			outTime,
			outTime,
			outTime,
			outTime,
		]),
		WaitForSingleObject: kernel.func("__stdcall", "WaitForSingleObject", "uint32_t", ["void *", "uint32_t"]),
		GetExitCodeProcess: kernel.func("__stdcall", "GetExitCodeProcess", "int32_t", [
			"void *",
			koffi.out(koffi.pointer("uint32_t")),
		]),
		QueryFullProcessImageName: kernel.func("__stdcall", "QueryFullProcessImageNameW", "int32_t", [
			"void *",
			"uint32_t",
			"void *",
			koffi.inout(koffi.pointer("uint32_t")),
		]),
		CreateToolhelp32Snapshot: kernel.func("__stdcall", "CreateToolhelp32Snapshot", "void *", [
			"uint32_t",
			"uint32_t",
		]),
		Process32First: kernel.func("__stdcall", "Process32FirstW", "int32_t", ["void *", "void *"]),
		Process32Next: kernel.func("__stdcall", "Process32NextW", "int32_t", ["void *", "void *"]),
	};
	return loaded;
}

function ticks(time) {
	return (BigInt(time.high) << 32n) | BigInt(time.low);
}
function iso(time) {
	return new Date(Number(ticks(time) / 10000n - 11644473600000n)).toISOString();
}

function parentId(api, pid) {
	const handle = api.CreateToolhelp32Snapshot(2, 0);
	if (!handle || api.koffi.address(handle) === BigInt.asUintN(api.koffi.sizeof("uintptr_t") * 8, -1n)) {
		throw new Error(`Native witness snapshot failed: ${api.GetLastError()}`);
	}
	try {
		const entry = Buffer.alloc(api.entrySize);
		entry.writeUInt32LE(api.entrySize, 0);
		let found = api.Process32First(handle, entry);
		while (found) {
			if (entry.readUInt32LE(api.pidOffset) === pid) return entry.readUInt32LE(api.parentOffset);
			found = api.Process32Next(handle, entry);
		}
		return null;
	} finally {
		api.CloseHandle(handle);
	}
}

function readTimes(api, handle) {
	const created = { low: 0, high: 0 },
		exited = { low: 0, high: 0 };
	if (!api.GetProcessTimes(handle, created, exited, { low: 0, high: 0 }, { low: 0, high: 0 })) {
		throw new Error(`Native witness process times failed: ${api.GetLastError()}`);
	}
	return { created, exited };
}

exports.openNativeWindowsProcessWitness = function openNativeWindowsProcessWitness(pid) {
	if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 0xffffffff) throw new Error("Invalid owned native PID");
	const api = bindings();
	// QUERY_LIMITED_INFORMATION | SYNCHRONIZE. The retained handle anchors identity across samples.
	const handle = api.OpenProcess(0x1000 | 0x100000, 0, pid);
	if (!handle) throw new Error(`Native witness OpenProcess(${pid}) failed: ${api.GetLastError()}`);
	let closed = false;
	try {
		const initial = readTimes(api, handle);
		const ppid = parentId(api, pid);
		const imageBuffer = Buffer.alloc(32768 * 2),
			imageLength = [32768];
		if (!api.QueryFullProcessImageName(handle, 0, imageBuffer, imageLength)) {
			throw new Error(`Native witness image failed: ${api.GetLastError()}`);
		}
		const image = imageBuffer.subarray(0, imageLength[0] * 2).toString("utf16le");
		return {
			read() {
				if (closed) throw new Error("Native witness handle is closed");
				const current = readTimes(api, handle);
				if (ticks(current.created) !== ticks(initial.created)) throw new Error("Native witness identity changed");
				const wait = api.WaitForSingleObject(handle, 0);
				if (wait !== 0 && wait !== 258) throw new Error(`Native witness wait failed: ${api.GetLastError()}`);
				const code = [0];
				if (!api.GetExitCodeProcess(handle, code))
					throw new Error(`Native witness exit code failed: ${api.GetLastError()}`);
				return {
					pid,
					ppid,
					image,
					createdAt: iso(initial.created),
					creationTicks: ticks(initial.created).toString(),
					active: wait === 258,
					exitCode: wait === 0 ? code[0] : null,
					exitedAt: wait === 0 ? iso(current.exited) : null,
				};
			},
			close() {
				if (!closed) {
					closed = true;
					api.CloseHandle(handle);
				}
			},
		};
	} catch (error) {
		api.CloseHandle(handle);
		throw error;
	}
};
