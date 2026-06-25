---
template_version: 1
date: 2026-06-23T17:29:16+0900
author: Yuku Kotani
commit: a325ac7
branch: main
repository: notion-cli
topic: "Validation of OAuth Client ID mismatch repair"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-23_16-32-38_client-id-mismatch-oauth.md"
tags: [validation, plan, oauth, mcp, auth, client-id-mismatch]
last_updated: 2026-06-23T17:29:16+0900
---

## Validation Report: OAuth Client ID mismatch repair

### Implementation Status

- ✓ Phase 1: OAuth state reset helper — Fully implemented
- ✓ Phase 2: Redirect port mismatch wiring — Fully implemented

### Automated Verification Results

- ✓ TokenStore OAuth cleanup tests pass: `npm test -- src/auth/token-store.test.ts` — 1 test file, 20 tests passed.
- ✓ OAuth-only cleanup helper exists: `grep -n "deleteOAuthState" src/auth/token-store.ts src/auth/token-store.test.ts` — helper and regression tests found.
- ✓ MCP client helper tests pass: `npm test -- src/mcp/client.test.ts` — 1 test file, 11 tests passed.
- ✓ OAuth cleanup tests still pass: `npm test -- src/auth/token-store.test.ts` — rerun passed with 20 tests.
- ✓ Port mismatch wiring references OAuth bundle cleanup: `grep -n "invalidateOAuthStateForPortChange\|deleteOAuthState" src/mcp/client.ts src/mcp/client.test.ts` — wiring, helper interface, helper call, and tests found.
- ✓ Port mismatch repair does not call client-only deletion: `! grep -n "tokenStore.deleteClientInfo()" src/mcp/client.ts` — no direct client-only deletion remains in MCP connection wiring.
- ✓ Full project checks pass: `npm run build && npm run typecheck && npm run lint && npm test` — build succeeded, typecheck succeeded, Biome checked 52 files with no errors, 21 test files and 183 tests passed.
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- `src/auth/token-store.ts:76` — `deleteOAuthState()` was added as the focused MCP OAuth cleanup helper.
- `src/auth/token-store.ts:77-79` — the helper deletes `tokens.json`, `client.json`, and `auth-state.json` via existing idempotent deletion methods only.
- `src/auth/token-store.ts:91-99` — REST token deletion remains isolated to `deleteRestToken()` / `deleteAll()` and is not called by `deleteOAuthState()`.
- `src/auth/token-store.test.ts:124-144` — regression tests verify OAuth files are removed, `rest-token.json` is preserved, and missing OAuth files are a no-op.
- `src/mcp/client.ts:23-30` — `connect()` derives the saved redirect port, starts the callback server with it, and delegates stale-port invalidation to `invalidateOAuthStateForPortChange()`.
- `src/mcp/client.ts:197-208` — the exported invalidation helper calls `deleteOAuthState()` only when a saved port exists and the actual port differs.
- `src/mcp/client.test.ts:38-62` — helper tests cover mismatch, matching ports, and absent saved port.
- `src/commands/login.ts:11-15` — `login` still uses `withConnection()` and does not pre-clear OAuth state.
- `docs/auth.md:16-20` — the OAuth flow now documents bundled deletion of `client.json`, `tokens.json`, and `auth-state.json` on port mismatch.
- `docs/auth.md:100-105` — the callback-port reuse section documents the coupling of MCP client registration and tokens, including the old-client case where no saved port exists.

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ `TokenStore.deleteOAuthState()` follows the existing `deleteAll()` pattern of composing existing deletion helpers while narrowing scope to MCP OAuth state.
- ✓ TokenStore tests reuse the established temporary-directory setup, read-back assertions, and no-op deletion style already present in `src/auth/token-store.test.ts`.
- ✓ `invalidateOAuthStateForPortChange()` follows the existing `extractPortFromClientInfo()` pattern: a small exported pure helper tested directly in `src/mcp/client.test.ts`.
- ✓ Vitest mocking with `vi.fn()` and call-count assertions follows existing project testing conventions.

### Manual Testing Required:

1. TokenStore OAuth cleanup:
   - [ ] Confirm `deleteOAuthState()` deletes `tokens.json`, `client.json`, and `auth-state.json` only.
   - [ ] Confirm `rest-token.json` remains covered by `deleteAll()` but is not removed by the new OAuth-only helper.
2. Redirect port mismatch wiring:
   - [ ] Confirm `src/mcp/client.ts` no longer clears only `client.json` for a saved-port mismatch.
   - [ ] Confirm `src/commands/login.ts` is unchanged and `login` still uses `withConnection()` without pre-clearing OAuth state.
   - [ ] Confirm `docs/auth.md` states client registration and MCP tokens are coupled on callback port mismatch.

### Recommendations:

- Ready to commit — implementation is complete and validated.
