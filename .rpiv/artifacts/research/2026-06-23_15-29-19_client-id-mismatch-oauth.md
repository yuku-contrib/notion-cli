---
date: 2026-06-23T15:29:19+0900
author: Yuku Kotani
commit: a325ac7
branch: main
repository: notion-cli
topic: "`ncli login` 後しばらくして再度 ncli を使うと `Client ID mismatch` が出る問題"
tags: [research, codebase, oauth, mcp, auth, client-id-mismatch]
status: ready
last_updated: 2026-06-23T15:29:19+0900
last_updated_by: Yuku Kotani
---

# Research: `ncli login` 後しばらくして再度 ncli を使うと `Client ID mismatch` が出る問題

## Research Question

`ncli login` してしばらくしてから再度 ncli を使うと、`Client ID mismatch` というエラーが出てしまう。
このissue https://github.com/metatool-ai/metamcp/issues/296 などを参考に修正する。

## Summary

もっとも疑わしい現在の不整合は、OAuth Dynamic Client Registration の `client.json` と refresh token を含む `tokens.json` が別ファイルとして独立に扱われ、`client.json` だけが削除・再登録され得る点である。
`src/mcp/client.ts:24-30` は保存済み redirect port が使えない場合に `client.json` だけ削除するため、旧 `client_id` に紐づく refresh token が `tokens.json` に残る。
その後、SDK が新しい client registration または `clientInformation() === undefined` と古い tokens を同時に見ると、refresh/token exchange で `Client ID mismatch` が表面化し得る。
`ncli login` はクリーン再認可ではなく通常の `withConnection()` 経由の `notion-get-users` 呼び出しなので、既存の壊れた OAuth 状態をそのまま再利用する。
MetaMCP #296 は同一の実装バグではないが、「ブラウザ側の code/client_id と永続化された client_id がずれると Notion 動的登録で `Client ID mismatch` になる」という同型の OAuth invariant を示す参考事例であり、ncli 固有の主因はローカルファイルの split-brain 状態である。

## Detailed Findings

### MCP 接続時に `client.json` が callback port と SDK client information を兼ねる

- `MCPConnection.connect()` は `TokenStore(CONFIG_DIR)` と `CallbackServer` を作成する（`src/mcp/client.ts:18-21`）。
- 保存済み `client.json` は `tokenStore.readClientInfo()` で読み込まれ、`extractPortFromClientInfo()` に渡される（`src/mcp/client.ts:24`、`src/auth/token-store.ts:51-52`）。
- `extractPortFromClientInfo()` は `redirect_uris[0]` の URL port を数値化する（`src/mcp/client.ts:185-195`）。
- 抽出された port は `CallbackServer.start(savedPort)` の preferred port になる（`src/mcp/client.ts:25`、`src/auth/callback-server.ts:24-55`）。
- 同じ `client.json` は OAuth provider の `clientInformation()` から MCP SDK に返される（`src/auth/provider.ts:33-34`）。

### port fallback 時に `client.json` だけ削除され、`tokens.json` が残る

- `CallbackServer.start()` は preferred port が `EADDRINUSE` の場合に `listen(0)` へ fallback する（`src/auth/callback-server.ts:41-49`）。
- 実 port が saved port と違うと、`MCPConnection.connect()` は cached redirect URI が stale と判断して `tokenStore.deleteClientInfo()` だけ呼ぶ（`src/mcp/client.ts:27-30`）。
- `deleteClientInfo()` は `client.json` だけを削除する（`src/auth/token-store.ts:59-60`）。
- `tokens.json` を消す処理は `deleteTokens()` または `deleteAll()` だけである（`src/auth/token-store.ts:47-48`、`src/auth/token-store.ts:89-94`）。
- したがって `clientInformation() => undefined/new client` と `tokens() => old refresh token` の組み合わせが成立する（`src/auth/provider.ts:33-46`）。

### OAuth provider は client と tokens の整合性を検証しない

