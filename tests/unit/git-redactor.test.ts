import { describe, expect, it } from "vitest";
import { Redactor } from "../../src/git/Redactor.js";

describe("git redactor", () => {
  it("redacts token-like secrets", () => {
    const result = new Redactor().redact("token: abcdefghijklmnopqrstuvwxyz123456");
    expect(result.ok).toBe(true);
    expect(result.redactedText).toContain("[REDACTED:token]");
  });

  it("blocks private keys by default", () => {
    const result = new Redactor().redact("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----");
    expect(result.ok).toBe(false);
    expect(result.blockedReason).toBe("redaction_scan_failed");
  });

  it("redacts wallet seed phrases", () => {
    const result = new Redactor().redact("wallet seed abandon ability able about above absent absorb abstract absurd abuse access");
    expect(result.ok).toBe(true);
    expect(result.redactedText).toContain("[REDACTED:wallet_seed]");
  });
});
