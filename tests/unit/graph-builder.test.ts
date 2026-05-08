import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/storage/EventStore.js";
import { GraphStore } from "../../src/storage/GraphStore.js";
import { RawMessageStore } from "../../src/storage/RawMessageStore.js";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";
import { RawWriter } from "../../src/ingest/RawWriter.js";
import { GraphBuilder } from "../../src/processing/GraphBuilder.js";

function createHarness() {
  const connection = new SQLiteConnection(":memory:");
  const rawMessages = new RawMessageStore(connection.db);
  const graph = new GraphStore(connection.db);
  const writer = new RawWriter(rawMessages, new EventStore(connection.db), "agent-1");
  const builder = new GraphBuilder(rawMessages, graph);
  return { connection, writer, builder, graph };
}

describe("graph builder", () => {
  it("skips assistant replies and caps user co-mention fanout", () => {
    const { connection, writer, builder, graph } = createHarness();
    const manyLabels = "Alpha. Bravo. Charlie. Delta. Echo. Foxtrot. Golf. Hotel. India. Juliet.";

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "assistant",
      sourcePurpose: "assistant_final_answer",
      originalText: manyLabels
    });
    writer.write({
      sessionId: "s1",
      turnIndex: 2,
      role: "user",
      sourcePurpose: "general_chat",
      originalText: manyLabels
    });

    const result = builder.buildForAgent("agent-1");

    expect(result.nodes).toBe(8);
    expect(result.edges).toBe(36);
    expect(graph.countNodes()).toBe(8);
    expect(graph.countEdges()).toBe(36);
    connection.close();
  });

  it("does not graph OMS prompt context as user memory", () => {
    const { connection, writer, builder, graph } = createHarness();

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "general_chat",
      originalText: "## OMS OpenClaw Memory\n[OMS memory policy]\nAlpha. Bravo. Charlie. Delta."
    });

    const result = builder.buildForAgent("agent-1");

    expect(result.nodes).toBe(0);
    expect(result.edges).toBe(0);
    expect(graph.countNodes()).toBe(0);
    expect(graph.countEdges()).toBe(0);
    connection.close();
  });
});
