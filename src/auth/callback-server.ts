import http from "node:http";
import { URL } from "node:url";
import { AUTH_TIMEOUT_MS, CALLBACK_PATH } from "../util/config.js";
import { CliError } from "../util/errors.js";

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body>
<h1>Authorization Successful</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

export class CallbackServer {
	private server: http.Server | null = null;
	private _port = 0;

	get port(): number {
		return this._port;
	}

	async start(preferredPort?: number): Promise<void> {
		const server = http.createServer();
		this.server = server;

		const listen = (port: number): Promise<void> =>
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(port, "127.0.0.1", () => {
					server.removeListener("error", reject);
					const addr = server.address();
					if (addr && typeof addr === "object") {
						this._port = addr.port;
					}
					resolve();
				});
			});

		if (preferredPort !== undefined) {
			try {
				await listen(preferredPort);
				return;
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
					// Port busy — fall back to random
					await listen(0);
					return;
				}
				throw err;
			}
		}

		await listen(0);
	}

	waitForCallback(timeoutMs = AUTH_TIMEOUT_MS, expectedState?: string): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const server = this.server;
			if (!server) {
				reject(
					new CliError(
						"Callback server not started",
						"start() must be called before waitForCallback()",
						"This is a bug — please report it",
					),
				);
				return;
			}

			server.on("request", (req: http.IncomingMessage, res: http.ServerResponse) => {
				if (!req.url) return;

				const url = new URL(req.url, `http://localhost:${this._port}`);
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404);
					res.end("Not Found");
					return;
				}

				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");
				const state = url.searchParams.get("state");

				if (error) {
					const description = url.searchParams.get("error_description") || error;
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end(`<h1>Authorization Failed</h1><p>${description}</p>`);
					reject(
						new CliError("OAuth authorization failed", description, "Run ncli login to retry"),
					);
					return;
				}

				if (!code) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<h1>Missing authorization code</h1>");
					reject(
						new CliError(
							"Missing authorization code",
							"OAuth callback did not include a code parameter",
							"Run ncli login to retry",
						),
					);
					return;
				}

				if (expectedState !== undefined && state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html" });
					res.end("<h1>Invalid OAuth state</h1>");
					reject(
						new CliError(
							"Invalid OAuth state",
							"OAuth callback state did not match the authorization request",
							"Run ncli login to retry",
						),
					);
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(SUCCESS_HTML);
				clearTimeout(timer);
				resolve(code);
			});

			const timer = setTimeout(() => {
				reject(
					new CliError(
						"OAuth callback timed out",
						`No response received within ${timeoutMs / 1000} seconds`,
						"Run ncli login to retry",
					),
				);
				this.stop();
			}, timeoutMs);

			server.on("close", () => clearTimeout(timer));
		});
	}

	stop(): void {
		if (this.server) {
			this.server.close();
			this.server = null;
		}
	}
}
