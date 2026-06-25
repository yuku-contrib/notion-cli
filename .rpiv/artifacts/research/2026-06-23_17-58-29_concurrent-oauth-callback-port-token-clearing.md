---
date: 2026-06-23T17:58:29+0900
author: Yuku Kotani
commit: 0fa46ad
branch: main
repository: notion-cli
topic: "ncliを同時に実行したときに、アクセストークンやリフレッシュトークンが有効にもかかわらず、oauth callback のポートが競合して認証情報がクリアされてしまう。なおして"
tags: [research, codebase, oauth, mcp, callback-server, token-store]
status: ready
last_updated: 2026-06-23T17:58:29+0900
last_updated_by: Yuku Kotani
---

# Research: ncli concurrent OAuth callback port token clearing

## Research Question

ncliを同時に実行したときに、アクセストークンやリフレッシュトークンが有効にもかかわらず、oauth callback のポートが競合して認証情報がクリアされてしまう。なおして

## Summary

現在の `MCPConnection.connect()` は、MCP SDK に保存済み token を渡す前に callback server を起動し、保存済み callback port と実 port が違うだけで OAuth state を削除する。
そのため、別の `ncli` プロセスが保存済み port を使用中で `CallbackServer.start()` が random port へ fallback しただけでも、`tokens.json`, `client.json`, `auth-state.json` が削除される。
削除判断は token の有効性、refresh token の有無、SDK connect/refresh の成否を見ていない。
ユーザーの観点では、`ncli logout` を実行していないのに有効な MCP OAuth credentials が消える。
設計上の焦点は、保存済み token が利用可能な通常接続では callback server 自体を不要にできるか、少なくとも port 競合だけでは token bundle を破棄しないことにある。

## Detailed Findings

### MCP connection lifecycle

- `withConnection()` は各コマンド実行で新しい `MCPConnection` を作り、`connect()` 後にコマンド本体を実行し、最後に `disconnect()` する（`src/mcp/with-connection.ts:4-13`）。
- `MCPConnection.connect()` は全プロセス共通の `CONFIG_DIR` を使って `TokenStore` を作る（`src/mcp/client.ts:19`, `src/util/config.ts:4-9`）。
- `connect()` は `tokenStore.readClientInfo()` から保存済み port を取り出し、`CallbackServer.start(savedPort)` を呼ぶ（`src/mcp/client.ts:24-25`）。
- 保存済み port と実 port の比較と削除は、OAuth provider 作成や `client.connect(transport)` より前に実行される（`src/mcp/client.ts:30`, `src/mcp/client.ts:34-45`）。
- したがって、SDK が保存済み token を再利用または refresh できるかを確認する前に、token file が消える可能性がある。

### Callback port selection

- `CallbackServer.start()` は `preferredPort` が指定されている場合、まずその port で `127.0.0.1` に listen する（`src/auth/callback-server.ts:24-44`）。
- preferred port が `EADDRINUSE` の場合はエラー終了せず、`listen(0)` で OS 割当 port に fallback する（`src/auth/callback-server.ts:45-49`）。
- 実 port は `_port` に保存され、`port` getter で参照される（`src/auth/callback-server.ts:16-18`, `src/auth/callback-server.ts:33-36`）。
- `NotionOAuthProvider.redirectUrl` は現在の `callbackServer.port` と `CALLBACK_PATH` から redirect URL を作る（`src/auth/provider.ts:19-20`, `src/util/config.ts:13`）。
- callback server fallback は単独では動作可能だが、現状では fallback 後の port mismatch が即座に OAuth state 削除に変換される（`src/mcp/client.ts:30`, `src/mcp/client.ts:201-208`）。

### OAuth state invalidation

- `invalidateOAuthStateForPortChange()` は `savedPort !== undefined && actualPort !== savedPort` だけを条件に `deleteOAuthState()` を呼ぶ（`src/mcp/client.ts:201-208`）。
- この helper の store interface は `deleteOAuthState()` だけを持ち、token の存在や有効性を判定できない（`src/mcp/client.ts:197-199`）。
- `TokenStore.deleteOAuthState()` は `tokens.json`, `client.json`, `auth-state.json` を削除する（`src/auth/token-store.ts:76-79`）。
- `tokens.json` は `readTokens()` / `saveTokens()` / `deleteTokens()` の対象であり、access token と refresh token の保存先である（`src/auth/token-store.ts:39-48`）。
- port mismatch は redirect URI mismatch の兆候ではあるが、同時実行時の一時的な `EADDRINUSE` と、永続的に stale な OAuth bundle は現コードで区別されていない。

### OAuth provider and SDK surface

