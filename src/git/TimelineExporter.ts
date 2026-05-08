import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "../storage/EventStore.js";
import type { RawMessage } from "../types.js";
import { MarkdownRenderer } from "./MarkdownRenderer.js";
import { Redactor } from "./Redactor.js";
import { GitMdWriter, ensureGitMdManifest } from "./GitMdWriter.js";

export class TimelineExporter {
  private readonly redactor = new Redactor();
  private readonly renderer = new MarkdownRenderer();

  constructor(private readonly events: EventStore) {}

  export(input: { agentId: string; memoryRepoPath: string; messages: RawMessage[]; force?: boolean }) {
    const manifest = ensureGitMdManifest(input);
    if (!manifest.ok) {
      this.events.record({
        agentId: input.agentId,
        sessionId: input.messages[0]?.sessionId ?? "none",
        eventType: "export_failed",
        payload: { reason: manifest.reason, memoryRepoPath: input.memoryRepoPath, foundAgentId: manifest.foundAgentId }
      });
      return { ok: false, reason: manifest.reason, exported: [] as string[] };
    }
    mkdirSync(join(input.memoryRepoPath, "timeline"), { recursive: true });
    mkdirSync(join(input.memoryRepoPath, "exports"), { recursive: true });

    const gitMdWriter = new GitMdWriter(input.memoryRepoPath);
    const exported: string[] = [];
    for (const message of input.messages) {
      const rawMirror = gitMdWriter.writeRaw({ agentId: input.agentId, message, force: input.force });
      if (!rawMirror.ok) {
        this.events.record({
          agentId: input.agentId,
          sessionId: message.sessionId,
          messageId: message.messageId,
          eventType: "export_failed",
          payload: { reason: rawMirror.reason, foundAgentId: "foundAgentId" in rawMirror ? rawMirror.foundAgentId : undefined }
        });
        return { ok: false, reason: rawMirror.reason, exported };
      }
      if (rawMirror.path) {
        exported.push(rawMirror.path);
      }

      const redaction = this.redactor.redact(message.originalText);
      if (!redaction.ok && !input.force) {
        this.events.record({
          agentId: input.agentId,
          sessionId: message.sessionId,
          messageId: message.messageId,
          eventType: "export_failed",
          payload: { reason: redaction.blockedReason, findings: redaction.findings }
        });
        return { ok: false, reason: redaction.blockedReason, exported };
      }
      const date = new Date(message.createdAt);
      const year = String(date.getUTCFullYear());
      const month = String(date.getUTCMonth() + 1).padStart(2, "0");
      const day = String(date.getUTCDate()).padStart(2, "0");
      const dir = join(input.memoryRepoPath, "timeline", year, month);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${day}.md`);
      appendFileSync(file, `${this.renderer.render(message, redaction.redactedText, redaction.redacted)}\n`, "utf8");
      exported.push(file);
    }
    appendFileSync(
      join(input.memoryRepoPath, "exports", "export-log.jsonl"),
      `${JSON.stringify({ created_at: new Date().toISOString(), count: exported.length, files: exported })}\n`,
      "utf8"
    );
    this.events.record({
      agentId: input.agentId,
      sessionId: input.messages[0]?.sessionId ?? "none",
      eventType: "export_completed",
      payload: { count: exported.length }
    });
    return { ok: true, exported };
  }
}
