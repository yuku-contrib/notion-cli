---
date: 2026-06-23T16:32:38+0900
author: Yuku Kotani
commit: a325ac7
branch: main
repository: notion-cli
topic: "OAuth Client ID mismatch repair"
tags: [plan, oauth, mcp, auth, client-id-mismatch]
status: ready
parent: .rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md
phase_count: 2
phases:
  - { n: 1, title: OAuth state reset helper }
  - { n: 2, title: Redirect port mismatch wiring }
unresolved_phase_count: 0
last_updated: 2026-06-23T16:32:38+0900
last_updated_by: Yuku Kotani
---

# OAuth Client ID mismatch Repair Implementation Plan

## Overview

This plan fixes the split-brain OAuth state that can produce `Client ID mismatch` after a cached Dynamic Client Registration is invalidated. The chosen approach is the minimal repair: when the cached redirect port is stale, clear the OAuth client registration, tokens, and temporary verifier together so the MCP SDK cannot combine a new `client_id` with an old refresh token.

## Requirements

- Prevent `client.json` deletion from leaving an old `tokens.json` refresh token behind.
- Keep `ncli login` semantics unchanged: it remains a normal connection / login-if-needed command.
- Do not add provider-side mismatch interception, repair commands, or forced re-authentication behavior in this plan.
- Preserve REST Integration Token state when clearing MCP OAuth state.
- Add regression tests that pin the OAuth state deletion unit and the redirect-port invalidation wiring.
- Update auth documentation so future changes understand that client registration and refresh tokens are coupled.

## Current State Analysis

`MCPConnection.connect()` reads the saved callback port from `client.json`, starts the callback server on that preferred port, and deletes only `client.json` when the server must fall back to a different port. `TokenStore` stores `tokens.json`, `client.json`, and `auth-state.json` as separate files and exposes only individual deletion helpers plus `deleteAll()`, which also deletes REST auth state. The OAuth provider then returns `client.json` and `tokens.json` independently to the MCP SDK, allowing stale tokens to survive a client registration reset.

### Key Discoveries

- `src/mcp/client.ts:24-30` derives a saved port from `client.json` and calls only `tokenStore.deleteClientInfo()` on port mismatch.
- `src/auth/token-store.ts:39-60` stores and deletes `tokens.json` and `client.json` independently.
- `src/auth/token-store.ts:89-94` has `deleteAll()`, but it also removes `rest-token.json`, so it is too broad for MCP-only OAuth repair.
- `src/auth/provider.ts:33-46` returns client information and tokens independently to the SDK, so a deleted client registration can still be paired with old tokens.
- `src/commands/login.ts:9-15` shows `login` uses normal `withConnection()` and should not become a forced logout/relogin path in this plan.
- `src/auth/token-store.test.ts:110-121` provides the existing all-state deletion test pattern to model for the narrower OAuth-only helper.
- `src/mcp/client.test.ts:5-31` already tests pure OAuth-port helpers, making a small exported invalidation helper the lowest-friction way to pin MCP wiring without mocking the SDK.

## Desired End State

From a user's perspective, a stale redirect port no longer leaves behind an unusable refresh token:

```sh
# Existing OAuth state was registered for a port that is now occupied.
ncli search "status"
# ncli detects the port mismatch, clears MCP OAuth state as one bundle,
# and the SDK performs a fresh authorization instead of refreshing with
# an old token/client_id pairing.
```

From code, the invalidation is explicit and MCP-only:

```ts
const savedPort = extractPortFromClientInfo(tokenStore.readClientInfo());
await callbackServer.start(savedPort);
invalidateOAuthStateForPortChange(tokenStore, savedPort, callbackServer.port);
```

## What We're NOT Doing

- Not changing `ncli login` into a forced reauthorization command.
- Not adding a new repair command or `login --force` option.
- Not implementing provider-side client/token mismatch detection.
- Not converting every raw SDK auth error into `CliError` in this plan.
- Not touching REST API authentication, except to ensure the new MCP OAuth cleanup does not delete `rest-token.json`.
- Not changing `biome.json`, package configuration, or OAuth SDK dependencies.

