import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallbackServer } from "./callback-server.js";
import { NotionOAuthProvider } from "./provider.js";
import { TokenStore } from "./token-store.js";

describe("NotionOAuthProvider", () => {
	let tmpDir: string;
	let store: TokenStore;
	const callbackServers: CallbackServer[] = [];
	const blockers: http.Server[] = [];

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncli-provider-test-"));
		store = new TokenStore(tmpDir);
	});

	afterEach(async () => {
		for (const server of callbackServers) server.stop();
		callbackServers.length = 0;

		await Promise.all(
			blockers.map(
				(server) =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
					}),
			),
		);
		blockers.length = 0;

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function trackedCallbackServer(): CallbackServer {
		const server = new CallbackServer();
		callbackServers.push(server);
		return server;
	}

	function fakeCallbackServer(options: {
		port?: number;
		start?: (preferredPort?: number) => Promise<void>;
		waitForCallback?: () => Promise<string>;
	}): CallbackServer {
		return {
			get port() {
				return options.port ?? 0;
			},
			start: options.start ?? vi.fn(async () => undefined),
			waitForCallback: options.waitForCallback ?? vi.fn(async () => "callback-code"),
			stop: vi.fn(),
		} as unknown as CallbackServer;
	}

	async function occupyPort(): Promise<number> {
		const blocker = http.createServer();
		blockers.push(blocker);
		return await new Promise<number>((resolve) => {
			blocker.listen(0, "127.0.0.1", () => {
				const addr = blocker.address();
				resolve(typeof addr === "object" && addr ? addr.port : 0);
			});
		});
	}

	it("reads saved tokens without starting the callback server", () => {
		const tokens = {
			access_token: "access-token",
			token_type: "Bearer",
			refresh_token: "refresh-token",
		};
		store.saveTokens(tokens);
		const callbackServer = trackedCallbackServer();
		const provider = new NotionOAuthProvider(store, callbackServer, {
			lazyCallback: true,
			preferredPort: 54975,
		});

		expect(provider.tokens()).toEqual(tokens);
		expect(callbackServer.port).toBe(0);
	});

	it("starts the callback server from clientInformation using the preferred port", async () => {
		const preferredPort = await occupyPort();
		const blocker = blockers.pop();
		await new Promise<void>((resolve) => blocker?.close(() => resolve()));

		store.saveClientInfo({
			client_id: "client-id",
			redirect_uris: [`http://127.0.0.1:${preferredPort}/callback`],
		});
		const callbackServer = trackedCallbackServer();
		const provider = new NotionOAuthProvider(store, callbackServer, {
			lazyCallback: true,
			preferredPort,
		});

		await expect(provider.clientInformation()).resolves.toEqual({
			client_id: "client-id",
			redirect_uris: [`http://127.0.0.1:${preferredPort}/callback`],
		});
		expect(callbackServer.port).toBe(preferredPort);
	});

	it("keeps saved client information on callback port fallback while refresh tokens can be tried", async () => {
		const occupiedPort = await occupyPort();
		const tokens = {
			access_token: "access-token",
			token_type: "Bearer",
			refresh_token: "refresh-token",
		};
		const clientInfo = {
			client_id: "client-id",
			redirect_uris: [`http://127.0.0.1:${occupiedPort}/callback`],
		};
		store.saveTokens(tokens);
		store.saveClientInfo(clientInfo);
		store.saveCodeVerifier("verifier");
		store.saveRestToken("ntn_rest");

		const callbackServer = trackedCallbackServer();
		const provider = new NotionOAuthProvider(store, callbackServer, {
			lazyCallback: true,
			preferredPort: occupiedPort,
		});

		await expect(provider.clientInformation()).resolves.toEqual(clientInfo);

		expect(callbackServer.port).toBeGreaterThan(0);
		expect(callbackServer.port).not.toBe(occupiedPort);
		expect(store.readTokens()).toEqual(tokens);
		expect(store.readClientInfo()).toEqual(clientInfo);
		expect(store.readCodeVerifier()).toBe("verifier");
		expect(store.readRestToken()).toBe("ntn_rest");
	});

	it("stages fallback-port client registration until replacement tokens are saved", async () => {
		const occupiedPort = await occupyPort();
		const tokens = {
			access_token: "old-access-token",
			token_type: "Bearer",
			refresh_token: "old-refresh-token",
		};
		const oldClientInfo = {
			client_id: "old-client-id",
			redirect_uris: [`http://127.0.0.1:${occupiedPort}/callback`],
		};
		const newClientInfo = {
			client_id: "new-client-id",
			redirect_uris: ["http://127.0.0.1:60000/callback"],
		};
		const newTokens = {
			access_token: "new-access-token",
			token_type: "Bearer",
			refresh_token: "new-refresh-token",
		};
		store.saveTokens(tokens);
		store.saveClientInfo(oldClientInfo);
		store.saveCodeVerifier("verifier");

		const callbackServer = trackedCallbackServer();
		const provider = new NotionOAuthProvider(store, callbackServer, {
			lazyCallback: true,
			preferredPort: occupiedPort,
		});

		await provider.clientInformation();
		await provider.invalidateCredentials("tokens");

		await expect(provider.clientInformation()).resolves.toBeUndefined();
		await provider.saveClientInformation(newClientInfo);

		expect(store.readTokens()).toBeUndefined();
		expect(store.readClientInfo()).toEqual(oldClientInfo);

		await provider.saveTokens(newTokens);

		expect(store.readClientInfo()).toEqual(newClientInfo);
		expect(store.readTokens()).toEqual(newTokens);
	});

	it("starts the lazy callback before waiting when redirect has not initialized it", async () => {
		let port = 0;
		const start = vi.fn(async (preferredPort?: number) => {
			port = preferredPort ?? 60000;
		});
		const waitForCallback = vi.fn(async () => "callback-code");
		const callbackServer = fakeCallbackServer({
			get port() {
				return port;
			},
			start,
			waitForCallback,
		});
		const provider = new NotionOAuthProvider(store, callbackServer, {
			lazyCallback: true,
			preferredPort: 60000,
		});

		await expect(provider.waitForCallback()).resolves.toBe("callback-code");

		expect(start).toHaveBeenCalledWith(60000);
		expect(waitForCallback).toHaveBeenCalledTimes(1);
	});

	it("creates a fresh callback wait after a rejected callback promise", async () => {
		const error = new Error("timeout");
		const waitForCallback = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(error)
			.mockResolvedValueOnce("callback-code");
		const callbackServer = fakeCallbackServer({ port: 60000, waitForCallback });
		const provider = new NotionOAuthProvider(store, callbackServer, { lazyCallback: true });

		await expect(provider.waitForCallback()).rejects.toThrow("timeout");
		await expect(provider.waitForCallback()).resolves.toBe("callback-code");

		expect(waitForCallback).toHaveBeenCalledTimes(2);
	});
});
