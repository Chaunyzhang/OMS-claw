import { describe, expect, it } from "vitest";
import { EventStore } from "../../src/storage/EventStore.js";
import { GraphStore } from "../../src/storage/GraphStore.js";
import { RawMessageStore } from "../../src/storage/RawMessageStore.js";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";
import { RawWriter } from "../../src/ingest/RawWriter.js";
import { GraphBuilder } from "../../src/processing/GraphBuilder.js";
import { GraphCteLane } from "../../src/retrieval/lanes/GraphCteLane.js";

function createHarness() {
  const connection = new SQLiteConnection(":memory:");
  const rawMessages = new RawMessageStore(connection.db);
  const graph = new GraphStore(connection.db);
  const writer = new RawWriter(rawMessages, new EventStore(connection.db), "agent-1");
  const builder = new GraphBuilder(rawMessages, graph);
  return { connection, writer, builder, graph };
}

describe("graph builder", () => {
  it("skips assistant replies and stores aggregated user co-mentions", () => {
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
    expect(result.edges).toBe(12);
    expect(graph.countNodes()).toBe(8);
    expect(graph.countEdges()).toBe(12);
    expect(graph.countOccurrences()).toBe(12);
    connection.close();
  });

  it("does not duplicate graph entities, relations, or occurrences when rebuilt", () => {
    const { connection, writer, builder, graph } = createHarness();

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "general_chat",
      originalText: "OMS connects OpenClaw with Paperclip memory."
    });

    const first = builder.buildForAgent("agent-1");
    const second = builder.buildForAgent("agent-1");

    expect(first.nodes).toBeGreaterThan(0);
    expect(first.edges).toBeGreaterThan(0);
    expect(second.occurrencesInserted).toBe(0);
    expect(graph.countNodes()).toBeGreaterThan(0);
    expect(graph.countEdges()).toBe(graph.countOccurrences());
    connection.close();
  });

  it("extracts semantic relations before co-occurrence fallback", () => {
    const { connection, writer, builder, graph } = createHarness();

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "general_chat",
      originalText: "OMS uses OpenClaw."
    });

    builder.buildForAgent("agent-1");

    const relation = connection.db
      .prepare("SELECT relation_type AS relationType FROM graph_relations WHERE agent_id = ?")
      .get("agent-1") as { relationType: string };
    expect(graph.countNodes()).toBe(2);
    expect(graph.countEdges()).toBe(1);
    expect(relation.relationType).toBe("USES");
    connection.close();
  });

  it("aggregates the same entity pair across raw messages while preserving occurrences", () => {
    const { connection, writer, builder, graph } = createHarness();

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "general_chat",
      originalText: "OMS and OpenClaw."
    });
    writer.write({
      sessionId: "s1",
      turnIndex: 2,
      role: "user",
      sourcePurpose: "general_chat",
      originalText: "OpenClaw and OMS."
    });

    builder.buildForAgent("agent-1");

    expect(graph.countNodes()).toBe(2);
    expect(graph.countEdges()).toBe(1);
    expect(graph.countMentions()).toBe(4);
    expect(graph.countOccurrences()).toBe(2);
    connection.close();
  });

  it("paginates graph builds beyond the first raw slice", () => {
    const { connection, writer, builder, graph } = createHarness();

    for (let index = 1; index <= 3; index += 1) {
      writer.write({
        sessionId: "s1",
        turnIndex: index,
        role: "user",
        sourcePurpose: "general_chat",
        originalText: `Project${index} uses Tool${index}.`
      });
    }

    const result = builder.buildIncremental("agent-1", 2);

    expect(result.rawScanned).toBe(3);
    expect(graph.countNodes()).toBe(6);
    expect(graph.countEdges()).toBe(3);
    connection.close();
  });

  it("chunks material corpus text into multiple text units", () => {
    const { connection, writer, builder } = createHarness();

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "material_corpus",
      originalText: `OMS uses OpenClaw. ${"filler ".repeat(180)}Paperclip uses ChaunyOPC.`
    });

    builder.buildForAgent("agent-1");

    const row = connection.db
      .prepare("SELECT COUNT(DISTINCT text_unit_id) AS count FROM graph_entity_mentions WHERE agent_id = ?")
      .get("agent-1") as { count: number };
    expect(row.count).toBeGreaterThan(1);
    connection.close();
  });

  it("uses raw source timestamps for graph provenance", () => {
    const { connection, writer, builder } = createHarness();
    const createdAt = "2026-01-02T03:04:05.000Z";

    writer.write({
      sessionId: "s1",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "general_chat",
      createdAt,
      originalText: "OMS uses OpenClaw."
    });

    builder.buildForAgent("agent-1");

    const row = connection.db
      .prepare("SELECT first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt FROM graph_relations WHERE agent_id = ?")
      .get("agent-1") as { firstSeenAt: string; lastSeenAt: string };
    expect(row.firstSeenAt).toBe(createdAt);
    expect(row.lastSeenAt).toBe(createdAt);
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

  it("uses requested fanout to cap graph traversal neighbors", () => {
    const { connection, graph } = createHarness();
    const seed = graph.upsertEntity({ agentId: "agent-1", entityType: "entity", label: "Seed", confidence: 0.9 });

    for (const label of ["Alpha", "Bravo", "Charlie"]) {
      const neighbor = graph.upsertEntity({ agentId: "agent-1", entityType: "entity", label, confidence: 0.8 });
      const relation = graph.upsertRelation({
        agentId: "agent-1",
        fromEntityId: seed,
        toEntityId: neighbor,
        relationType: "CO_OCCURS_WITH",
        directionality: "undirected",
        confidence: 0.8
      });
      graph.insertRelationOccurrence({
        agentId: "agent-1",
        relationId: relation,
        rawId: `raw-${label.toLowerCase()}`,
        extractor: "test",
        extractorVersion: "test",
        ruleId: label,
        evidenceTextHash: `sha256:${label.toLowerCase()}`,
        confidence: 0.8
      });
    }

    const lane = new GraphCteLane(connection.db, graph);
    const result = lane.search({ agentId: "agent-1", query: "Seed", fanout: 1, limit: 10 });

    expect(result.status).toBe("ok");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].reason).toMatchObject({ traversalFanout: 1 });
    connection.close();
  });

  it("keeps seed discovery independent from traversal fanout and caps raw candidates", () => {
    const { connection, graph } = createHarness();

    for (let seedIndex = 1; seedIndex <= 12; seedIndex += 1) {
      const seed = graph.upsertEntity({
        agentId: "agent-1",
        entityType: "entity",
        label: `Seed ${seedIndex}`,
        confidence: 0.9
      });
      for (let mentionIndex = 1; mentionIndex <= 2; mentionIndex += 1) {
        graph.insertMention({
          agentId: "agent-1",
          entityId: seed,
          rawId: `raw-${seedIndex}-${mentionIndex}`,
          extractor: "test",
          extractorVersion: "test",
          startChar: mentionIndex,
          endChar: mentionIndex + 1,
          mentionText: `Seed ${seedIndex}`,
          confidence: 0.9
        });
      }
    }

    const lane = new GraphCteLane(connection.db, graph);
    const result = lane.search({ agentId: "agent-1", query: "Seed", fanout: 1, limit: 100 });
    const graphPath = result.candidates[0].graphPath as { seedNodeIds: string[] };

    expect(result.status).toBe("ok");
    expect(result.candidates).toHaveLength(20);
    expect(graphPath.seedNodeIds).toHaveLength(12);
    expect(result.candidates[0].reason).toMatchObject({ seedLimit: 12, traversalFanout: 1, rawCandidateLimit: 20 });
    connection.close();
  });
});
