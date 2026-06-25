---
date: 2026-06-23T18:46:07+0900
author: Yuku Kotani
commit: 0fa46ad
branch: main
repository: notion-cli
topic: concurrent OAuth callback port token clearing
tags: [plan, blueprint, oauth, mcp, callback-server, token-store]
status: ready
parent: .rpiv/artifacts/research/2026-06-23_17-58-29_concurrent-oauth-callback-port-token-clearing.md
phase_count: 2
phases:
  - { n: 1, title: Provider lazy callback foundation }
  - { n: 2, title: MCP connection wiring and documentation }
unresolved_phase_count: 0
last_updated: 2026-06-23T18:46:07+0900
last_updated_by: Yuku Kotani
---

# Concurrent OAuth Callback Port Token Clearing Implementation Plan

## Overview

This plan changes MCP OAuth connection setup so normal commands can reuse valid persisted tokens without binding a local callback port first.
The callback server moves from eager `MCPConnection.connect()` startup into the OAuth provider's authorization path, and callback port contention no longer deletes `tokens.json`, `client.json`, or `auth-state.json` by itself.

## Requirements

- Preserve valid MCP OAuth credentials when multiple `ncli` processes run concurrently and one process already occupies the saved callback port.
- Do not start the callback server on the fast path where saved access tokens authenticate the MCP connection successfully.
- If the SDK enters OAuth/refresh handling after a 401, start the callback server with the saved redirect port when browser authorization may be needed.
- Do not erase REST Integration Token state; this fix must remain MCP OAuth scoped.
- Keep explicit `ncli logout` as the user-controlled path that clears all tokens.
- Update tests that currently encode port mismatch as a destructive trigger.
- Update authentication documentation so it no longer promises token clearing on callback fallback.

## Current State Analysis

`MCPConnection.connect()` currently creates and starts `CallbackServer` before constructing the MCP transport, so every command attempts to bind the saved callback port before token reuse is attempted.
If the actual callback port differs from the saved redirect URI port, `invalidateOAuthStateForPortChange()` immediately calls `TokenStore.deleteOAuthState()`, deleting MCP OAuth credentials before the SDK can prove whether the token/refresh path would work.

### Key Discoveries

- `withConnection()` creates a new `MCPConnection` for each command and always calls `connect()` before command logic (`src/mcp/with-connection.ts:4-13`).
- `MCPConnection.connect()` starts `CallbackServer` before provider/transport creation (`src/mcp/client.ts:18-31`).
- Port mismatch invalidation happens before `client.connect(transport)` (`src/mcp/client.ts:30`, `src/mcp/client.ts:34-45`).
- `CallbackServer.start(preferredPort)` falls back to a random port on `EADDRINUSE` (`src/auth/callback-server.ts:24-55`).
- `TokenStore.deleteOAuthState()` deletes MCP OAuth files but preserves REST token files (`src/auth/token-store.ts:76-79`).
- MCP SDK Streamable HTTP transport reads provider tokens for normal request headers before invoking OAuth auth flow (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:61`).
- SDK auth can refresh tokens without browser authorization when `refresh_token` is present (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js:261-279`).
- SDK token schema stores `expires_in` but no persisted issue timestamp, so this codebase cannot prove token validity locally before contacting the MCP server (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/auth.js:120-129`).
- Current tests expect port mismatch to delete OAuth state (`src/mcp/client.test.ts:38-44`) and must be rewritten for the new contract.
- Current docs state fallback port clears MCP OAuth state (`docs/auth.md:98-105`) and must be updated.

## Desired End State

A normal command with valid saved OAuth tokens connects without opening or binding a callback server:

```ts
const conn = new MCPConnection();
await conn.connect(); // SDK uses provider.tokens(); no CallbackServer.start() on success
await conn.callTool("notion-get-users", { user_id: "self" });
await conn.disconnect();
```

When browser authorization is required, the provider starts the callback server before the SDK builds redirect metadata and keeps the callback promise available for `MCPConnection`:

```ts
try {
	await client.connect(transport);
} catch (error) {
	if (error instanceof UnauthorizedError) {
		console.error("Opening browser for Notion login...");
		const code = await provider.waitForCallback();
		await transport.finishAuth(code);
		// reconnect with new tokens
	}
}
```

A callback port conflict no longer implies credential deletion:

```ts
await provider.clientInformation(); // starts callback server only in SDK auth path
expect(callbackServer.port).not.toBe(savedPort); // fallback happened
expect(store.readTokens()).toEqual(savedTokens); // credentials preserved
```

## What We're NOT Doing

- Not adding cross-process file locks or atomic token-store transactions.
- Not adding a proactive token refresh scheduler; actual validity remains delegated to the MCP server/SDK.
- Not changing REST API auth storage or `rest-token.json` behavior.
- Not changing command output formats.
- Not changing `ncli logout`; it continues to call `TokenStore.deleteAll()`.
- Not deleting OAuth state merely because the saved callback port is busy.

## Decisions

### Lazy callback startup for valid-token fast path

Ambiguity: `src/mcp/client.ts:24-31` starts callback server before SDK token reuse. The research question asked whether callback can be avoided when tokens are valid.

Explored:
- Keep eager startup and suppress deletion only: smallest code change, but still binds/contends on a callback port for every valid-token command.
- Start callback lazily only after SDK auth is needed: avoids callback work on successful token reuse and matches SDK token-first transport behavior (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:61`).

