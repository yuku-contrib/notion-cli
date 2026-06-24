# Authentication

## 概要

OAuth 2.0 + PKCE で Remote Notion MCP に認証。MCP SDK の内蔵 OAuth フローを活用。

## 認証フロー

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
  │   ├── refresh_token が有効なら保存済み client_id のまま自動リフレッシュ
  │   ├── refresh 不可 + fallback port の場合は actual port で Dynamic Client Registration (RFC 7591)
  │   ├── SDK: PKCE 生成 (S256)
  │   ├── provider.saveClientInformation() → fallback port 再登録時はメモリに一時保持
  │   ├── provider.saveCodeVerifier() → auth-state.json に保存
  │   └── provider.redirectToAuthorization(url)
  │       ├── state 付き callback 待機を開始
  │       └── ブラウザで認可 URL を開く
  │
  ├── UnauthorizedError throw → MCPConnection がキャッチ
  │
  ├── provider.waitForCallback() (120s timeout)
  │   └── http://localhost:PORT/callback?code=...&state=... 受信（state 検証）
  │
  ├── transport.finishAuth(code)
  │   ├── SDK: code → token 交換
  │   └── provider.saveTokens() → fallback port 再登録時は client.json + tokens.json をまとめて確定 (0o600)
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

## トークン保存

`env-paths` で OS 適切なパスを取得:

```
macOS:  ~/Library/Preferences/ncli/
Linux:  ~/.config/ncli/
Windows: %APPDATA%\ncli\Config\

├── client.json           # OAuth client registration (client_id, redirect_uris, etc.)
├── tokens.json           # access_token, refresh_token, expires_at
└── auth-state.json       # codeVerifier (一時、logout 時にクリア)
```

全ファイル `0o600` (owner read/write only)。

## Notion 固有の挙動

- **アクセストークン失効**: 1時間
- **リフレッシュトークンローテーション**: 使用すると古いトークンが無効化、新しいものが発行
- **`invalid_grant`**: 再認証が必要（トークン失効、並行リフレッシュ、ユーザー取消等）

## OAuthClientProvider 実装ポイント

SDK の `OAuthClientProvider` インターフェースを実装する。主要メソッド:

| メソッド | 実装 |
|---|---|
| `redirectUrl` | `http://127.0.0.1:{port}/callback` (ブラウザ認可時に起動した callback server の port) |
| `clientMetadata` | `{ client_name: "ncli", grant_types: [...], token_endpoint_auth_method: "none" }` |
| `tokens()` / `saveTokens()` | TokenStore 経由で tokens.json を読み書き。`tokens()` は callback server を起動しない |
| `clientInformation()` / `saveClientInformation()` | TokenStore 経由で client.json を読み書き。OAuth auth path では callback server を起動する。fallback port でも refresh_token が残っている間は保存済み client_id を返して refresh を優先し、refresh 失敗後に actual port で再登録させる |
| `redirectToAuthorization(url)` | state 付き callback 待機を開始してから `open(url)` |
| `codeVerifier()` / `saveCodeVerifier()` | TokenStore 経由で auth-state.json を読み書き |
| `state()` | OAuth state を生成し、callback 受信時に照合 |
| `invalidateCredentials()` | SDK の invalid client/grant 通知に応じて MCP OAuth state を削除。fallback port で token invalidation が起きた場合は client 再登録へ切り替える |

`CallbackServer` は `MCPConnection` が所有し、provider に参照を渡す（共有状態パターン）。通常接続では起動せず、SDK が OAuth auth path に入った時だけ provider が起動する。

## コールバックポートの再利用

Dynamic Client Registration で登録される `redirect_uris` にはコールバックサーバーのポートが含まれる。`client.json` にキャッシュされた `client_id` を再利用してブラウザ認可に進む場合、同じポートで listen できると redirect_uri mismatch を避けられる。

**対策**: `connect()` は `client.json` の `redirect_uris` から保存済みポートを導出するが、通常接続では `CallbackServer` を起動しない。SDK が保存済み token で接続できる場合、callback port は不要。

- SDK が 401 後の OAuth auth flow に入った時点で `CallbackServer.start(savedPort)` を呼ぶ（refresh だけで復旧する場合も listener が起動済みになることがある）
- ポート競合時は `listen(0)` にフォールバックするが、フォールバックだけでは MCP OAuth state (`client.json`, `tokens.json`, `auth-state.json`) を破棄しない
- fallback port でも refresh_token がある場合は、まず保存済み `client_id` と refresh_token の組でリフレッシュを試す
- refresh が invalid_grant 等で失敗し fallback port でブラウザ認可に進む場合は、保存済み `client_id` を使わず actual port で Dynamic Client Registration し直す
- fallback port の新しい `client.json` は token 交換成功までメモリ上に保持し、`saveTokens()` で `client.json` と `tokens.json` を同じ成功パスで確定する
- `redirect_uris` がない（旧バージョンの `client.json`）場合は、ブラウザ認可が必要になった時にランダムポートで起動する
- 明示的に credentials を消したい場合は `ncli logout` を使う

## REST API 認証

### 概要

REST API コマンド (`ncli rest`, `ncli file`) は Integration Token (Bearer token) で認証。
MCP の OAuth とは別系統。

### トークン解決順序

1. `NOTION_API_KEY` 環境変数（最優先 — CI/CD・エージェント向け）
2. `rest-token.json` ファイル (`CONFIG_DIR` 内)
3. エラー + ヒント: `Set NOTION_API_KEY or run "ncli rest login"`

### トークン保存

```
macOS:  ~/Library/Preferences/ncli/rest-token.json
Linux:  ~/.config/ncli/rest-token.json
```

ファイル権限 `0o600` (owner read/write only)。

### MCP 認証との違い

| 項目 | MCP (OAuth) | REST API (Token) |
|---|---|---|
| 認証方式 | OAuth 2.0 + PKCE | Integration Token (Bearer) |
| セットアップ | `ncli login` (ブラウザ) | `ncli rest login` or `NOTION_API_KEY` env var |
| トークン | access_token + refresh_token | 単一の integration token |
| 自動リフレッシュ | ✅ (SDK 内蔵) | ❌ (トークンは無期限) |
| 用途 | 検索、ページ、DB、ビュー等 | 任意の REST API 呼び出し、ファイルアップロード |
