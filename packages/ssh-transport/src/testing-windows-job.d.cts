export interface NativeWindowsTestJob {
	assign(pid: number, creationTicks: string): void;
	terminate(): void;
	activeProcesses(): number;
	close(): void;
}
export function createNativeWindowsTestJob(): NativeWindowsTestJob;
export function createWindowsTestJobWithApi(api: unknown): NativeWindowsTestJob;