- `NotionOAuthProvider.clientInformation()` は `client.json` を MCP SDK に渡す（`src/auth/provider.ts:33-34`）。
- `NotionOAuthProvider.tokens()` は `tokens.json` を MCP SDK に渡す（`src/auth/provider.ts:41-42`）。
- `saveClientInformation()` と `saveTokens()` は SDK から返る client registration や token 更新を保存する（`src/auth/provider.ts:37-46`）。
- `MCPConnection.connect()` は provider を `StreamableHTTPClientTransport` に渡し、まず `client.connect(transport)` を試す（`src/mcp/client.ts:34-45`）。
- `UnauthorizedError` のときだけ callback code を待ち、`transport.finishAuth(code)` 後に再接続する（`src/mcp/client.ts:47-57`）。
- ただし現状の callback server 起動と port mismatch 削除は、この SDK connect attempt より前にある。

### TokenStore race surface

- `TokenStore` は `CONFIG_DIR` 配下の固定名 files を同期的に read/write/delete する（`src/auth/token-store.ts:4-36`, `src/util/config.ts:6-9`）。
- `readJson()` は file read error、permission error、JSON parse error をすべて `undefined` に畳み込む（`src/auth/token-store.ts:15-21`）。
- `writeJson()` は直接対象 file に `writeFileSync()` し、atomic rename や lock はない（`src/auth/token-store.ts:24-29`）。
- `deleteFile()` は `unlinkSync()` の error を no-op として握りつぶす（`src/auth/token-store.ts:31-36`）。
- `deleteOAuthState()` は 3 files を順次個別に削除するため、別プロセスの `saveTokens()` / `saveClientInfo()` と interleave し得る（`src/auth/token-store.ts:43-80`）。

### Command-level deletion paths

- `login` は `withConnection()` 経由で接続し、`notion-get-users` を呼ぶ通常コマンドとして実装されている（`src/commands/login.ts:9-15`）。
- `whoami` も `withConnection()` 経由で接続する（`src/commands/login.ts:33-39`）。
- 明示的な `logout` は `TokenStore.deleteAll()` を呼び、REST token も含めて削除する（`src/commands/login.ts:19-29`, `src/auth/token-store.ts:95-99`）。
- port mismatch による暗黙削除は `deleteOAuthState()` だけであり、REST token は残すが MCP OAuth token は削除する（`src/mcp/client.ts:30`, `src/auth/token-store.ts:76-79`）。
- ユーザーから見ると、`login`, `whoami`, `search`, `fetch`, `api` など通常の MCP command で logout 相当の MCP OAuth 消失が起きる。

### Tests and documented contract

- `src/mcp/client.test.ts` は saved/actual port mismatch で `deleteOAuthState()` が 1 回呼ばれることを期待している（`src/mcp/client.test.ts:38-44`）。
- 同じ test file は port 一致時、または saved port がない時は削除しないことも期待している（`src/mcp/client.test.ts:47-60`）。
- `src/auth/callback-server.test.ts` は preferred port が空いていれば使うこと、占有されていれば別 port に fallback することを個別に検証している（`src/auth/callback-server.test.ts:18-59`）。
- `src/auth/token-store.test.ts` は `deleteOAuthState()` が MCP OAuth files を削除し、REST token は残すことを検証している（`src/auth/token-store.test.ts:124-144`）。
- 既存 tests は「有効 token + 同時実行 port 競合 + SDK reuse 前の削除」という複合ケースを検証していない。
- `docs/auth.md` は port conflict fallback 時に MCP OAuth state を破棄する現仕様を記述している（`docs/auth.md:98-105`）。

## Code References

- `src/mcp/with-connection.ts:4-13` — per-command `MCPConnection` lifecycle.
- `src/mcp/client.ts:18-63` — `MCPConnection.connect()` startup, port invalidation, provider wiring, SDK connect, auth retry.
- `src/mcp/client.ts:184-195` — saved callback port extraction from `client.json.redirect_uris[0]`.
- `src/mcp/client.ts:197-208` — port mismatch invalidation helper and delete-only interface.
- `src/auth/callback-server.ts:24-55` — preferred port listen and `EADDRINUSE` fallback to random port.
- `src/auth/callback-server.ts:58-125` — callback wait path and timeout behavior.
- `src/auth/provider.ts:19-30` — redirect URL and OAuth client metadata derived from actual callback server port.
- `src/auth/provider.ts:33-46` — persisted client info and tokens exposed to MCP SDK.
- `src/auth/token-store.ts:15-36` — raw JSON read/write/delete primitives without cross-process coordination.
- `src/auth/token-store.ts:39-80` — MCP OAuth file APIs and bundled OAuth state deletion.
- `src/auth/token-store.ts:95-99` — explicit `deleteAll()` including REST token.
- `src/commands/login.ts:9-39` — `login`, `logout`, and `whoami` auth-related command surfaces.
- `src/util/config.ts:4-14` — shared config directory, OAuth file paths, callback path, timeout.
- `src/mcp/client.test.ts:38-61` — current unit expectation that port mismatch clears OAuth state.
- `src/auth/callback-server.test.ts:18-59` — current callback port selection/fallback coverage.
- `src/auth/token-store.test.ts:124-144` — current `deleteOAuthState()` deletion coverage.
- `docs/auth.md:98-105` — documented callback port reuse and fallback invalidation contract.

