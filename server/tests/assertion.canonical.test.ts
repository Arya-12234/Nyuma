import { describe, expect, it } from "vitest";
import { encodeCanonicalPayload, isMintedAssertionWire, macCanonicalPayload, mintAssertion, wireAssertion } from "../src/assertion/canonical.js";

const key = Buffer.alloc(32, 0x01);
const subject = "58060e06-2f2a-4645-a8de-b4cc00414533";
const iat = 1762684200;

const fiveSecondPayload = "6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383432303500000000";
const fiveSecondMac = "677e169c3cd410b0ea2ec76ca3d85d63d76be9e000dc04691102c6107de6b441";
const fiveSecondWire = "nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDIwNQAAAAA.Z34WnDzUELDqLsdso9hdY9dr6eAA3ARpEQLGEH3mtEE";

const acceptancePayload = "6e7961310008746573742d6b6579000f6e79756d612d617373657274696f6e00086e79756d612d6462002435383036306530362d326632612d343634352d613864652d623463633030343134353333000a31373632363834323030000a3137363236383433323000000000";
const acceptanceMac = "d58a97bfbc03607a180c4a501f7efb63d936cfafc6c59edc4b11c9e787bf82ca";
const acceptanceWire = "nya1.bnlhMQAIdGVzdC1rZXkAD255dW1hLWFzc2VydGlvbgAIbnl1bWEtZGIAJDU4MDYwZTA2LTJmMmEtNDY0NS1hOGRlLWI0Y2MwMDQxNDUzMwAKMTc2MjY4NDIwMAAKMTc2MjY4NDMyMAAAAAA.1YqXv7wDYHoYDEpQH377Y9k2z6_GxZ7cSxHJ54e_gso";

describe("canonical nya1 assertions", () => {
  it("reproduces the published five-second HMAC fixture", () => {
    const payload = encodeCanonicalPayload({ kid: "test-key", sub: subject, iat, exp: iat + 5 });
    const mac = macCanonicalPayload(key, payload);
    expect(payload.toString("hex")).toBe(fiveSecondPayload);
    expect(mac.toString("hex")).toBe(fiveSecondMac);
    expect(wireAssertion(payload, mac)).toBe(fiveSecondWire);
  });

  it("reproduces the published 120-second acceptance vector", () => {
    const payload = encodeCanonicalPayload({ kid: "test-key", sub: subject, iat, exp: iat + 120 });
    const mac = macCanonicalPayload(key, payload);
    expect(payload.toString("hex")).toBe(acceptancePayload);
    expect(mac.toString("hex")).toBe(acceptanceMac);
    expect(mintAssertion({ key, kid: "test-key", sub: subject, iat })).toBe(acceptanceWire);
  });

  it("sets expiry exactly 120 seconds after the issued time", () => {
    const assertion = mintAssertion({ key, kid: "test-key", sub: subject, iat });
    const payload = Buffer.from(assertion.split(".")[1]!, "base64url");
    expect(payload.toString("hex")).toBe(acceptancePayload);
    expect(assertion).not.toBe(fiveSecondWire);
  });

  it("accepts only a minted 120-second wire", () => {
    expect(isMintedAssertionWire(acceptanceWire)).toBe(true);
    expect(isMintedAssertionWire(fiveSecondWire)).toBe(false);
    expect(isMintedAssertionWire(`${acceptanceWire} `)).toBe(false);
    expect(isMintedAssertionWire(`{"assertion":"${acceptanceWire}"}`)).toBe(false);
  });
});