Decision: Use lazy callback startup. Developer selected “Lazy callback” and added that pre-server token validity checks are desirable if possible.

### Local token validity cannot be proven before MCP contact

Ambiguity: Developer asked whether token validity can be checked before MCP server startup.

Explored:
- Validate token presence/shape locally through `TokenStore.readTokens()` and SDK schema expectations.
- Prove actual token validity locally before contacting MCP server.

Decision: Do not add a local validity oracle. `OAuthTokensSchema` has `access_token`, optional `expires_in`, and optional `refresh_token`, but no persisted issue timestamp (`node_modules/@modelcontextprotocol/sdk/dist/esm/shared/auth.js:120-129`). Actual validity/refreshability remains decided by SDK requests to the MCP/OAuth server.

### Provider owns auth-time callback lifecycle

Ambiguity: If `MCPConnection` no longer starts callback upfront, something must ensure redirect metadata uses an already-bound port before SDK dynamic registration or authorization URL construction.

Explored:
- Put startup in `MCPConnection` only after catching `UnauthorizedError`: too late because SDK calls `provider.clientMetadata` and `provider.redirectUrl` before throwing the redirect `UnauthorizedError` (`node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js:216-299`).
- Put startup in `NotionOAuthProvider.clientInformation()` and `redirectToAuthorization()`: keeps provider as the OAuth adapter and ensures async startup happens before SDK reads sync redirect getters.

Decision: Extend `NotionOAuthProvider` with auth-time startup/wait helpers while keeping token persistence in `TokenStore` and HTTP details in `CallbackServer`.

### Port contention is not a destructive signal

Ambiguity: Old behavior treated saved/actual callback port mismatch as stale OAuth bundle proof.

Explored:
- Delete OAuth state on any port mismatch: current behavior and bug source (`src/mcp/client.ts:197-208`).
- Delete only during explicit logout or confirmed SDK invalidation paths; never because `EADDRINUSE` forced fallback.

Decision: Remove port mismatch invalidation from `connect()`. Keep `TokenStore.deleteOAuthState()` for explicit/future confirmed repair paths, but this plan does not call it for callback fallback. If SDK auth is needed and the saved callback port is unavailable, the provider returns `undefined` from `clientInformation()` so the SDK dynamically registers a client for the actual callback port instead of pairing an old `client_id` with an unregistered redirect URI.

## Phase 1: Provider lazy callback foundation

### Overview

Adds provider-owned callback startup/wait behavior and tests it directly; foundation for Phase 2 wiring.

### Changes Required:

#### 1. src/auth/provider.ts

**File**: src/auth/provider.ts
**Changes**: MODIFY — add preferred-port callback startup, callback wait promise, and auth-time startup hooks.

