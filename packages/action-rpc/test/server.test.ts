import { expect, it } from "vitest";
import { startLocalRpcServer } from "../src/server.js";

it("reports a busy port to the caller and allows a later restart", async () => {
	const runtime = { actions: { search: () => [], describe: () => ({}), run: () => ({}) } };
	const options = { host: "127.0.0.1", token: "test-token" };
	const first = await startLocalRpcServer(runtime, options);
	const port = Number(new URL(first.endpoint.url).port);
	try {
		await expect(startLocalRpcServer(runtime, { ...options, port })).rejects.toMatchObject({ code: "EADDRINUSE" });
	} finally {
		await first.close();
	}
	const restarted = await startLocalRpcServer(runtime, { ...options, port });
	try {
		expect(await (await fetch(new URL("/health", restarted.endpoint.url))).json()).toEqual({ ok: true });
	} finally {
		await restarted.close();
	}
});
