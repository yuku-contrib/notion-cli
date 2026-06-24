import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationFull,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import openBrowser from "open";
import { CALLBACK_PATH, CLIENT_NAME } from "../util/config.js";
import { CliError } from "../util/errors.js";
import type { CallbackServer } from "./callback-server.js";
import type { TokenStore } from "./token-store.js";

export interface NotionOAuthProviderOptions {
	preferredPort?: number;
	lazyCallback?: boolean;
}

export class NotionOAuthProvider implements OAuthClientProvider {
	private callbackStartPromise: Promise<void> | null = null;
	private callbackPromise: Promise<string> | null = null;
	private callbackPortFellBack = false;
	private forceClientReregistration = false;
	private pendingClientInfo: OAuthClientInformationMixed | null = null;
	private stageClientInfoUntilTokens = false;
	private oauthState: string | undefined;
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

	state(): string {
		this.oauthState ??= randomBytes(16).toString("hex");
		return this.oauthState;
	}

	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		if (this.pendingClientInfo) return this.pendingClientInfo;

		const clientInfo = this.tokenStore.readClientInfo() as OAuthClientInformationFull | undefined;
		if (this.lazyCallback) {
			await this.ensureCallbackServerStarted();
			if (this.shouldReregisterForFallbackPort()) {
				this.stageClientInfoUntilTokens = true;
				return undefined;
			}
		}
		return clientInfo;
	}

	async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
		if (this.stageClientInfoUntilTokens) {
			this.pendingClientInfo = info;
			return;
		}
		this.tokenStore.saveClientInfo(info as unknown as Record<string, unknown>);
	}

	tokens(): OAuthTokens | undefined {
		return this.tokenStore.readTokens() as OAuthTokens | undefined;
	}

	async saveTokens(tokens: OAuthTokens): Promise<void> {
		if (this.pendingClientInfo) {
			this.tokenStore.deleteTokens();
			this.tokenStore.saveClientInfo(this.pendingClientInfo as unknown as Record<string, unknown>);
			this.pendingClientInfo = null;
			this.stageClientInfoUntilTokens = false;
			this.forceClientReregistration = false;
		}
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
			this.beginCallbackWait();
		}
		await openBrowser(url.toString());
	}

	async waitForCallback(): Promise<string> {
		if (!this.callbackPromise) {
			if (this.lazyCallback) {
				await this.ensureCallbackServerStarted();
				return this.beginCallbackWait();
			}
			throw new CliError(
				"OAuth callback not started",
				"The authorization flow did not start before waiting for the callback",
				"Run ncli login to retry",
			);
		}
		return this.callbackPromise;
	}

	async invalidateCredentials(
		scope: "all" | "client" | "tokens" | "verifier" | "discovery",
	): Promise<void> {
		switch (scope) {
			case "all":
				this.tokenStore.deleteOAuthState();
				this.pendingClientInfo = null;
				this.stageClientInfoUntilTokens = false;
				this.forceClientReregistration = false;
				break;
			case "client":
				this.tokenStore.deleteClientInfo();
				this.pendingClientInfo = null;
				this.forceClientReregistration = true;
				break;
			case "tokens":
				this.tokenStore.deleteTokens();
				if (this.callbackPortFellBack) {
					this.forceClientReregistration = true;
				}
				break;
			case "verifier":
				this.tokenStore.deleteCodeVerifier();
				break;
			case "discovery":
				break;
		}
	}

	private async ensureCallbackServerStarted(): Promise<void> {
		if (this.callbackServer.port > 0) return;
		this.callbackStartPromise ??= this.callbackServer.start(this.preferredPort);
		await this.callbackStartPromise;
		this.callbackPortFellBack ||=
			this.preferredPort !== undefined && this.callbackServer.port !== this.preferredPort;
	}

	private beginCallbackWait(): Promise<string> {
		if (this.callbackPromise) return this.callbackPromise;

		const callbackPromise = this.callbackServer
			.waitForCallback(undefined, this.oauthState)
			.catch((error: unknown) => {
				if (this.callbackPromise === callbackPromise) {
					this.callbackPromise = null;
				}
				throw error;
			});
		this.callbackPromise = callbackPromise;
		return callbackPromise;
	}

	private shouldReregisterForFallbackPort(): boolean {
		if (!this.callbackPortFellBack) return false;
		if (this.forceClientReregistration) return true;

		const tokens = this.tokenStore.readTokens() as OAuthTokens | undefined;
		return !tokens?.refresh_token;
	}
}