```ts
export interface NotionOAuthProviderOptions {
	preferredPort?: number;
	lazyCallback?: boolean;
}

export class NotionOAuthProvider implements OAuthClientProvider {
	private callbackStartPromise: Promise<void> | null = null;
	private callbackPromise: Promise<string> | null = null;
	private readonly preferredPort?: number;
	private readonly lazyCallback: boolean;

	constructor(
		private tokenStore: TokenStore,
		private callbackServer: CallbackServer,
		options: NotionOAuthProviderOptions = {},
	) {
		this.preferredPort = options.preferredPort;
		this.lazyCallback = options.lazyCallback ?? false;
	}

	get redirectUrl(): string {
		return `http://127.0.0.1:${this.callbackServer.port}${CALLBACK_PATH}`;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: CLIENT_NAME,
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	async clientInformation(): Promise<OAuthClientInformationFull | undefined> {
		const clientInfo = this.tokenStore.readClientInfo() as OAuthClientInformationFull | undefined;
		if (this.lazyCallback) {
			await this.ensureCallbackServerStarted();
			if (this.preferredPort !== undefined && this.callbackServer.port !== this.preferredPort) {
				return undefined;
			}
		}
		return clientInfo;
	}

	async saveClientInformation(info: OAuthClientInformationFull): Promise<void> {
		this.tokenStore.saveClientInfo(info as unknown as Record<string, unknown>);
	}

	tokens(): OAuthTokens | undefined {
		return this.tokenStore.readTokens() as OAuthTokens | undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		this.tokenStore.saveTokens(tokens as unknown as Record<string, unknown>);
	}

	codeVerifier(): string {
		const verifier = this.tokenStore.readCodeVerifier();
		if (!verifier) {
			throw new CliError(
				"No code verifier saved",
				"OAuth state is corrupted",
				"Run ncli login to re-authenticate",
			);
		}
		return verifier;
	}

	async saveCodeVerifier(verifier: string): Promise<void> {
		this.tokenStore.saveCodeVerifier(verifier);
	}

	async redirectToAuthorization(url: URL): Promise<void> {
		if (this.lazyCallback) {
			await this.ensureCallbackServerStarted();
			this.callbackPromise ??= this.callbackServer.waitForCallback();
		}
		await openBrowser(url.toString());
	}

	waitForCallback(): Promise<string> {
		if (!this.callbackPromise) {
			throw new CliError(
				"OAuth callback not started",
				"The authorization flow did not start before waiting for the callback",
				"Run ncli login to retry",
			);
		}
		return this.callbackPromise;
	}

	private async ensureCallbackServerStarted(): Promise<void> {
		if (this.callbackServer.port > 0) return;
		this.callbackStartPromise ??= this.callbackServer.start(this.preferredPort);
		await this.callbackStartPromise;
	}
}
```

#### 2. src/auth/provider.test.ts

**File**: src/auth/provider.test.ts
**Changes**: NEW — regression tests for token reads without callback startup and port contention preserving OAuth state.

```ts
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

	it("forces client re-registration while preserving OAuth state when the saved callback port is occupied", async () => {
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

		await expect(provider.clientInformation()).resolves.toBeUndefined();

		expect(callbackServer.port).toBeGreaterThan(0);
		expect(callbackServer.port).not.toBe(occupiedPort);
		expect(store.readTokens()).toEqual(tokens);
		expect(store.readClientInfo()).toEqual(clientInfo);
		expect(store.readCodeVerifier()).toBe("verifier");
		expect(store.readRestToken()).toBe("ntn_rest");
	});
});
```

### Success Criteria:

#### Automated Verification:
- [x] Provider token fast path is covered: `npm test -- src/auth/provider.test.ts`
- [x] Provider implementation type-checks with async `clientInformation()` and opt-in constructor options: `npm run typecheck`

#### Manual Verification:
- [x] Confirm `tokens()` in `src/auth/provider.ts` does not call `ensureCallbackServerStarted()`.
- [x] Confirm existing two-argument `new NotionOAuthProvider(tokenStore, callbackServer)` callers remain non-lazy until Phase 2 opts in.
- [x] Confirm the port-contention test forces client re-registration while preserving MCP OAuth files and REST token state.

## Phase 2: MCP connection wiring and documentation

### Overview

Depends on Phase 1; rewires `MCPConnection` to rely on provider lazy callback support, updates tests, and documents the new lifecycle.

### Changes Required:

#### 1. src/mcp/client.ts

**File**: src/mcp/client.ts
**Changes**: MODIFY — remove eager callback startup and destructive port mismatch invalidation from `connect()`.

```ts
async connect(): Promise<void> {
	const tokenStore = new TokenStore(CONFIG_DIR);
	const callbackServer = new CallbackServer();
	this.callbackServer = callbackServer;

	// Reuse the port from the previous client registration only if the SDK needs
	// browser authorization. Valid saved tokens should connect without binding a
	// local callback port, which avoids destructive behavior during concurrent runs.
	const savedPort = extractPortFromClientInfo(tokenStore.readClientInfo());
	const provider = new NotionOAuthProvider(tokenStore, callbackServer, {
		preferredPort: savedPort,
		lazyCallback: true,
	});
	const serverUrl = new URL(MCP_SERVER_URL);

	const client = new Client({ name: "ncli", version }, { capabilities: {} });
	this.client = client;

	let transport = new StreamableHTTPClientTransport(serverUrl, {
		authProvider: provider,
	});

	try {
		await client.connect(transport);
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			console.error("Opening browser for Notion login...");

			const code = await provider.waitForCallback();
			await transport.finishAuth(code);

			// Reconnect with new tokens
			transport = new StreamableHTTPClientTransport(serverUrl, {
				authProvider: provider,
			});
			await client.connect(transport);
		} else {
			callbackServer.stop();
			throw error;
		}
	}
}

