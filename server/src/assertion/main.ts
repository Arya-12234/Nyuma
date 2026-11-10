import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { mintAssertion } from "./canonical.js";
import { authorizationCredential, credentialsMatch } from "./credential.js";
import { parseTokenRequest } from "./request.js";
import type { SignerSettings } from "./config.js";
import { verifySupabaseSubject } from "./verifySupabase.js";

export interface SignerLogEvent {
  status: number;
  code: string;
}

export function createSigner(
  settings: SignerSettings,
  options: { nowSeconds?: () => number; log?: (event: SignerLogEvent) => void } = {},
): Server {
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? (() => undefined);
  return createServer((request, response) => {
    void handle(request, response, settings, nowSeconds, log);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  settings: SignerSettings,
  nowSeconds: () => number,
  log: (event: SignerLogEvent) => void,
): Promise<void> {
  const path = request.url?.split("?")[0];
  if (request.method !== "POST" || path !== "/assertions") {
    send(response, 404, "not-found", log);
    request.destroy();
    return;
  }
  const presented = authorizationCredential(request.headers.authorization);
  if (presented === null || !credentialsMatch(presented, settings.credentials)) {
    send(response, 401, "unauthorized", log);
    request.destroy();
    return;
  }
  const mediaType = (request.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    send(response, 400, "invalid-request", log);
    request.destroy();
    return;
  }
  let body: string;
  try {
    body = await readBody(request);
  } catch {
    send(response, 400, "invalid-request", log);
    return;
  }
  const token = parseTokenRequest(body);
  if (token === null) {
    send(response, 400, "invalid-request", log);
    return;
  }
  try {
    const subject = await verifySupabaseSubject(token, { issuer: settings.issuer, keys: settings.keys });
    const assertion = mintAssertion({
      key: settings.hmacKey,
      kid: settings.keyId,
      sub: subject,
      iat: nowSeconds(),
    });
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    response.end(assertion);
    log({ status: 200, code: "ok" });
  } catch {
    send(response, 401, "invalid-token", log);
  }
}

function send(
  response: ServerResponse,
  status: number,
  code: "unauthorized" | "invalid-request" | "invalid-token" | "not-found",
  log: (event: SignerLogEvent) => void,
): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
  response.end(code);
  log({ status, code });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 16 * 1024) {
        request.destroy();
        reject(new Error("too-large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => reject(new Error("unreadable")));
  });
}

export function listenOnLoopback(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      resolve(address && typeof address === "object" ? address.port : port);
    });
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isDirectRun()) {
  try {
    const { loadSignerSettings } = await import("./config.js");
    const settings = loadSignerSettings(process.env);
    const server = createSigner(settings);
    const port = await listenOnLoopback(server, settings.port);
    console.log(`Nyuma assertion signer listening on 127.0.0.1:${port}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "The signer could not start.");
    process.exit(1);
  }
}
