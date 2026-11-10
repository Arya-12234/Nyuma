import { isMintedAssertionWire } from "./canonical.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:8791/assertions";
const MAX_RESPONSE_BYTES = 4096;
const DEFAULT_TIMEOUT_MS = 2000;

export class AssertionClientError extends Error {
  constructor() {
    super("The assertion signer request failed.");
    this.name = "AssertionClientError";
  }
}

export interface AssertionRequestOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/**
 * Asks the loopback signer to mint an assertion for the original access token.
 * The JSON body has one property, `token`. The HMAC key is not available here.
 */
export async function requestAssertion(
  token: string,
  credential: string,
  options: AssertionRequestOptions = {},
): Promise<string> {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  if (!isLoopbackAssertionEndpoint(endpoint) || token.length === 0 || Buffer.byteLength(credential, "utf8") < 32) {
    throw new AssertionClientError();
  }
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        accept: "text/plain",
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new AssertionClientError();
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new AssertionClientError();
  }
  const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "" && mediaType !== "text/plain") throw new AssertionClientError();
  const body = await readBounded(response, MAX_RESPONSE_BYTES);
  if (!isMintedAssertionWire(body)) throw new AssertionClientError();
  return body;
}

function isLoopbackAssertionEndpoint(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:"
    && url.hostname === "127.0.0.1"
    && url.pathname === "/assertions"
    && url.username === ""
    && url.password === ""
    && url.search === ""
    && url.hash === "";
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new AssertionClientError();
  if (!response.body) throw new AssertionClientError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      size += step.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AssertionClientError();
      }
      chunks.push(step.value);
    }
  } catch (error) {
    if (error instanceof AssertionClientError) throw error;
    throw new AssertionClientError();
  }
  return Buffer.concat(chunks).toString("utf8");
}