// Delete the old port-mismatch invalidation interface and helper entirely. Port
// mismatch is no longer a credential invalidation signal; TokenStore.deleteOAuthState()
// remains available for explicit or future confirmed repair paths.
```

#### 2. src/mcp/client.test.ts

**File**: src/mcp/client.test.ts
**Changes**: MODIFY — replace old invalidation tests with non-destructive port decision coverage.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotionOAuthProvider } from "../auth/provider.js";
import { CliError } from "../util/errors.js";

const mocks = vi.hoisted(() => ({
	callbackStart: vi.fn(),
	callbackStop: vi.fn(),
	callbackWait: vi.fn(),
	clientClose: vi.fn(),
	clientConnect: vi.fn(),
	finishAuth: vi.fn(),
	providerWaitForCallback: vi.fn(),
	readClientInfo: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(() => ({
		callTool: vi.fn(),
		close: mocks.clientClose,
		connect: mocks.clientConnect,
		listTools: vi.fn(),
	})),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({
		finishAuth: mocks.finishAuth,
	})),
}));

vi.mock("../auth/callback-server.js", () => ({
	CallbackServer: vi.fn().mockImplementation(() => ({
		get port() {
			return 0;
		},
		start: mocks.callbackStart,
		stop: mocks.callbackStop,
		waitForCallback: mocks.callbackWait,
	})),
}));

vi.mock("../auth/provider.js", () => ({
	NotionOAuthProvider: vi.fn().mockImplementation(() => ({
		waitForCallback: mocks.providerWaitForCallback,
	})),
}));

vi.mock("../auth/token-store.js", () => ({
	TokenStore: vi.fn().mockImplementation(() => ({
		readClientInfo: mocks.readClientInfo,
	})),
}));

import { extractPortFromClientInfo, MCPConnection } from "./client.js";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.clientClose.mockResolvedValue(undefined);
	mocks.clientConnect.mockResolvedValue(undefined);
	mocks.finishAuth.mockResolvedValue(undefined);
	mocks.providerWaitForCallback.mockResolvedValue("callback-code");
	mocks.readClientInfo.mockReturnValue({
		client_id: "abc",
		redirect_uris: ["http://127.0.0.1:54975/callback"],
	});
});

describe("extractPortFromClientInfo", () => {
	it("extracts port from redirect_uris", () => {
		expect(
			extractPortFromClientInfo({
				redirect_uris: ["http://127.0.0.1:54975/callback"],
				client_id: "abc",
			}),
		).toBe(54975);
	});

	it("returns undefined when info is undefined", () => {
		expect(extractPortFromClientInfo(undefined)).toBeUndefined();
	});

	it("returns undefined when redirect_uris is missing", () => {
		expect(extractPortFromClientInfo({ client_id: "abc" })).toBeUndefined();
	});

	it("returns undefined when redirect_uris is empty", () => {
		expect(extractPortFromClientInfo({ redirect_uris: [] })).toBeUndefined();
	});

	it("returns undefined for URL without explicit port", () => {
		expect(
			extractPortFromClientInfo({ redirect_uris: ["http://127.0.0.1/callback"] }),
		).toBeUndefined();
	});
});

describe("MCPConnection", () => {
	it("does not start callback server before a successful SDK connect", async () => {
		const conn = new MCPConnection();

		await conn.connect();

		expect(mocks.callbackStart).not.toHaveBeenCalled();
		expect(NotionOAuthProvider).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), {
			lazyCallback: true,
			preferredPort: 54975,
		});
		await conn.disconnect();
	});

	it("throws CliError when calling callTool before connect", async () => {
		const conn = new MCPConnection();
		await expect(conn.callTool("notion-search", { query: "test" })).rejects.toThrow(CliError);
		await expect(conn.callTool("notion-search", { query: "test" })).rejects.toThrow(
			"Not connected",
		);
	});

	it("throws CliError when calling listTools before connect", async () => {
		const conn = new MCPConnection();
		await expect(conn.listTools()).rejects.toThrow(CliError);
		await expect(conn.listTools()).rejects.toThrow("Not connected");
	});

	it("disconnect is safe when not connected", async () => {
		const conn = new MCPConnection();
		await expect(conn.disconnect()).resolves.toBeUndefined();
	});
});
```

