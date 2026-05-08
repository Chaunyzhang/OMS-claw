import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Redactor } from "../../src/git/Redactor.js";
import { TimelineExporter } from "../../src/git/TimelineExporter.js";
import { EventStore } from "../../src/storage/EventStore.js";
import { RawMessageStore } from "../../src/storage/RawMessageStore.js";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";
import { RawWriter } from "../../src/ingest/RawWriter.js";

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

describe("gitmd brainpack export", () => {
  function createRaw(agentId: string) {
    const connection = new SQLiteConnection(":memory:");
    const rawMessages = new RawMessageStore(connection.db);
    const events = new EventStore(connection.db);
    const writer = new RawWriter(rawMessages, events, agentId);
    const receipt = writer.write({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      role: "user",
      originalText: `Brainpack note for ${agentId}.`
    });
    const raw = rawMessages.byId(receipt.messageId);
    if (!raw) {
      throw new Error("raw_write_not_confirmed");
    }
    return { connection, events, raw };
  }

  it("creates a gitmd owner manifest for the exporting agent", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-gitmd-"));
    const repoPath = join(dir, "agent-a", "gitmd");
    const { connection, events, raw } = createRaw("agent-a");

    try {
      const result = new TimelineExporter(events).export({ agentId: "agent-a", memoryRepoPath: repoPath, messages: [raw] });
      const manifest = JSON.parse(readFileSync(join(repoPath, "manifest.json"), "utf8")) as {
        format: string;
        brainpack: string;
        agent_id: string;
        owner: { agent_id: string };
      };

      expect(result.ok).toBe(true);
      expect(manifest.format).toBe("oms-gitmd-v1");
      expect(manifest.brainpack).toBe("gitmd");
      expect(manifest.agent_id).toBe("agent-a");
      expect(manifest.owner.agent_id).toBe("agent-a");
      expect(existsSync(join(repoPath, "timeline"))).toBe(true);
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to export one agent into another agent's gitmd brainpack", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-gitmd-"));
    const repoPath = join(dir, "agent-a", "gitmd");
    const { connection, events, raw } = createRaw("agent-b");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(
      join(repoPath, "manifest.json"),
      `${JSON.stringify({ format: "oms-gitmd-v1", agent_id: "agent-a", owner: { kind: "oms-agent", agent_id: "agent-a" } })}\n`,
      "utf8"
    );

    try {
      const result = new TimelineExporter(events).export({ agentId: "agent-b", memoryRepoPath: repoPath, messages: [raw] });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("memory_repo_agent_mismatch");
      expect(existsSync(join(repoPath, "timeline"))).toBe(false);
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