## Integration Points

### Inbound References

- `src/commands/login.ts:12` — `ncli login` enters `withConnection()` and therefore the implicit deletion path.
- `src/commands/login.ts:36` — `ncli whoami` enters `withConnection()` and therefore the implicit deletion path.
- `src/commands/search.ts:19` — search commands use MCP connection.
- `src/commands/fetch.ts:19` — fetch commands use MCP connection.
- `src/commands/api.ts:49` — generic MCP escape hatch uses MCP connection.
- `src/commands/page.ts:161` — page create uses MCP connection.
- `src/commands/page.ts:189` — page update uses MCP connection.
- `src/commands/page.ts:203` — page move uses MCP connection.
- `src/commands/page.ts:215` — page duplicate uses MCP connection.
- `src/commands/db.ts:101` — database create uses MCP connection.
- `src/commands/db.ts:126` — database update uses MCP connection.
- `src/commands/db.ts:147` — database query uses MCP connection.
- `src/commands/view.ts:51` — view create uses MCP connection.
- `src/commands/view.ts:63` — view update uses MCP connection.
- `src/commands/comment.ts:70` — comment create uses MCP connection.
- `src/commands/comment.ts:84` — comment list uses MCP connection.
- `src/commands/user.ts:53` — user list uses MCP connection.
- `src/commands/user.ts:70` — team list uses MCP connection.
- `src/commands/meeting-notes.ts:30` — meeting notes query uses MCP connection.

### Outbound Dependencies

- `src/mcp/client.ts:1-3` — depends on MCP SDK `UnauthorizedError`, `Client`, and `StreamableHTTPClientTransport`.
- `src/mcp/client.ts:40-42` — wires `NotionOAuthProvider` into `StreamableHTTPClientTransport`.
- `src/mcp/client.ts:45` — attempts SDK connection before browser auth fallback.
- `src/mcp/client.ts:47-57` — handles SDK `UnauthorizedError` by waiting for callback code and calling `finishAuth()`.
- `src/auth/provider.ts:7` — depends on `open` to launch browser authorization.
- `src/auth/callback-server.ts:1-3` — depends on Node HTTP server and configured callback path/timeout.

### Infrastructure Wiring

- `src/util/config.ts:4-9` — `envPaths("ncli", { suffix: "" })` defines the shared credential storage directory and file paths.
- `src/util/config.ts:11` — MCP server URL is `https://mcp.notion.com/mcp`.
- `src/util/config.ts:13` — callback path is `/callback`.
- `src/cli.ts:60-72` — CLI registers command groups that route into the MCP command implementations.

## Architecture Insights

- Current architecture treats callback port mismatch as proof of stale OAuth state before attempting token reuse.
- The callback port is only necessary for browser authorization; saved access/refresh token reuse flows through `NotionOAuthProvider.tokens()` and `clientInformation()`.
- `client.json` and `tokens.json` are coupled for Dynamic Client Registration and refresh token validity, so partial deletion is unsafe.
- Bundle deletion is safer than client-only deletion for genuine stale registrations, but port contention alone is not sufficient evidence of stale credentials.
- `login` is implemented as a normal authenticated command, not as a forced reauthorization command.
- TokenStore has no cross-process lock or atomic transaction semantics, so destructive repair paths affect concurrent processes immediately.
- Existing tests encode the destructive policy at unit level and need a combined concurrency/regression scenario to prevent this specific bug from returning.

## Precedents & Lessons

4 similar past changes analyzed.

### Precedent: OAuth client state cleanup on callback port mismatch

**Commit(s)**: `0fa46ad` — "fix: OAuth client state on port mismatch" (2026-06-23)
**Blast radius**: 5 files across 4 layers
  auth/ — `TokenStore.deleteOAuthState()` added; deletes MCP OAuth files only
  mcp/ — port mismatch clears OAuth state bundle, not only `client.json`
  docs/ — `docs/auth.md` updated for bundled invalidation
  tests/ — TokenStore and MCP port invalidation regression tests

**Follow-up fixes**:
- None found after 2026-06-23 in the listed auth/MCP files.

**Lessons from docs**:
- `.rpiv/artifacts/validation/2026-06-23_17-29-16_oauth-client-id-mismatch-repair.md` — validation artifact for bundled MCP OAuth cleanup and REST token preservation.