## Decisions

### Clear MCP OAuth state as one bundle on redirect port mismatch

Ambiguity: `src/mcp/client.ts:24-30` could either clear all OAuth state immediately when cached redirect metadata is stale, or provider logic in `src/auth/provider.ts:33-46` could attempt to avoid exposing inconsistent state to the SDK.

Explored:
- Option A: clear OAuth state together from the existing port-mismatch branch. Pro: smallest blast radius and directly addresses the observed `client.json`/`tokens.json` split. Con: does not catch every future malformed state combination.
- Option B: add provider-side mismatch interception. Pro: broader guardrail. Con: the stored token file has no `client_id`, so actual matching is indirect and would add speculative behavior.

Decision: use Option A only. Add a focused `TokenStore.deleteOAuthState()` helper and call it from the redirect-port invalidation path.

### Keep `ncli login` behavior unchanged

Ambiguity: `src/commands/login.ts:9-15` could remain a normal connection command, or this fix could redefine it as forced reauthorization.

Decision: keep `login` semantics unchanged. This plan repairs the stale-state branch that creates the mismatch instead of broadening CLI behavior.

### Preserve REST token state during MCP OAuth cleanup

Simple decision: `src/auth/token-store.ts:89-94` deletes REST token state via `deleteAll()`, so the new helper must not reuse `deleteAll()`. It should delete only `tokens.json`, `client.json`, and `auth-state.json`.

### Test MCP wiring through a pure invalidation helper

Simple decision: `src/mcp/client.test.ts:5-31` already tests pure functions around OAuth redirect-port handling, while direct `MCPConnection.connect()` tests would require broad SDK and HTTP mocks. Add and export a small `invalidateOAuthStateForPortChange()` helper, use it from `connect()`, and unit-test its decision behavior.

## Phase 1: OAuth state reset helper

### Overview

Adds the focused MCP OAuth deletion primitive. Foundation phase; Phase 2 depends on this helper.

### Changes Required:

#### 1. src/auth/token-store.ts

**File**: src/auth/token-store.ts
**Changes**: MODIFY — add MCP-only OAuth state cleanup helper that preserves REST auth state.

```ts
	deleteOAuthState(): void {
		this.deleteTokens();
		this.deleteClientInfo();
		this.deleteCodeVerifier();
	}
```

#### 2. src/auth/token-store.test.ts

**File**: src/auth/token-store.test.ts
**Changes**: MODIFY — add regression tests for the OAuth-only deletion unit.

```ts
	describe("deleteOAuthState", () => {
		it("deletes MCP OAuth files without deleting REST token", () => {
			store.saveTokens({ access_token: "abc", refresh_token: "def" });
			store.saveClientInfo({ client_id: "id" });
			store.saveCodeVerifier("verifier");
			store.saveRestToken("ntn_abc123");

			store.deleteOAuthState();

			expect(store.readTokens()).toBeUndefined();
			expect(store.readClientInfo()).toBeUndefined();
			expect(store.readCodeVerifier()).toBeUndefined();
			expect(store.readRestToken()).toBe("ntn_abc123");
		});

		it("is a no-op when OAuth files are already missing", () => {
			store.saveRestToken("ntn_abc123");

			expect(() => store.deleteOAuthState()).not.toThrow();
			expect(store.readRestToken()).toBe("ntn_abc123");
		});
	});
```

### Success Criteria:

#### Automated Verification:

- [x] TokenStore OAuth cleanup tests pass: `npm test -- src/auth/token-store.test.ts`
- [x] OAuth-only cleanup helper exists: `grep -n "deleteOAuthState" src/auth/token-store.ts src/auth/token-store.test.ts`

#### Manual Verification:

