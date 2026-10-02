// A private, unnamed OS job owns only the fixture supervisor assigned by its parent.
let loaded;
function bindings() {
	if (process.platform !== "win32") throw new Error("Native loopback job requires Windows");
	if (loaded) return loaded;
	const koffi = require("koffi"),
		kernel = koffi.load("kernel32.dll");
	const basic = koffi.struct({
		PerProcessUserTimeLimit: "int64_t",
		PerJobUserTimeLimit: "int64_t",
		LimitFlags: "uint32_t",
		MinimumWorkingSetSize: "size_t",
		MaximumWorkingSetSize: "size_t",
		ActiveProcessLimit: "uint32_t",
		Affinity: "uintptr_t",
		PriorityClass: "uint32_t",
		SchedulingClass: "uint32_t",
	});
	const io = koffi.struct({
		ReadOperationCount: "uint64_t",
		WriteOperationCount: "uint64_t",
		OtherOperationCount: "uint64_t",
		ReadTransferCount: "uint64_t",
		WriteTransferCount: "uint64_t",
		OtherTransferCount: "uint64_t",
	});
	const extended = koffi.struct({
		BasicLimitInformation: basic,
		IoInfo: io,
		ProcessMemoryLimit: "size_t",
		JobMemoryLimit: "size_t",
		PeakProcessMemoryUsed: "size_t",
		PeakJobMemoryUsed: "size_t",
	});
	const accounting = koffi.struct({
		TotalUserTime: "int64_t",
		TotalKernelTime: "int64_t",
		ThisPeriodTotalUserTime: "int64_t",
		ThisPeriodTotalKernelTime: "int64_t",
		TotalPageFaultCount: "uint32_t",
		TotalProcesses: "uint32_t",
		ActiveProcesses: "uint32_t",
		TotalTerminatedProcesses: "uint32_t",
	});
	const time = koffi.struct({ low: "uint32_t", high: "uint32_t" });
	const outTime = koffi.out(koffi.pointer(time));
	loaded = {
		extendedSize: koffi.sizeof(extended),
		flagsOffset: koffi.offsetof(basic, "LimitFlags"),
		accountingSize: koffi.sizeof(accounting),
		activeOffset: koffi.offsetof(accounting, "ActiveProcesses"),
		CreateJob: kernel.func("__stdcall", "CreateJobObjectW", "void *", ["void *", "char16_t *"]),
		SetInfo: kernel.func("__stdcall", "SetInformationJobObject", "int32_t", [
			"void *",
			"uint32_t",
			"void *",
			"uint32_t",
		]),
		QueryInfo: kernel.func("__stdcall", "QueryInformationJobObject", "int32_t", [
			"void *",
			"uint32_t",
			"void *",
			"uint32_t",
			"void *",
		]),
		Assign: kernel.func("__stdcall", "AssignProcessToJobObject", "int32_t", ["void *", "void *"]),
		Terminate: kernel.func("__stdcall", "TerminateJobObject", "int32_t", ["void *", "uint32_t"]),
		Close: kernel.func("__stdcall", "CloseHandle", "int32_t", ["void *"]),
		OpenProcess: kernel.func("__stdcall", "OpenProcess", "void *", ["uint32_t", "int32_t", "uint32_t"]),
		Wait: kernel.func("__stdcall", "WaitForSingleObject", "uint32_t", ["void *", "uint32_t"]),
		Times: kernel.func("__stdcall", "GetProcessTimes", "int32_t", ["void *", outTime, outTime, outTime, outTime]),
		Error: kernel.func("__stdcall", "GetLastError", "uint32_t", []),
	};
	return loaded;
}

function createWithApi(api) {
	const handle = api.CreateJob(null, null);
	if (!handle) throw new Error(`Create private loopback job failed: ${api.Error()}`);
	let closed = false,
		assigned = false;
	try {
		const limits = Buffer.alloc(api.extendedSize);
		limits.writeUInt32LE(0x2000, api.flagsOffset); // KILL_ON_JOB_CLOSE; neither breakaway flag is allowed.
		if (!api.SetInfo(handle, 9, limits, limits.length))
			throw new Error(`Set private loopback job limits failed: ${api.Error()}`);
	} catch (error) {
		api.Close(handle);
		throw error;
	}
	const requireOpen = () => {
		if (closed) throw new Error("Private loopback job is closed");
	};
	return {
		assign(pid, birth) {
			requireOpen();
			if (assigned || !Number.isSafeInteger(pid) || pid <= 1 || typeof birth !== "string")
				throw new Error("Invalid owned supervisor assignment");
			// The supervisor is waiting on our IPC channel and cannot create Bash yet.
			const processHandle = api.OpenProcess(0x100 | 0x1 | 0x1000 | 0x100000, 0, pid);
			if (!processHandle) throw new Error(`Open owned supervisor for assignment failed: ${api.Error()}`);
			try {
				const created = { low: 0, high: 0 };
				if (!api.Times(processHandle, created, { low: 0, high: 0 }, { low: 0, high: 0 }, { low: 0, high: 0 }))
					throw new Error(`Read supervisor identity failed: ${api.Error()}`);
				const ticks = ((BigInt(created.high) << 32n) | BigInt(created.low)).toString();
				if (ticks !== birth || api.Wait(processHandle, 0) !== 258)
					throw new Error("Owned supervisor identity changed before assignment");
				if (!api.Assign(handle, processHandle))
					throw new Error(`Assign private loopback job failed: ${api.Error()}`);
				assigned = true;
			} finally {
				api.Close(processHandle);
			}
		},
		terminate() {
			requireOpen();
			if (!api.Terminate(handle, 1)) throw new Error(`Terminate private loopback job failed: ${api.Error()}`);
		},
		activeProcesses() {
			requireOpen();
			const data = Buffer.alloc(api.accountingSize);
			if (!api.QueryInfo(handle, 1, data, data.length, null))
				throw new Error(`Query private loopback job failed: ${api.Error()}`);
			return data.readUInt32LE(api.activeOffset);
		},
		close() {
			if (!closed) {
				if (!api.Close(handle)) throw new Error(`Close private loopback job failed: ${api.Error()}`);
				closed = true;
			}
		},
	};
}
exports.createNativeWindowsTestJob = () => createWithApi(bindings());
// External native-call port used only for failure/handle-ownership contract tests.
exports.createWindowsTestJobWithApi = createWithApi;