**Takeaway**: Bundle deletion fixed split OAuth state, but made port mismatch a destructive trigger for valid tokens.

### Precedent: OAuth re-login redirect URI mismatch fix

**Commit(s)**: `0d8ea33` — "fix: OAuth 再ログイン時の \"Invalid redirect URI\" エラーを修正 (#2)" (2026-03-20)
**Blast radius**: 5 files across 4 layers
  auth/ — `CallbackServer.start(preferredPort)` and `EADDRINUSE` fallback
  mcp/ — derive saved port from `client.json.redirect_uris`; stale port deleted `client.json`
  docs/ — callback port reuse documented
  tests/ — callback fallback and port extraction tests

**Follow-up fixes**:
- `0fa46ad` — "fix: OAuth client state on port mismatch" (2026-06-23) — client-only deletion left old refresh tokens paired with new/no client registration.

**Lessons from docs**:
- `.rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md` — research artifact for client registration and token coupling.

**Takeaway**: Callback port reuse is load-bearing for browser reauthorization, but should be separated from valid token reuse.

### Precedent: Initial MCP OAuth + token persistence

**Commit(s)**: `100d7d3` — "Initial Commit" (2026-03-18)
**Blast radius**: 64 files across 7 layers
  auth/ — OAuth provider, callback server, token/client/code-verifier store
  mcp/ — connection lifecycle, SDK transport, auth retry flow
  commands/ — `login`, `logout`, `whoami`
  docs/ — auth flow and token storage documented
  tests/ — TokenStore and MCP baseline tests

**Follow-up fixes**:
- `0d8ea33` — "fix: OAuth 再ログイン時の \"Invalid redirect URI\" エラーを修正 (#2)" (2026-03-20) — random callback ports broke cached Dynamic Client Registration.
- `0fa46ad` — "fix: OAuth client state on port mismatch" (2026-06-23) — independent `client.json` / `tokens.json` deletion caused client/token mismatch.

**Lessons from docs**:
- `.rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md` — research artifact for `ncli login` using normal connection flow.

**Takeaway**: OAuth persistence boundaries must be explicit because `login` does not automatically repair every bad local auth state.

### Precedent: Dual auth TokenStore expansion

**Commit(s)**: `d5fd016` — "Add REST API support with file upload, dual auth (MCP OAuth + Integration Token)" (2026-03-20)
**Blast radius**: 26 files across 8 layers
  auth/ — REST token storage added beside MCP OAuth files
  rest/commands/ — REST login/logout and API commands
  docs/ — dual auth documented
  tests/ — REST token and command coverage

**Follow-up fixes**:
- `0fa46ad` — "fix: OAuth client state on port mismatch" (2026-06-23) — MCP OAuth cleanup needed a narrower helper because `deleteAll()` would also erase REST token.

**Lessons from docs**:
- `.rpiv/artifacts/plans/2026-06-23_16-32-38_client-id-mismatch-oauth.md` — plan artifact for preserving REST Integration Token state during MCP OAuth repair.

**Takeaway**: MCP-only auth repair must not erase REST credentials.

### Composite Lessons

- `client.json` and `tokens.json` form a coupled OAuth bundle; partial deletion creates client/token mismatch.
- Callback port conflict handling must not erase unrelated REST credentials.
- Port conflict can indicate a redirect URI issue for fresh browser auth, but does not prove existing tokens are invalid.
- Regression tests should cover state pairings and command lifecycle, not only file-level helpers.

## Historical Context (from `.rpiv/artifacts/`)

- `.rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md` — research artifact about OAuth client ID mismatch and persisted MCP OAuth state.
- `.rpiv/artifacts/plans/2026-06-23_16-32-38_client-id-mismatch-oauth.md` — implementation plan artifact for OAuth client mismatch repair.
- `.rpiv/artifacts/validation/2026-06-23_17-29-16_oauth-client-id-mismatch-repair.md` — validation artifact for the prior OAuth client mismatch repair.

## Developer Context

**Q (`src/mcp/client.ts:30`, `src/mcp/client.ts:45`): `connect()` currently deletes OAuth state on port mismatch before SDK token reuse is attempted. 修正方針として、ポート競合時の削除はどこまで許容しますか？**
A: そもそもトークン有効なときはcallback不要にできないかな？

**Q (`src/mcp/client.ts:18-63`, `src/auth/provider.ts:33-46`): Scan complete — write the doc, or adjust first?**
A: Write the doc (Recommended)

## Related Research

- `.rpiv/artifacts/research/2026-06-23_15-29-19_client-id-mismatch-oauth.md`

## Open Questions

- Exact implementation shape remains open: whether to delay callback server startup until `UnauthorizedError`, start it lazily only for browser authorization, or keep eager startup but suppress destructive invalidation when persisted tokens/client info exist.