- `NotionOAuthProvider` は `TokenStore` と `CallbackServer` を保持する薄い adapter である（`src/auth/provider.ts:13-17`）。
- `redirectUrl` は現在の callback server port から構築される（`src/auth/provider.ts:19-20`）。
- `clientMetadata.redirect_uris` も現在 port の redirect URL を使う（`src/auth/provider.ts:23-30`）。
- `clientInformation()` は `client.json`、`tokens()` は `tokens.json` を独立に返す（`src/auth/provider.ts:33-46`）。
- `research/03-mcp-sdk-and-existing-tools.md:62-84` は `OAuthClientProvider` に `invalidateCredentials(scope)` があることを記録しているが、`docs/auth.md:82-95` では ncli の `invalidateCredentials()` は未実装 / no-op と記載されている。

### `ncli login` は強制ログインではなく通常接続である

- `login` command は `withConnection()` 内で `notion-get-users` を呼ぶ（`src/commands/login.ts:9-15`）。
- `whoami` も同じ `notion-get-users` 呼び出しである（`src/commands/login.ts:33-39`）。
- OAuth 状態を明示的に消すのは `logout` の `store.deleteAll()` だけである（`src/commands/login.ts:19-29`）。
- 通常コマンドも `withConnection()` 経由で `conn.connect()` 後に tool を呼ぶ（`src/mcp/with-connection.ts:4-14`）。
- そのため「login は成功したが後で失敗」は、login と通常コマンドが同じ壊れた永続状態を再利用する経路と整合する。

### refresh request は `refresh_token` と `client_id` の組み合わせに依存する

- 既存調査は Notion MCP / OAuth の refresh request が `grant_type=refresh_token`、`refresh_token`、`client_id` を含むことを記録している（`research/02-oauth-and-mcp-protocol.md:154-167`）。
- 同じ調査は `invalid_grant` の原因に認証情報不一致、古い token、並行 refresh 等を挙げている（`research/02-oauth-and-mcp-protocol.md:146-152`）。
- `docs/auth.md:45-58` は 2回目以降の接続で SDK が `tokens.json` から token を読み、401 + refresh token ありなら自動 refresh すると説明している。
- `docs/auth.md:76-80` は Notion の access token 失効が 1時間で、refresh token rotation があることを記録している。

### エラー経路は cleanup しない raw SDK Error になり得る

- `MCPConnection.connect()` は `client.connect(transport)` の catch で `UnauthorizedError` だけ特別扱いする（`src/mcp/client.ts:45-58`）。
- `UnauthorizedError` 以外は callback server を止めてそのまま throw する（`src/mcp/client.ts:59-62`）。
- `withConnection()` は `conn.connect()` を retry 対象にせず、catch で `process.exitCode = 1` を設定して再 throw する（`src/mcp/with-connection.ts:7-11`）。
- top-level は通常の `Error` を `Error: ${error.message}` として表示するだけで、`CliError` の hint は付かない（`src/index.ts:5-28`、`src/util/errors.ts:12-23`）。
- MCP tool result の `isError` は `mcpErrorToCliError()` で `CliError` 化されるが、これは接続後の tool call の経路である（`src/mcp/client.ts:77-82`、`src/mcp/client.ts:179-182`）。

### 既存テストは低レベル挙動のみを pin している

- `extractPortFromClientInfo()` のテストは port 抽出、missing `redirect_uris`、empty array、明示 port なしを検証している（`src/mcp/client.test.ts:5-31`）。
- `MCPConnection` のテストは未接続時 guard と disconnect safety のみで、`connect()` の auth flow は実行していない（`src/mcp/client.test.ts:34-52`）。
- `TokenStore` の tests は tokens/client/code verifier/rest token の個別 read/write/delete と file permission を検証している（`src/auth/token-store.test.ts:20-107`）。
- `deleteAll()` は全ファイル削除を検証している（`src/auth/token-store.test.ts:110-120`）。
- `CallbackServer` は preferred port 使用と `EADDRINUSE` fallback を検証している（`src/auth/callback-server.test.ts:18-59`）。
- 未検証なのは、`client.json` だけ削除され `tokens.json` が残る状態、古い tokens と新 client の組み合わせ、`Client ID mismatch` 発生時の cleanup/retry である。

