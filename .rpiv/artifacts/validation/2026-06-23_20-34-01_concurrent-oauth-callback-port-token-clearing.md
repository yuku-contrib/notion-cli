---
template_version: 1
date: 2026-06-23T20:34:01+0900
author: Yuku Kotani
commit: 0fa46ad
branch: main
repository: notion-cli
topic: "Validation of concurrent OAuth callback port token clearing"
status: ready
verdict: pass
parent: ".rpiv/artifacts/plans/2026-06-23_18-46-07_concurrent-oauth-callback-port-token-clearing.md"
tags: [validation, plan, blueprint, oauth, mcp, callback-server, token-store]
last_updated: 2026-06-23T20:34:01+0900
---

## Validation Report: concurrent OAuth callback port token clearing

### Implementation Status

- ✓ Phase 1: Provider lazy callback foundation — Fully implemented
- ✓ Phase 2: MCP connection wiring and documentation — Fully implemented

### Automated Verification Results

- ✓ Provider token fast path: `npm test -- src/auth/provider.test.ts` — 1 file passed, 3 tests passed
- ✓ Provider typecheck: `npm run typecheck` — TypeScript completed with no errors
- ✓ Obsolete destructive invalidation helper removed: `grep -R "invalidateOAuthStateForPortChange" src` — no matches (expected exit 1)
- ✓ Old port-mismatch deletion expectation removed: `grep -R "deleteOAuthState" src/mcp/client.test.ts` — no matches (expected exit 1)
- ✓ Provider and MCP regression suites: `npm test -- src/auth/provider.test.ts src/mcp/client.test.ts` — 2 files passed, 12 tests passed
- ✓ Full project verification: `npm run build && npm run typecheck && npm run lint && npm test` — build succeeded, typecheck succeeded, Biome checked 53 files with no errors, 22 test files passed with 184 tests
- ✓ No regressions detected

### Code Review Findings

#### Matches Plan:

- `src/auth/provider.ts:47` — `clientInformation()` is async and owns auth-time callback startup when lazy mode is enabled.
- `src/auth/provider.ts:49-52` — preferred-port fallback returns `undefined`, forcing SDK dynamic client registration on the actual callback port.
- `src/auth/provider.ts:62-63` — `tokens()` reads saved tokens only and does not start the callback server, preserving the valid-token fast path.
- `src/auth/provider.ts:86-91` — `redirectToAuthorization()` starts the callback wait promise before opening the browser.
- `src/auth/provider.ts:94-108` — `waitForCallback()` and `ensureCallbackServerStarted()` provide the provider-owned lazy callback lifecycle with `CliError` for invalid sequencing.
- `src/auth/provider.test.ts:55-69` — regression coverage verifies saved token reads do not start the callback server.
- `src/auth/provider.test.ts:72-91` — regression coverage verifies `clientInformation()` starts the callback server on the preferred port.
- `src/auth/provider.test.ts:94-123` — regression coverage verifies port contention preserves `tokens.json`, `client.json`, `auth-state.json`, and REST token state while forcing re-registration.
- `src/mcp/client.ts:18-30` — `connect()` derives the saved port and passes `{ preferredPort: savedPort, lazyCallback: true }` to `NotionOAuthProvider` without eager `callbackServer.start()`.
- `src/mcp/client.ts:40-47` — `client.connect(transport)` is attempted before callback waiting, and `UnauthorizedError` uses `provider.waitForCallback()` followed by `transport.finishAuth(code)`.
- `src/mcp/client.ts:180-191` — `extractPortFromClientInfo()` remains a pure helper for deriving the saved redirect port.
- `src/mcp/client.test.ts:109-118` — MCP regression coverage verifies successful SDK connect does not start the callback server and passes lazy provider options.
- `docs/auth.md:16-23` — documentation now states that the saved port is only derived at connect time and the listener starts in the OAuth auth path.
- `docs/auth.md:51-58` — documentation now describes the token fast path as callback-port-free and the 401 path as lazy callback startup.
- `docs/auth.md:91-107` — documentation states `tokens()` does not start the callback server, fallback is non-destructive, and actual-port re-registration is used for browser auth.

#### Deviations from Plan:

None. Implementation is a faithful realization of the plan.

#### Pattern Conformance:

- ✓ `src/auth/provider.test.ts:16-35` follows the existing TokenStore temp-directory setup and cleanup style.
- ✓ `src/auth/provider.test.ts:44-51` follows the existing occupied-port test pattern used by callback server tests.
- ✓ `src/mcp/client.test.ts:5-65` follows the repository's Vitest hoisted mock style for isolating SDK and auth dependencies.
- ✓ `src/auth/provider.ts:73-77` and `src/auth/provider.ts:96-100` follow the repository's `CliError` What / Why / Hint error style.
- Minor observation: `src/mcp/client.test.ts:11-12` and `src/mcp/client.test.ts:27-32` define mocks for the unauthorized branch, but the current plan only required fast-path MCP wiring coverage; this is an acceptable variation, not a deviation.

### Manual Testing Required:

None — the plan's manual criteria were static code and documentation confirmations, and they were verified by inspection in the findings above.

### Recommendations:

- Ready to commit — implementation is complete and validated.
