import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RawMessage } from "../types.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { Redactor } from "./Redactor.js";

interface GitMdManifest {
  format?: string;
  agent_id?: string;
  owner?: {
    kind?: string;
    agent_id?: string;
  };
}

export function ensureGitMdManifest(input: { agentId: string; memoryRepoPath: string }) {
  mkdirSync(input.memoryRepoPath, { recursive: true });
  const manifestPath = join(input.memoryRepoPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          format: "oms-gitmd-v1",
          brainpack: "gitmd",
          agent_id: input.agentId,
          owner: {
            kind: "oms-agent",
            agent_id: input.agentId
          },
          created_at: new Date().toISOString(),
          source: "sqlite",
          redaction: { enabled: true, policy: "default" }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    return { ok: true as const };
  }

  let manifest: GitMdManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GitMdManifest;
  } catch {
    return { ok: false as const, reason: "memory_repo_manifest_invalid" };
  }
  const foundAgentId = manifest.owner?.agent_id ?? manifest.agent_id;
  if (foundAgentId !== input.agentId) {
    return { ok: false as const, reason: "memory_repo_agent_mismatch", foundAgentId };
  }
  return { ok: true as const };
}

export class GitMdWriter {
  private readonly redactor = new Redactor();
  private readonly renderer = new MarkdownRenderer();

  constructor(private readonly memoryRepoPath: string) {}

  writeRaw(input: { agentId: string; message: RawMessage; force?: boolean }) {
    const manifest = ensureGitMdManifest({ agentId: input.agentId, memoryRepoPath: this.memoryRepoPath });
    if (!manifest.ok) {
      return manifest;
    }

    const redaction = this.redactor.redact(input.message.originalText);
    if (!redaction.ok && !input.force) {
      return { ok: false as const, reason: redaction.blockedReason, findings: redaction.findings };
    }

    const filePath = this.rawFilePath(input.message);
    if (existsSync(filePath)) {
      return { ok: true as const, path: filePath, skipped: true, redacted: redaction.redacted };
    }

    mkdirSync(dirname(filePath), { recursive: true });
    try {
      writeFileSync(filePath, `${this.renderer.render(input.message, redaction.redactedText, redaction.redacted)}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "EEXIST") {
        return { ok: true as const, path: filePath, skipped: true, redacted: redaction.redacted };
      }
      throw error;
    }
    return { ok: true as const, path: filePath, skipped: false, redacted: redaction.redacted };
  }

  private rawFilePath(message: RawMessage): string {
    const date = new Date(message.createdAt);
    const year = String(date.getUTCFullYear());
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const sequence = String(message.sequence).padStart(8, "0");
    return join(this.memoryRepoPath, "raw", year, month, day, `${sequence}-${message.messageId}.md`);
  }
}
