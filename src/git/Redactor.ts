export interface RedactionResult {
  ok: boolean;
  redactedText: string;
  redacted: boolean;
  blockedReason?: "redaction_scan_failed";
  findings: string[];
}

const REDACTIONS: Array<[string, RegExp]> = [
  ["api_key", /\bsk-[A-Za-z0-9_-]{16,}\b/gu],
  ["password", /\bpassword\s*[:=]\s*\S+/giu],
  ["token", /\b(?:token|bearer)\s*[:=]?\s*[A-Za-z0-9._-]{20,}/giu],
  ["cookie", /\b(?:cookie|session[_-]?secret)\s*[:=]\s*\S+/giu],
  ["oauth", /\b(?:client_secret|oauth[_-]?token)\s*[:=]\s*\S+/giu],
  ["wallet_seed", /\b(?:seed phrase|wallet seed)\s*[:=]?\s*(?:[a-z]+[\s,;.-]+){8,}[a-z]+\b/giu]
];

export class Redactor {
  redact(text: string): RedactionResult {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(text)) {
      return {
        ok: false,
        redactedText: "",
        redacted: false,
        blockedReason: "redaction_scan_failed",
        findings: ["private_key"]
      };
    }
    let redactedText = text;
    const findings: string[] = [];
    for (const [name, pattern] of REDACTIONS) {
      if (pattern.test(redactedText)) {
        findings.push(name);
        redactedText = redactedText.replace(pattern, `[REDACTED:${name}]`);
      }
    }
    return {
      ok: true,
      redactedText,
      redacted: findings.length > 0,
      findings
    };
  }
}
