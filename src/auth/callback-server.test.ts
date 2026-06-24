import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CallbackServer } from "./callback-server.js";

describe("CallbackServer", () => {
	const servers: CallbackServer[] = [];

	function tracked(server: CallbackServer): CallbackServer {
		servers.push(server);
		return server;
	}

	afterEach(() => {
		for (const s of servers) s.stop();
		servers.length = 0;
	});

	describe("start()", () => {
		it("assigns a port when called without arguments", async () => {
			const server = tracked(new CallbackServer());
			await server.start();
			expect(server.port).toBeGreaterThan(0);
		});

		it("uses the preferred port when available", async () => {
			// Find a free port first
			const tempServer = http.createServer();
			const freePort = await new Promise<number>((resolve) => {
				tempServer.listen(0, "127.0.0.1", () => {
					const addr = tempServer.address();
					resolve(typeof addr === "object" && addr ? addr.port : 0);
				});
			});
			tempServer.close();

			const server = tracked(new CallbackServer());
			await server.start(freePort);
			expect(server.port).toBe(freePort);
		});

		it("falls back to a random port when preferred port is in use", async () => {
			// Occupy a port
			const blocker = http.createServer();
			const occupiedPort = await new Promise<number>((resolve) => {
				blocker.listen(0, "127.0.0.1", () => {
					const addr = blocker.address();
					resolve(typeof addr === "object" && addr ? addr.port : 0);
				});
			});

			try {
				const server = tracked(new CallbackServer());
				await server.start(occupiedPort);
				expect(server.port).toBeGreaterThan(0);
				expect(server.port).not.toBe(occupiedPort);
			} finally {
				blocker.close();
			}
		});
	});

	describe("waitForCallback()", () => {
		it("resolves the authorization code when state matches", async () => {
			const server = tracked(new CallbackServer());
			await server.start();

			const callback = server.waitForCallback(5_000, "expected-state");
			await new Promise<void>((resolve, reject) => {
				http
					.get(`http://127.0.0.1:${server.port}/callback?code=abc&state=expected-state`, (res) => {
						res.resume();
						res.on("end", resolve);
					})
					.on("error", reject);
			});

			await expect(callback).resolves.toBe("abc");
		});

		it("rejects a callback with mismatched state", async () => {
			const server = tracked(new CallbackServer());
			await server.start();

			const callback = server.waitForCallback(5_000, "expected-state");
			const expectation = expect(callback).rejects.toThrow("Invalid OAuth state");
			await new Promise<void>((resolve, reject) => {
				http
					.get(`http://127.0.0.1:${server.port}/callback?code=abc&state=wrong-state`, (res) => {
						res.resume();
						res.on("end", resolve);
					})
					.on("error", reject);
			});

			await expectation;
		});
	});
});
