import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitMdWriter } from "../../src/git/GitMdWriter.js";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";
import { RawMessageStore } from "../../src/storage/RawMessageStore.js";
import { EventStore } from "../../src/storage/EventStore.js";
import { RawWriter } from "../../src/ingest/RawWriter.js";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

describe("raw writer", () => {
  it("preserves original text and keeps normalized text separate", () => {
    const connection = new SQLiteConnection(":memory:");
    const store = new RawMessageStore(connection.db);
    const writer = new RawWriter(store, new EventStore(connection.db), "agent-1");

    const receipt = writer.write({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      role: "user",
      originalText: "  Hello,\n\nWorld!  "
    });

    const raw = store.byId(receipt.messageId);
    expect(receipt.ok).toBe(true);
    expect(raw?.originalText).toBe("  Hello,\n\nWorld!  ");
    expect(raw?.normalizedText).toBe("hello, world!");
    expect(raw?.originalHash).toMatch(/^sha256:/u);
    connection.close();
  });

  it("does not duplicate replayed event messages with stable turn indexes", () => {
    const connection = new SQLiteConnection(":memory:");
    const store = new RawMessageStore(connection.db);
    const writer = new RawWriter(store, new EventStore(connection.db), "agent-1");

    const first = writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      originalText: "Remember the Paperclip architecture note."
    });
    const replay = writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      originalText: "Remember the Paperclip architecture note."
    });

    expect(replay.ok).toBe(true);
    expect(replay.messageId).toBe(first.messageId);
    expect(store.count()).toBe(1);
    connection.close();
  });

  it("keeps a committed raw write successful when success event logging fails", () => {
    const connection = new SQLiteConnection(":memory:");
    const store = new RawMessageStore(connection.db);
    const events = {
      record() {
        throw new Error("event store down");
      }
    } as unknown as EventStore;
    const writer = new RawWriter(store, events, "agent-1");

    const receipt = writer.write({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      role: "user",
      originalText: "Raw write should stay successful."
    });

    expect(receipt.ok).toBe(true);
    expect(store.count()).toBe(1);
    connection.close();
  });

  it("mirrors raw writes to the local gitmd brainpack immediately and idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-raw-gitmd-"));
    const connection = new SQLiteConnection(":memory:");
    const store = new RawMessageStore(connection.db);
    const writer = new RawWriter(store, new EventStore(connection.db), "agent-1", new GitMdWriter(dir));

    try {
      const first = writer.write({
        sessionId: "s1",
        turnId: "t1",
        turnIndex: 1,
        role: "user",
        originalText: "Realtime GitMD mirror should write this raw once."
      });
      const replay = writer.write({
        sessionId: "s1",
        turnId: "t1",
        turnIndex: 1,
        role: "user",
        originalText: "Realtime GitMD mirror should write this raw once."
      });
      const markdownFiles = listFiles(join(dir, "raw")).filter((path) => path.endsWith(".md"));
      const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { agent_id: string };

      expect(first.ok).toBe(true);
      expect(replay.messageId).toBe(first.messageId);
      expect(markdownFiles).toHaveLength(1);
      expect(readFileSync(markdownFiles[0], "utf8")).toContain("Realtime GitMD mirror should write this raw once.");
      expect(manifest.agent_id).toBe("agent-1");
    } finally {
      connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