#### 3. docs/auth.md

**File**: docs/auth.md
**Changes**: MODIFY — update auth flow diagrams and callback port reuse contract.

```md
### 初回（自動トリガー or `ncli login`）

```
ncli search "hello"
  │
  ▼
MCPConnection.connect()
  ├── client.json の redirect_uris からポート導出（保存のみ。ここでは listen しない）
  ├── StreamableHTTPClientTransport + OAuthClientProvider 作成
  ├── client.connect(transport) → POST/GET to https://mcp.notion.com/mcp
  │
  ├── 401 Unauthorized
  │   ├── SDK: OAuth Discovery (RFC 9470 → RFC 8414)
  │   ├── provider.clientInformation()
  │   │   └── CallbackServer.start(savedPort)（競合時は listen(0) にフォールバック）
  │   ├── SDK: Dynamic Client Registration (RFC 7591)
  │   ├── SDK: PKCE 生成 (S256)
  │   ├── provider.saveClientInformation() → client.json に保存
  │   ├── provider.saveCodeVerifier() → auth-state.json に保存
  │   └── provider.redirectToAuthorization(url)
  │       ├── callback 待機を開始
  │       └── ブラウザで認可 URL を開く
  │
  ├── UnauthorizedError throw → MCPConnection がキャッチ
  │
  ├── provider.waitForCallback() (120s timeout)
  │   └── http://localhost:PORT/callback?code=... 受信
  │
  ├── transport.finishAuth(code)
  │   ├── SDK: code → token 交換
  │   └── provider.saveTokens() → tokens.json に保存 (0o600)
  │
  └── 新 transport で再接続 → セッション確立
```

### 2回目以降

```
ncli search "hello"
  │
  ▼
MCPConnection.connect()
  ├── CallbackServer はまだ起動しない
  ├── provider.tokens() → tokens.json から読み込み
  ├── Authorization: Bearer <access_token> で POST/GET
  │
  ├── 200 → セッション確立、コマンド実行（callback port 不使用）
  ├── 401 → SDK auth flow に入り、provider.clientInformation() で CallbackServer.start(savedPort)
  ├── refresh_token あり → SDK が自動リフレッシュ → リトライ（callback は起動済みの場合あり）
  └── browser auth 必要 → 起動済み callback port で認可 URL を開く
```

## OAuthClientProvider 実装ポイント

SDK の `OAuthClientProvider` インターフェースを実装する。主要メソッド:

| メソッド | 実装 |
|---|---|
| `redirectUrl` | `http://127.0.0.1:{port}/callback` (ブラウザ認可時に起動した callback server の port) |
| `clientMetadata` | `{ client_name: "ncli", grant_types: [...], token_endpoint_auth_method: "none" }` |
| `tokens()` / `saveTokens()` | TokenStore 経由で tokens.json を読み書き。`tokens()` は callback server を起動しない |
| `clientInformation()` / `saveClientInformation()` | TokenStore 経由で client.json を読み書き。OAuth auth path では callback server を起動し、保存済み port が使えず fallback した場合は `undefined` を返して actual port で再登録させる |
| `redirectToAuthorization(url)` | callback 待機を開始してから `open(url)` |
| `codeVerifier()` / `saveCodeVerifier()` | TokenStore 経由で auth-state.json を読み書き |
| `invalidateCredentials()` | 未実装 (SDK が呼ぶが no-op。logout は TokenStore.deleteAll() で処理) |

