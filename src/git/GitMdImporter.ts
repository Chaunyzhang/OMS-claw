import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import { RawWriter } from "../ingest/RawWriter.js";
import type { RawMessage, RawRole, RawWriteInput } from "../types.js";

export type GitMdImportMode = "preview" | "import";
export type GitMdDuplicatePolicy = "skip" | "force" | "import_as_reference";

interface GitMdManifest {
  format?: string;
  agent_id?: string;
  owner?: {
    agent_id?: string;
  };
}

interface ParsedGitMdRaw {
  filePath: string;
  messageId: string;
  agentId?: string;
  sessionId: string;
  turnId?: string;
  role: RawRole;
  eventType: string;
  timestamp?: string;
  sourcePurpose?: RawWriteInput["sourcePurpose"];
  sourceAuthority?: RawWriteInput["sourceAuthority"];
  evidencePolicyMask?: RawWriteInput["evidencePolicyMask"];
  originalHash?: string;
  redacted?: boolean;
  body: string;
}

interface DuplicateHit {
  messageId: string;
  reason: "source_signature" | "original_hash";
}

interface ImportCandidate {
  parsed: ParsedGitMdRaw;
  duplicate?: DuplicateHit;
  blockedReason?: string;
}

export class GitMdImporter {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly rawWriter: RawWriter,
    private readonly events: EventStore
  ) {}

  import(input: {
    targetAgentId: string;
    sourceRepoPath: string;
    mode?: string;
    duplicatePolicy?: string;
    limit?: number;
  }) {
    const mode = input.mode === "import" ? "import" : "preview";
    const duplicatePolicy = this.duplicatePolicy(input.duplicatePolicy);
    const limit = this.positiveLimit(input.limit, 10000);
    const sourceRepoPath = this.resolveSourceRepoPath(input.sourceRepoPath);
    const manifest = this.readManifest(sourceRepoPath);
    if (!manifest.ok) {
      return manifest;
    }

    const files = this.listRawMarkdownFiles(sourceRepoPath).slice(0, limit);
    const existing = this.existingIndex(input.targetAgentId);
    const importBatchId = `import_${new Date().toISOString().replace(/[-:.]/gu, "").replace("T", "_").replace("Z", "")}_${randomUUID().slice(0, 8)}`;
    const candidates = files.map((filePath) => this.buildCandidate(filePath, manifest.sourceAgentId, existing));
    const importable = candidates.filter((candidate) => !candidate.blockedReason && !candidate.duplicate);
    const duplicateCandidates = candidates.filter((candidate) => !candidate.blockedReason && candidate.duplicate);
    const blocked = candidates
      .filter((candidate) => candidate.blockedReason)
      .map((candidate) => ({ path: candidate.parsed.filePath, reason: candidate.blockedReason }));

    if (mode === "preview") {
      return {
        ok: true,
        mode,
        duplicatePolicy,
        importBatchId,
        targetAgentId: input.targetAgentId,
        sourceAgentId: manifest.sourceAgentId,
        sourceRepoPath,
        scanned: files.length,
        importable: importable.length,
        duplicates: duplicateCandidates.length,
        blocked
      };
    }

    const sessionId = importBatchId;
    let imported = 0;
    let skipped = 0;
    let referenced = 0;
    const receipts: Array<{ sourceMessageId: string; targetMessageId?: string; status: string; reason?: string }> = [];
    let turnIndex = 1;

    for (const candidate of candidates) {
      if (candidate.blockedReason) {
        skipped += 1;
        receipts.push({ sourceMessageId: candidate.parsed.messageId, status: "blocked", reason: candidate.blockedReason });
        continue;
      }
      if (candidate.duplicate && duplicatePolicy === "skip") {
        skipped += 1;
        receipts.push({ sourceMessageId: candidate.parsed.messageId, targetMessageId: candidate.duplicate.messageId, status: "skipped_duplicate", reason: candidate.duplicate.reason });
        continue;
      }
      if (candidate.duplicate && duplicatePolicy === "import_as_reference") {
        referenced += 1;
        this.events.record({
          agentId: input.targetAgentId,
          sessionId,
          messageId: candidate.duplicate.messageId,
          eventType: "gitmd_import_reference",
          payload: this.provenancePayload({
            importBatchId,
            sourceAgentId: manifest.sourceAgentId,
            sourceRepoPath,
            parsed: candidate.parsed,
            duplicate: candidate.duplicate
          })
        });
        receipts.push({ sourceMessageId: candidate.parsed.messageId, targetMessageId: candidate.duplicate.messageId, status: "referenced_duplicate", reason: candidate.duplicate.reason });
        continue;
      }

      const writeInput = this.toRawWriteInput({
        targetAgentId: input.targetAgentId,
        sessionId,
        turnIndex,
        importBatchId,
        sourceAgentId: manifest.sourceAgentId,
        sourceRepoPath,
        parsed: candidate.parsed
      });
      turnIndex += 1;
      const receipt = this.rawWriter.write(writeInput);
      if (receipt.ok) {
        imported += 1;
        receipts.push({ sourceMessageId: candidate.parsed.messageId, targetMessageId: receipt.messageId, status: "imported" });
        existing.sourceSignatures.add(sourceSignature(manifest.sourceAgentId, candidate.parsed.messageId));
        existing.originalHashes.add(hashOriginal(candidate.parsed.body));
      } else {
        skipped += 1;
        receipts.push({ sourceMessageId: candidate.parsed.messageId, status: "write_failed", reason: receipt.reason });
      }
    }

    this.events.record({
      agentId: input.targetAgentId,
      sessionId,
      eventType: "gitmd_import_completed",
      payload: {
        importBatchId,
        sourceAgentId: manifest.sourceAgentId,
        sourceRepoPath,
        scanned: files.length,
        imported,
        skipped,
        referenced,
        duplicatePolicy
      }
    });

    return {
      ok: true,
      mode,
      duplicatePolicy,
      importBatchId,
      targetAgentId: input.targetAgentId,
      sourceAgentId: manifest.sourceAgentId,
      sourceRepoPath,
      scanned: files.length,
      imported,
      skipped,
      referenced,
      blocked,
      receipts
    };
  }

  private duplicatePolicy(value: unknown): GitMdDuplicatePolicy {
    return value === "force" || value === "import_as_reference" || value === "skip" ? value : "skip";
  }

  private positiveLimit(value: unknown, fallback: number): number {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
  }

  private resolveSourceRepoPath(value: string): string {
    const direct = resolve(value);
    if (existsSync(join(direct, "manifest.json"))) {
      return direct;
    }
    const nestedGitMd = join(direct, "gitmd");
    if (existsSync(join(nestedGitMd, "manifest.json"))) {
      return nestedGitMd;
    }
    return direct;
  }

  private readManifest(sourceRepoPath: string): { ok: true; sourceAgentId: string } | { ok: false; reason: string; sourceRepoPath: string } {
    const manifestPath = join(sourceRepoPath, "manifest.json");
    if (!existsSync(manifestPath)) {
      return { ok: false, reason: "gitmd_manifest_missing", sourceRepoPath };
    }
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as GitMdManifest;
      if (manifest.format !== "oms-gitmd-v1") {
        return { ok: false, reason: "gitmd_manifest_wrong_format", sourceRepoPath };
      }
      const sourceAgentId = manifest.owner?.agent_id ?? manifest.agent_id;
      if (!sourceAgentId || sourceAgentId.trim().length === 0) {
        return { ok: false, reason: "gitmd_manifest_agent_missing", sourceRepoPath };
      }
      return { ok: true, sourceAgentId: sourceAgentId.trim() };
    } catch {
      return { ok: false, reason: "gitmd_manifest_invalid", sourceRepoPath };
    }
  }

  private listRawMarkdownFiles(sourceRepoPath: string): string[] {
    const rawPath = join(sourceRepoPath, "raw");
    if (!existsSync(rawPath)) {
      return [];
    }
    return listFiles(rawPath)
      .filter((filePath) => filePath.endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
  }

  private existingIndex(agentId: string): { sourceSignatures: Set<string>; originalHashes: Set<string>; bySourceSignature: Map<string, string>; byOriginalHash: Map<string, string> } {
    const sourceSignatures = new Set<string>();
    const originalHashes = new Set<string>();
    const bySourceSignature = new Map<string, string>();
    const byOriginalHash = new Map<string, string>();
    for (const message of this.rawMessages.allForAgent(agentId, 1000000)) {
      originalHashes.add(message.originalHash);
      byOriginalHash.set(message.originalHash, message.messageId);
      const imported = importMetadata(message);
      if (imported?.sourceAgentId && imported.sourceMessageId) {
        const signature = sourceSignature(imported.sourceAgentId, imported.sourceMessageId);
        sourceSignatures.add(signature);
        bySourceSignature.set(signature, message.messageId);
      }
    }
    return { sourceSignatures, originalHashes, bySourceSignature, byOriginalHash };
  }

  private buildCandidate(
    filePath: string,
    manifestAgentId: string,
    existing: ReturnType<GitMdImporter["existingIndex"]>
  ): ImportCandidate {
    const parsed = this.parseRawMarkdown(filePath);
    if (!parsed) {
      return {
        parsed: { filePath, messageId: filePath, sessionId: "", role: "user", eventType: "created", body: "" },
        blockedReason: "gitmd_raw_parse_failed"
      };
    }
    if (parsed.agentId && parsed.agentId !== manifestAgentId) {
      return { parsed, blockedReason: "gitmd_raw_agent_mismatch" };
    }
    if (!parsed.body.trim()) {
      return { parsed, blockedReason: "gitmd_raw_body_empty" };
    }
    const signature = sourceSignature(manifestAgentId, parsed.messageId);
    const sourceDuplicate = existing.bySourceSignature.get(signature);
    if (sourceDuplicate) {
      return { parsed, duplicate: { messageId: sourceDuplicate, reason: "source_signature" } };
    }
    const bodyHash = hashOriginal(parsed.body);
    const hashDuplicate = existing.byOriginalHash.get(bodyHash);
    if (hashDuplicate) {
      return { parsed, duplicate: { messageId: hashDuplicate, reason: "original_hash" } };
    }
    return { parsed };
  }

  private parseRawMarkdown(filePath: string): ParsedGitMdRaw | undefined {
    const text = readFileSync(filePath, "utf8");
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
    if (!match) {
      return undefined;
    }
    const fields = parseFrontmatter(match[1]);
    const role = fields.role;
    if (role !== "user" && role !== "assistant") {
      return undefined;
    }
    const messageId = fields.message_id;
    const sessionId = fields.session_id;
    if (!messageId || !sessionId) {
      return undefined;
    }
    return {
      filePath,
      messageId,
      agentId: fields.agent_id,
      sessionId,
      turnId: fields.turn_id || undefined,
      role,
      eventType: fields.event_type || "created",
      timestamp: fields.timestamp || undefined,
      sourcePurpose: fields.source_purpose as RawWriteInput["sourcePurpose"],
      sourceAuthority: fields.source_authority as RawWriteInput["sourceAuthority"],
      evidencePolicyMask: fields.evidence_policy_mask as RawWriteInput["evidencePolicyMask"],
      originalHash: fields.original_hash || undefined,
      redacted: fields.redacted === "true",
      body: match[2].trimEnd()
    };
  }

  private toRawWriteInput(input: {
    targetAgentId: string;
    sessionId: string;
    turnIndex: number;
    importBatchId: string;
    sourceAgentId: string;
    sourceRepoPath: string;
    parsed: ParsedGitMdRaw;
  }): RawWriteInput {
    return {
      agentId: input.targetAgentId,
      sessionId: input.sessionId,
      turnId: `${input.sessionId}_${String(input.turnIndex).padStart(6, "0")}`,
      turnIndex: input.turnIndex,
      role: input.parsed.role,
      eventType: "imported",
      originalText: input.parsed.body,
      createdAt: validDateOrNow(input.parsed.timestamp),
      sourceScope: "import",
      sourcePurpose: "imported_timeline",
      sourceAuthority: "visible_transcript",
      retrievalAllowed: true,
      evidenceAllowed: true,
      evidencePolicyMask: "general_history",
      metadata: {
        import: this.provenancePayload(input)
      }
    };
  }

  private provenancePayload(input: {
    importBatchId: string;
    sourceAgentId: string;
    sourceRepoPath: string;
    parsed: ParsedGitMdRaw;
    duplicate?: DuplicateHit;
  }) {
    return {
      importBatchId: input.importBatchId,
      importedAt: new Date().toISOString(),
      sourceAgentId: input.sourceAgentId,
      sourceMessageId: input.parsed.messageId,
      sourceSessionId: input.parsed.sessionId,
      sourceTurnId: input.parsed.turnId,
      sourcePath: input.parsed.filePath,
      sourceRepoPath: input.sourceRepoPath,
      sourceOriginalHash: input.parsed.originalHash,
      sourceRedacted: input.parsed.redacted === true,
      duplicate: input.duplicate
    };
  }
}

function parseFrontmatter(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => {
        const [key, ...rest] = line.split(":");
        return [key.trim(), rest.join(":").trim()];
      })
      .filter(([key]) => key.length > 0)
  );
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const filePath = join(dir, entry);
    return statSync(filePath).isDirectory() ? listFiles(filePath) : [filePath];
  });
}

function sourceSignature(agentId: string, messageId: string): string {
  return `${agentId}\u0000${messageId}`;
}

function hashOriginal(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function importMetadata(message: RawMessage): { sourceAgentId?: string; sourceMessageId?: string } | undefined {
  const value = message.metadata.import;
  return value && typeof value === "object" ? (value as { sourceAgentId?: string; sourceMessageId?: string }) : undefined;
}

function validDateOrNow(value: string | undefined): string {
  if (value && !Number.isNaN(new Date(value).getTime())) {
    return value;
  }
  return new Date().toISOString();
}