## Code References

- `src/mcp/client.ts:18-63` — MCP connection の OAuth transport 作成、UnauthorizedError handling、raw error propagation。
- `src/mcp/client.ts:24-30` — `client.json.redirect_uris` 由来の saved port と、port mismatch 時の `deleteClientInfo()`。
- `src/mcp/client.ts:41-58` — `StreamableHTTPClientTransport` への provider 注入、`finishAuth()` 後の再接続。
- `src/mcp/client.ts:185-195` — `redirect_uris[0]` から callback port を抽出する純粋関数。
- `src/auth/provider.ts:13-67` — `OAuthClientProvider` 実装。client/tokens/code verifier/redirect URL の SDK 境界。
- `src/auth/token-store.ts:39-60` — `tokens.json` と `client.json` の独立 read/save/delete。
- `src/auth/token-store.ts:89-94` — logout で使う全 auth state 削除。
- `src/auth/callback-server.ts:24-55` — preferred port 起動と `EADDRINUSE` fallback。
- `src/commands/login.ts:7-40` — `login` / `logout` / `whoami` の実体。
- `src/mcp/with-connection.ts:4-14` — すべての MCP command の connection wrapper。
- `src/util/config.ts:6-14` — config dir、file path 定数、MCP URL、callback path。
- `src/util/errors.ts:12-23` — raw Error と CliError の表示差分。
- `src/mcp/client.test.ts:5-52` — port extraction と未接続 guard の既存テスト。
- `src/auth/token-store.test.ts:20-120` — TokenStore の個別ファイル操作と `deleteAll()` の既存テスト。
- `docs/auth.md:45-58` — 2回目以降の token refresh flow の設計記述。
- `research/02-oauth-and-mcp-protocol.md:154-167` — refresh request が `refresh_token` と `client_id` を送ること。

## Integration Points

### Inbound References

- `src/commands/login.ts:12-15` — `ncli login` が `withConnection()` を使い `notion-get-users` を呼ぶ。
- `src/commands/login.ts:36-39` — `ncli whoami` も同じ connection / tool call 経路を使う。
- `src/commands/search.ts:18-20` — 通常 MCP command の例として `withConnection()` → `callTool()` を使う。
- `src/commands/fetch.ts:18-20` — 通常 MCP command の例として `withConnection()` → `callTool()` を使う。
- `src/commands/api.ts:48-50` — escape hatch も同じ connection wrapper を使う。
- `src/commands/page.ts:160-216` — page 系 command 群も同じ wrapper から MCP tools を呼ぶ。

### Outbound Dependencies

- `@modelcontextprotocol/sdk/client/index.js` — `Client` を `MCPConnection` が生成する（`src/mcp/client.ts:2`、`src/mcp/client.ts:38`）。
- `@modelcontextprotocol/sdk/client/streamableHttp.js` — `StreamableHTTPClientTransport` に auth provider を渡す（`src/mcp/client.ts:3`、`src/mcp/client.ts:41-43`）。
- `@modelcontextprotocol/sdk/client/auth.js` — `UnauthorizedError` のみ接続時に特別扱いする（`src/mcp/client.ts:1`、`src/mcp/client.ts:48`）。
- `open` — OAuth authorization URL をブラウザで開く（`src/auth/provider.ts:7`、`src/auth/provider.ts:65-66`）。
- Node `http` — local callback server を提供する（`src/auth/callback-server.ts:1`、`src/auth/callback-server.ts:24-55`）。
- Node `fs` / `path` — auth state を config dir に JSON 保存する（`src/auth/token-store.ts:1-28`）。

### Infrastructure Wiring