- [ ] Confirm `deleteOAuthState()` deletes `tokens.json`, `client.json`, and `auth-state.json` only.
- [ ] Confirm `rest-token.json` remains covered by `deleteAll()` but is not removed by the new OAuth-only helper.

## Phase 2: Redirect port mismatch wiring

### Overview

Uses the new OAuth deletion primitive when redirect-port fallback invalidates cached client registration. Depends on Phase 1; terminal phase runs full project verification.

### Changes Required:

#### 1. src/mcp/client.ts

**File**: src/mcp/client.ts
**Changes**: MODIFY — route stale redirect-port invalidation through OAuth bundle cleanup and expose a pure helper for regression tests.

```ts
// Replace the existing port-mismatch branch in connect():
		// If the actual port differs from the saved one, the cached redirect_uri is
		// stale — clear MCP OAuth state so the SDK re-registers and re-authorizes
		// with a matching client_id / refresh token pair.
		invalidateOAuthStateForPortChange(tokenStore, savedPort, callbackServer.port);
```

```ts
interface OAuthStateInvalidationStore {
	deleteOAuthState(): void;
}

export function invalidateOAuthStateForPortChange(
	tokenStore: OAuthStateInvalidationStore,
	savedPort: number | undefined,
	actualPort: number,
): void {
	if (savedPort !== undefined && actualPort !== savedPort) {
		tokenStore.deleteOAuthState();
	}
}
```

#### 2. src/mcp/client.test.ts

**File**: src/mcp/client.test.ts
**Changes**: MODIFY — test the port mismatch invalidation helper clears OAuth state only when the saved port changes.

```ts
// Update the imports:
import { describe, expect, it, vi } from "vitest";
import { CliError } from "../util/errors.js";
import {
	extractPortFromClientInfo,
	invalidateOAuthStateForPortChange,
	MCPConnection,
} from "./client.js";
```

```ts
describe("invalidateOAuthStateForPortChange", () => {
	it("clears OAuth state when saved port differs from actual port", () => {
		const tokenStore = { deleteOAuthState: vi.fn() };

		invalidateOAuthStateForPortChange(tokenStore, 54975, 54976);

		expect(tokenStore.deleteOAuthState).toHaveBeenCalledTimes(1);
	});

	it("keeps OAuth state when saved port matches actual port", () => {
		const tokenStore = { deleteOAuthState: vi.fn() };

		invalidateOAuthStateForPortChange(tokenStore, 54975, 54975);

		expect(tokenStore.deleteOAuthState).not.toHaveBeenCalled();
	});

	it("keeps OAuth state when no saved port exists", () => {
		const tokenStore = { deleteOAuthState: vi.fn() };

		invalidateOAuthStateForPortChange(tokenStore, undefined, 54975);

		expect(tokenStore.deleteOAuthState).not.toHaveBeenCalled();
	});
});
```

#### 3. docs/auth.md

**File**: docs/auth.md
**Changes**: MODIFY — document that cached client registration and MCP tokens are invalidated together on callback port mismatch.

```md
  ├── ポート不一致 → client.json / tokens.json / auth-state.json をまとめて破棄 (再登録 + 再認可)
```

```md
- ポート競合時は `listen(0)` にフォールバックし、MCP OAuth state (`client.json`, `tokens.json`, `auth-state.json`) をまとめて破棄して再登録・再認可する
- `redirect_uris` がない（旧バージョンの `client.json`）場合はランダムポートで起動し、保存済みポートがないため自動破棄は行わない。必要な場合は SDK の通常認可フローに任せる
```

### Success Criteria:

#### Automated Verification:

- [x] MCP client helper tests pass: `npm test -- src/mcp/client.test.ts`
- [x] OAuth cleanup tests still pass: `npm test -- src/auth/token-store.test.ts`
- [x] Port mismatch wiring references OAuth bundle cleanup: `grep -n "invalidateOAuthStateForPortChange\|deleteOAuthState" src/mcp/client.ts src/mcp/client.test.ts`
- [x] Port mismatch repair does not call client-only deletion: `! grep -n "tokenStore.deleteClientInfo()" src/mcp/client.ts`
- [x] Full project checks pass: `npm run build && npm run typecheck && npm run lint && npm test`

