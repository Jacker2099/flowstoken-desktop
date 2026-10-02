/** Native remote endpoint tests must never send Windows native PIDs to an MSYS signal implementation. */
export function assertNativePosixTestHost(platform: NodeJS.Platform = process.platform): void {
	if (platform !== "darwin" && platform !== "linux") {
		throw new Error("Native POSIX SSH tests require macOS/Linux; use the release SSH platform runner on Windows");
	}
}
