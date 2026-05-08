export interface SecretScanResult {
  ok: boolean;
  detected: string[];
  reason?: string;
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["api_key", /\b(?:api[_-]?key|sk-[A-Za-z0-9_-]{16,})\b/iu],
  ["password", /\bpassword\s*[:=]\s*\S+/iu],
  ["token", /\b(?:token|bearer)\s*[:=]?\s*[A-Za-z0-9._-]{20,}/iu],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["wallet_seed", /\b(?:seed phrase|wallet seed)\b/iu],
  ["cookie", /\b(?:cookie|session[_-]?secret)\s*[:=]\s*\S+/iu],
  ["oauth", /\b(?:client_secret|oauth[_-]?token)\s*[:=]\s*\S+/iu]
];

export class SecretScanner {
  scan(text: string): SecretScanResult {
    const detected = SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
    return {
      ok: detected.length === 0,
      detected,
      reason: detected.length === 0 ? undefined : "secret_detected"
    };
  }
}

export function hasDetectedSecrets(metadata?: Record<string, unknown>): boolean {
  const secretScan = metadata?.secretScan;
  if (!secretScan || typeof secretScan !== "object") {
    return false;
  }
  const detected = (secretScan as { detected?: unknown }).detected;
  return Array.isArray(detected) && detected.length > 0;
}