`CallbackServer` は `MCPConnection` が所有し、provider に参照を渡す（共有状態パターン）。通常接続では起動せず、SDK が OAuth auth path に入った時だけ provider が起動する。

## コールバックポートの再利用

Dynamic Client Registration で登録される `redirect_uris` にはコールバックサーバーのポートが含まれる。`client.json` にキャッシュされた `client_id` を再利用してブラウザ認可に進む場合、同じポートで listen できると redirect_uri mismatch を避けられる。

**対策**: `connect()` は `client.json` の `redirect_uris` から保存済みポートを導出するが、通常接続では `CallbackServer` を起動しない。SDK が保存済み token で接続できる場合、callback port は不要。

- SDK が 401 後の OAuth auth flow に入った時点で `CallbackServer.start(savedPort)` を呼ぶ（refresh だけで復旧する場合も listener が起動済みになることがある）
- ポート競合時は `listen(0)` にフォールバックするが、フォールバックだけでは MCP OAuth state (`client.json`, `tokens.json`, `auth-state.json`) を破棄しない
- fallback port でブラウザ認可に進む場合は、保存済み `client_id` を使わず actual port で Dynamic Client Registration し直す
- `redirect_uris` がない（旧バージョンの `client.json`）場合は、ブラウザ認可が必要になった時にランダムポートで起動する
- 明示的に credentials を消したい場合は `ncli logout` を使う
```

### Success Criteria:

#### Automated Verification:
- [x] Obsolete destructive invalidation helper is gone: `grep -R "invalidateOAuthStateForPortChange" src` returns no matches
- [x] Old port-mismatch deletion expectation is gone: `grep -R "deleteOAuthState" src/mcp/client.test.ts` returns no matches
- [x] Provider regression suite passes after MCP wiring: `npm test -- src/auth/provider.test.ts src/mcp/client.test.ts`
- [x] Full project verification passes: `npm run build && npm run typecheck && npm run lint && npm test`

#### Manual Verification:
- [x] Confirm `src/mcp/client.ts` does not call `callbackServer.start()` before `client.connect(transport)`.
- [x] Confirm `src/mcp/client.ts` passes `{ preferredPort: savedPort, lazyCallback: true }` to `NotionOAuthProvider`.
- [x] Confirm `docs/auth.md` no longer states that port fallback clears MCP OAuth state.

## Ordering Constraints

- Phase 1 must land before Phase 2 because `MCPConnection` will call new `NotionOAuthProvider` constructor/options and callback wait APIs.
- Phase 2 is the terminal integration phase and carries the full project verification commands.
- No phases can run in parallel because Phase 2 depends on Phase 1 public surface.

## Verification Notes

- Verify valid-token fast path does not require callback startup by testing provider token reads without starting the callback server.
- Verify callback port contention does not delete `tokens.json`, `client.json`, `auth-state.json`, or `rest-token.json`.
- Verify old helper tests no longer expect `deleteOAuthState()` on saved/actual port mismatch.
- Verify docs no longer state that port fallback clears MCP OAuth state.
- Run `npm run build && npm run typecheck && npm run lint && npm test` after the terminal phase.

## Performance Considerations

- Fast-path commands avoid opening a local HTTP listener when saved tokens authenticate successfully.
- OAuth/refresh paths may still start the callback server after a 401 because the SDK can fall through from refresh to browser authorization in one auth call.
- No additional network calls or polling loops are introduced beyond the SDK's existing MCP/OAuth behavior.

## Migration Notes

No schema or persisted-file migration is required.
Existing `tokens.json`, `client.json`, `auth-state.json`, and `rest-token.json` remain compatible.
Users whose credentials were previously deleted need to log in again once, but this plan prevents future deletion from port contention.

## Pattern References

- `src/mcp/client.ts:184-195` — pure helper style for extracting facts from stored OAuth client info.
- `src/mcp/client.ts:18-63` — connection orchestration pattern to preserve while moving callback startup out of the fast path.
- `src/auth/provider.ts:13-66` — provider adapter boundary for token/client persistence and redirect construction.
- `src/auth/token-store.ts:39-99` — explicit MCP-vs-REST token deletion boundaries.
- `src/mcp/client.test.ts:6-61` — pure helper/unit test style with `vi.fn()`.
- `src/auth/callback-server.test.ts:18-59` — occupied-port test setup pattern.
- `src/auth/token-store.test.ts:8-18` — temp-directory TokenStore test pattern.
- `docs/auth.md:11-105` — auth lifecycle documentation to mirror implementation.

## Developer Context

- Research inherited Q (`src/mcp/client.ts:30`, `src/mcp/client.ts:45`): `connect()` currently deletes OAuth state on port mismatch before SDK token reuse is attempted. 修正方針として、ポート競合時の削除はどこまで許容しますか？ A: そもそもトークン有効なときはcallback不要にできないかな？
- Blueprint Q (`src/mcp/client.ts:24-31`, `node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:61`): 修正方針としてどこまで変更しますか？ A: Lazy callbackで。ただしMCPサーバー起動前にトークンの有効性を検証できるならそれが嬉しい。
- Blueprint design confirmation: Lazy callback, provider-owned auth-time startup, no implicit deletion on port contention, no local validity oracle beyond token presence/shape. A: Proceed (Recommended).
- Blueprint decomposition confirmation: 2 slices — provider foundation, then MCP wiring/docs. A: Approve (Recommended).
- Slice 1 micro-checkpoint (`src/auth/provider.ts`, `src/auth/provider.test.ts`): opt-in lazy callback provider surface, token fast-path test, preferred-port startup test, occupied-port state preservation test. A: Approve (Recommended).
- Slice 2 micro-checkpoint (`src/mcp/client.ts`, `src/mcp/client.test.ts`, `docs/auth.md`): remove eager callback startup and destructive port invalidation, wire provider lazy options, update tests/docs. A: Approve (Recommended).
- Step 9 review triage: Applied concern about old client_id + fallback redirect URI by forcing dynamic client registration on preferred-port fallback. Applied docs concern by clarifying callback listener may start for any SDK auth flow after 401, before refresh succeeds.

## Plan History

- Phase 1: Provider lazy callback foundation — revised after Step 9: preferred-port fallback returns undefined from clientInformation() to force re-registration while preserving stored OAuth/REST state
- Phase 2: MCP connection wiring and documentation — revised after Step 9: docs clarify SDK auth-flow callback startup and fallback-port re-registration

## References

- `.rpiv/artifacts/research/2026-06-23_17-58-29_concurrent-oauth-callback-port-token-clearing.md`
- `.rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md`
- `.rpiv/artifacts/plans/2026-06-23_16-32-38_client-id-mismatch-oauth.md`
- `.rpiv/artifacts/validation/2026-06-23_17-29-16_oauth-client-id-mismatch-repair.md`

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

| source | plan-loc | codebase-loc | severity | dimension | finding | recommendation | resolution |
| --- | --- | --- | --- | --- | --- | --- | --- |
| code | Phase 1 §1 (provider.ts) | node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js:698-701 | concern | code-quality | When the preferred callback port is occupied, `clientInformation()` can return the cached `client_id` while `provider.redirectUrl` points at the fallback port, so SDK browser authorization combines an old client registration with an unregistered redirect URI. | Preserve tokens but force dynamic client registration with the actual callback port, or fail with an explicit re-login error before opening the browser. | applied: provider returns `undefined` on preferred-port fallback to force dynamic registration for the actual callback port while preserving stored state; provider regression test updated. |
| code | Phase 2 §3 (auth.md) | node_modules/@modelcontextprotocol/sdk/dist/esm/client/auth.js:216 | concern | codebase-fit | The docs say the callback server starts only for “401 + browser auth 必要”, but the proposed provider starts it in `clientInformation()` and the SDK calls `provider.clientInformation()` before refresh handling. | Update the docs to state that any SDK auth flow after a 401 may bind the callback listener before refresh succeeds. | applied: docs now state SDK auth flow after 401 may start callback before refresh succeeds, and fallback browser auth re-registers on the actual port. |