#### Manual Verification:

- [ ] Confirm `src/mcp/client.ts` no longer clears only `client.json` for a saved-port mismatch.
- [ ] Confirm `src/commands/login.ts` is unchanged and `login` still uses `withConnection()` without pre-clearing OAuth state.
- [ ] Confirm `docs/auth.md` states client registration and MCP tokens are coupled on callback port mismatch.

## Ordering Constraints

- Phase 1 must run before Phase 2 because `src/mcp/client.ts` will call `TokenStore.deleteOAuthState()`.
- No phases can run in parallel; Phase 2's code and tests assume the Phase 1 helper exists.
- Full repository verification is reserved for Phase 2 because it is the terminal phase that includes all production and test changes.

## Verification Notes

- Verify the new OAuth cleanup deletes `tokens.json`, `client.json`, and `auth-state.json` while preserving `rest-token.json`.
- Verify redirect-port mismatch calls OAuth bundle cleanup, not `deleteClientInfo()` alone.
- Verify no source path uses `deleteAll()` for the port-mismatch repair, because that would delete REST API credentials.
- Verify `ncli login` behavior is unchanged; no command code should clear auth state before `withConnection()`.
- Run full project checks: `npm run build && npm run typecheck && npm run lint && npm test`.

## Performance Considerations

The change adds only synchronous deletion of up to three small config files on an uncommon stale-port branch. Normal successful connections on a reusable saved port do not perform additional file deletion, network calls, or token reads beyond the existing flow.

## Migration Notes

No persisted schema migration is required. Existing users with already split OAuth state will be repaired the next time a stale redirect-port branch is encountered; otherwise they can still use the existing `ncli logout` / `ncli login` path. The new helper is backward-compatible with missing files because existing `deleteFile()` is idempotent.

## Pattern References

- `src/auth/token-store.ts:31-37` — idempotent file deletion helper to reuse.
- `src/auth/token-store.ts:89-94` — existing multi-file deletion pattern, but too broad because it includes REST token state.
- `src/auth/token-store.test.ts:110-121` — test style for multi-file deletion assertions.
- `src/mcp/client.ts:24-30` — exact stale redirect-port branch to change.
- `src/mcp/client.test.ts:5-31` — pure function test style for OAuth redirect-port helpers.
- `src/auth/callback-server.test.ts:41-58` — precedent for preferred port fallback behavior, used as behavioral context rather than directly copied.

## Developer Context

- Research checkpoint inherited: Q (`src/mcp/client.ts:29-30`, `src/auth/token-store.ts:47-60`): compare both repair approaches. A: compare both in research.
- Blueprint question: Q (`src/mcp/client.ts:24-30`, `src/auth/provider.ts:33-46`): fix scope? A: 一括クリアのみ.
- Blueprint question: Q (`src/commands/login.ts:9-15`): change `ncli login` meaning? A: 現状維持.
- Design confirmation: Q: Ready to proceed to decomposition? A: Proceed (Recommended).
- Decomposition confirmation: Q: Approve 2 slices? A: Approve (Recommended).

## Plan Review (Step 8)

_Independent post-finalization review by artifact-code-reviewer and artifact-coverage-reviewer subagents. Findings triaged at Step 9._

_No findings — both reviewers cleared the artifact._

## Plan History

- Phase 1: OAuth state reset helper — approved as generated
- Phase 2: Redirect port mismatch wiring — approved as generated

## References

- `.rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md`
- `docs/auth.md`
- `research/02-oauth-and-mcp-protocol.md`
- `research/03-mcp-sdk-and-existing-tools.md`
- External reference: https://github.com/metatool-ai/metamcp/issues/296