- `src/util/config.ts:6` — `CONFIG_DIR` は `envPaths("ncli", { suffix: "" })` 由来。
- `src/util/config.ts:7-9` — `TOKENS_PATH` / `CLIENT_INFO_PATH` / `AUTH_STATE_PATH` は意図された file layout を示す。
- `src/util/config.ts:11` — remote MCP server は `https://mcp.notion.com/mcp` 固定。
- `src/util/config.ts:13` — OAuth callback path は `/callback` 固定。
- `src/auth/callback-server.ts:75-79` — callback server は `CALLBACK_PATH` 以外を 404 にする。
- `src/auth/provider.ts:19-30` — provider の redirect URL と client metadata は callback server の実 port に依存する。

## Architecture Insights

- `client.json` は OAuth client registration cache であり、単なる callback port cache ではない。
- `tokens.json` 内の refresh token は、取得時の `client_id` と事実上結合して扱う必要がある。
- 現在の境界では `TokenStore` は永続化だけを担当し、OAuth state bundle の整合性を知らない。
- 現在の `NotionOAuthProvider` は SDK adapter として薄く、client/tokens の整合性や invalidation policy を持たない。
- `ncli login` は「ログイン済み確認 / 必要なら認可」の command であり、「既存 OAuth state を捨てる」command ではない。
- 修正方針は少なくとも2候補ある: (1) client registration を無効化する時に tokens/code verifier もまとめて無効化する、(2) provider 側で client/tokens の不整合を SDK に渡さない。Developer checkpoint では両方を比較記録する方針になった。
- raw SDK auth error を `CliError` に変換しない現状では、ユーザー向け hint と自動 cleanup の入口がない。

## Precedents & Lessons

3 similar past changes analyzed.

### Precedent: OAuth re-login redirect URI mismatch fix

**Commit(s)**: `0d8ea33` — "fix: OAuth 再ログイン時の \"Invalid redirect URI\" エラーを修正 (#2)" (2026-03-20)
**Blast radius**: 5 files across 4 layers
  auth/ — `CallbackServer.start(preferredPort)` と port conflict fallback
  mcp/ — `client.json.redirect_uris` から saved port を導出し、port mismatch 時に stale client registration を削除
  docs/ — callback port reuse を記録
  tests/ — callback server fallback と port extraction coverage

**Follow-up fixes**:
- None found after 2026-03-21 in the listed auth/MCP files

**Lessons from docs**:
- `docs/auth.md:98-105` — cached `client_id` を再利用するには redirect URI port を合わせる必要がある。
- `research/02-oauth-and-mcp-protocol.md:154-167` — refresh request は `refresh_token` と `client_id` を同時に送る。

**Takeaway**: redirect URI mismatch を避けるための `client.json` 再登録処理が、refresh token との結合を崩す可能性がある。

### Precedent: Initial MCP OAuth + token persistence

**Commit(s)**: `100d7d3` — "Initial Commit" (2026-03-18)
**Blast radius**: 64 files across 7 layers
  auth/ — OAuth provider、callback server、token/client/code-verifier store
  mcp/ — connection lifecycle、SDK transport、UnauthorizedError auth flow
  commands/ — `login`、`logout`、`whoami`
  util/ — config paths、MCP URL、error formatting/retry
  docs/research/ — OAuth/MCP protocol docs
  tests/ — token store、command、MCP tests

**Follow-up fixes**:
- `0d8ea33` — random callback port が cached `client.json` と合わず re-login で Invalid redirect URI になった。

**Lessons from docs**:
- `docs/auth.md:60-74` — config dir には `client.json`、`tokens.json`、`auth-state.json` が並ぶ。
- `docs/auth.md:82-95` — SDK の `invalidateCredentials()` は未実装 / no-op と記録されている。

**Takeaway**: SDK の invalidation に任せず、ncli 側で壊れた OAuth state の削除単位を明示する必要がある。

### Precedent: CLI identity/config rename affecting OAuth state

