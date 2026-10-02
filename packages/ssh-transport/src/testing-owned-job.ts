import type { NativeWindowsTestJob } from "./testing-windows-job.cjs";

export interface OwnedJobState {
	job: NativeWindowsTestJob;
	assigned: boolean;
	stopped: boolean;
}
export interface OwnedJobPeer {
	pid: number | undefined;
	alive(): boolean;
	killOwned(): void;
	launch(): void;
}

export function stopOwnedJob(state: OwnedJobState, peer: OwnedJobPeer): void {
	state.stopped = true;
	if (state.assigned) state.job.terminate();
	else if (peer.alive()) peer.killOwned();
}

export function acceptOwnedJobReady(state: OwnedJobState, peer: OwnedJobPeer, message: unknown): boolean {
	if (!message || typeof message !== "object" || !("type" in message) || message.type !== "owned-supervisor-ready")
		return false;
	if (state.stopped || !peer.alive()) return false;
	if (
		!("pid" in message) ||
		typeof message.pid !== "number" ||
		!Number.isSafeInteger(message.pid) ||
		message.pid <= 1 ||
		message.pid !== peer.pid ||
		!("creationTicks" in message) ||
		typeof message.creationTicks !== "string"
	)
		throw new Error("Owned supervisor identity handshake mismatch");
	state.job.assign(message.pid, message.creationTicks);
	state.assigned = true;
	peer.launch();
	return true;
}

export async function waitForOwnedJobEmpty(job: Pick<NativeWindowsTestJob, "activeProcesses">): Promise<void> {
	const deadline = Date.now() + 1500;
	while (job.activeProcesses() !== 0) {
		if (Date.now() >= deadline) throw new Error("Owned Windows job did not become empty after real process close");
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

/** Serialized into the Node supervisor; contains no OS-specific process or signal implementation. */
export function waitForOwnedSupervisorLaunch(
	channel: { once(event: string, handler: (message?: unknown) => void): unknown },
	launch: () => void,
	exitWaiting: () => void,
): void {
	let started = false;
	channel.once("disconnect", () => {
		if (!started) exitWaiting();
	});
	channel.once("message", (message) => {
		if (!message || typeof message !== "object" || !("type" in message) || message.type !== "start-owned-shell") {
			exitWaiting();
			return;
		}
		started = true;
		launch();
	});
}
