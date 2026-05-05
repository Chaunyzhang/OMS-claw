import { describe, expect, it } from "vitest";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";
import { RawMessageStore } from "../../src/storage/RawMessageStore.js";
import { EventStore } from "../../src/storage/EventStore.js";
import { RawWriter } from "../../src/ingest/RawWriter.js";

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
});