**Commit(s)**: `638f40f` — "Rename notion-cli to ncli for Notion Brand Guidelines compliance" (2026-03-19)
**Blast radius**: 27 files across 7 layers
  auth/ — login retry hints renamed
  mcp/ — SDK client name/version changed
  util/ — `envPaths` app name and `CLIENT_NAME` changed
  docs/legal/skills/commands/ — user-facing rename

**Follow-up fixes**:
- `321e674` — "Read version from package.json instead of hardcoding" (2026-03-20)
- `dad10c7` — "Fix version embedding: use tsup define instead of createRequire" (2026-03-20)

**Lessons from docs**:
- `src/util/config.ts:4-13` — config path、client name、callback path は OAuth state の保存・再利用に影響する。

**Takeaway**: client identity や config path 付近の変更は、既存 OAuth state を孤立させる可能性がある。

### External Reference: MetaMCP #296

**Issue**: https://github.com/metatool-ai/metamcp/issues/296 — "OAuth race: non-atomic OAuthSessionsRepository.upsert() + double-fire auto-connect useEffect cause Client ID mismatch on token exchange" (opened 2026-05-20)
**Applicability**: exact root cause is not the same as ncli. MetaMCP is a concurrent web/database race; ncli is a local CLI state-coupling problem.
**Relevant invariant**: the issue describes two dynamic registrations producing distinct `client_id`s; the browser carries one `client_id` while the DB persists another, and token exchange fails with `invalid_grant: Client ID mismatch`.
**Takeaway**: keep `client_id`, authorization code/code verifier, and tokens from the same OAuth attempt/registration together. Do not let persistence expose a mixed pair.

### Composite Lessons

- OAuth client registration and refresh tokens are coupled by `client_id`; clearing or replacing only `client.json` can leave a refresh token that later fails.
- The earlier redirect URI fix solved one persisted-state mismatch but introduced/left open a second mismatch between client registration and tokens.
- Regression coverage should cover OAuth state pairings, not only individual file read/write/delete operations.
- External MetaMCP evidence is useful only as an OAuth invariant example; ncli design should be grounded in local `TokenStore` / provider / connect behavior.

## Historical Context (from `.rpiv/artifacts/`)

No `.rpiv/artifacts/` documents existed before this research artifact.

## Developer Context

**Q (`src/mcp/client.ts:29-30`, `src/auth/token-store.ts:47-60`): `MCPConnection.connect()` は保存済みport不一致時に `client.json` だけを削除し、TokenStoreでは `tokens.json` と `client.json` が独立削除です。調査ドキュメントでは、どの修正方針を優先前提として記録しますか？**
A: 両方を比較記録。

**Q (checkpoint): Scan complete — write the doc, or adjust first?**
A: Write the doc (Recommended)。

**Q (follow-up): MetaMCPの事例に関しては、もし無関係なら記載しなくていい。**
A: 完全に同一原因ではないため、主因としては扱わず、`client_id` が混線すると `Client ID mismatch` になる外部参考事例として限定的に記載する。

## Related Research

- `docs/auth.md` — current OAuth design, token storage, redirect port reuse, SDK refresh behavior.
- `research/02-oauth-and-mcp-protocol.md` — OAuth/MCP protocol details, refresh request shape, invalid_grant causes.
- `research/03-mcp-sdk-and-existing-tools.md` — MCP SDK OAuth provider interface and `invalidateCredentials()` surface.

## Open Questions

- 実環境の `Client ID mismatch` が raw SDK `Error`、OAuth callback `CliError`、MCP tool `isError` のどの経路で出ているかは、再現ログがないため未確定。
- 修正は「OAuth状態を一括クリア」と「providerで不整合を遮断」のどちらか、または両方を採用するかを設計段階で決める必要がある。
- `ncli login` を今後も「既存状態を再利用する login」とするか、「明示的な再認可/repair command」に近づけるかは仕様判断が必要。
