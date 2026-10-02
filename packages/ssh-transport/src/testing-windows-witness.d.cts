export interface NativeWindowsProcessSnapshot {
	pid: number;
	ppid: number | null;
	image: string;
	createdAt: string;
	creationTicks: string;
	active: boolean;
	exitCode: number | null;
	exitedAt: string | null;
}
export interface NativeWindowsProcessWitness {
	read(): NativeWindowsProcessSnapshot;
	close(): void;
}
export function openNativeWindowsProcessWitness(pid: number): NativeWindowsProcessWitness;
