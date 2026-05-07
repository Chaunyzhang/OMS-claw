import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";
import { runOpenClawRegistrationHarness } from "../../src/adapter/OpenClawRegistrationHarness.js";
import { localEmbedding } from "../../src/storage/EmbeddingStore.js";

function createOms(extra: Record<string, unknown> = {}) {
  return new OmsOrchestrator(createDefaultConfig({ agentId: `agent-${randomUUID()}`, dbPath: ":memory:", ...extra }));
}

async function seedMelanieMaterial(oms: OmsOrchestrator) {
  oms.ingest({
    sessionId: "material-session",
    turnId: "material-turn-1",
    turnIndex: 1,
    messages: [
      {
        role: "user",
        content:
          "<!-- OMS_CAPTURE source_purpose=material_corpus case_id=demo-001 evidence_policy=material_evidence -->\n[raw D1:14] Melanie: I painted that lake sunrise in 2022."
      },
      { role: "assistant", content: "Chunk stored." }
    ]
  });
  oms.ingest({
    sessionId: "question-session",
    turnId: "question-turn-1",
    turnIndex: 1,
    messages: [
      { role: "user", content: "Before answering, call OMS. Question: When did Melanie paint a sunrise? Answer: 2021." },
      { role: "assistant", content: "Melanie painted it in 2021." }
    ]
  });
  await oms.afterTurn({ sessionId: "material-session", turnId: "material-turn-1" });
}

describe("SQLite max retrieval decoupled architecture", () => {
  it("applies the max retrieval schema idempotently", () => {
    const connection = new SQLiteConnection(":memory:");
    connection.migrate();
    connection.migrate();
    const tables = connection.db
      .prepare("SELECT name FROM sqlite_schema WHERE type IN ('table','virtual table') ORDER BY name")
      .all()
      .map((row) => String((row as { name: string }).name));

    expect(tables).toContain("schema_migrations");
    expect(tables).toContain("feature_health");
    expect(tables).toContain("raw_trigram");
    expect(tables).toContain("embedding_chunks");
    expect(tables).toContain("graph_nodes");
    expect(tables).toContain("fusion_runs");
    expect(tables).toContain("evidence_packet_items");
    connection.close();
  });

  it("upgrades old local experimental schema without register-time column errors", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-old-schema-"));
    const dbPath = join(dir, "old.sqlite");
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations (version) VALUES (1);
      CREATE TABLE raw_messages (
        message_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'created',
        created_at TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        original_text TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        original_hash TEXT NOT NULL,
        visible_to_user INTEGER NOT NULL DEFAULT 1,
        interrupted INTEGER NOT NULL DEFAULT 0,
        source_scope TEXT NOT NULL DEFAULT 'agent',
        source_purpose TEXT NOT NULL DEFAULT 'general_chat',
        source_authority TEXT NOT NULL DEFAULT 'visible_transcript',
        retrieval_allowed INTEGER NOT NULL DEFAULT 1,
        evidence_policy_mask TEXT NOT NULL DEFAULT 'general_history',
        case_id TEXT,
        parent_message_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE retrieval_candidates (
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        candidate_kind TEXT NOT NULL,
        candidate_id_ref TEXT NOT NULL,
        score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE evidence_packets (
        packet_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL,
        selected_authoritative_raw_count INTEGER NOT NULL,
        selected_raw_count INTEGER NOT NULL,
        summary_derived_raw_count INTEGER NOT NULL,
        raw_message_ids_json TEXT NOT NULL,
        source_summary_ids_json TEXT NOT NULL,
        source_edge_ids_json TEXT NOT NULL,
        raw_excerpt_hash TEXT,
        raw_excerpt_preview_json TEXT NOT NULL DEFAULT '[]',
        authority_report_json TEXT NOT NULL DEFAULT '{}',
        delivery_report_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE embedding_chunks (
        chunk_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        raw_message_id TEXT NOT NULL,
        model TEXT NOT NULL
      );
    `);
    old.close();

    const connection = new SQLiteConnection(dbPath);
    const migrationColumns = connection.db
      .prepare("PRAGMA table_info(schema_migrations)")
      .all()
      .map((row) => String((row as { name: string }).name));
    const embeddingColumns = connection.db
      .prepare("PRAGMA table_info(embedding_chunks)")
      .all()
      .map((row) => String((row as { name: string }).name));
    const rawColumns = connection.db
      .prepare("PRAGMA table_info(raw_messages)")
      .all()
      .map((row) => String((row as { name: string }).name));
    const candidateColumns = connection.db
      .prepare("PRAGMA table_info(retrieval_candidates)")
      .all()
      .map((row) => String((row as { name: string }).name));
    const packetColumns = connection.db
      .prepare("PRAGMA table_info(evidence_packets)")
      .all()
      .map((row) => String((row as { name: string }).name));

    expect(migrationColumns).toEqual(expect.arrayContaining(["name", "applied_at", "checksum"]));
    expect(embeddingColumns).toContain("raw_id");
    expect(rawColumns).toEqual(expect.arrayContaining(["evidence_allowed", "observed_at", "turn_index"]));
    expect(candidateColumns).toEqual(expect.arrayContaining(["query_id", "lane", "raw_id_hint", "reason_json"]));
    expect(packetColumns).toEqual(expect.arrayContaining(["query_id", "fusion_run_id", "session_id", "metadata_json"]));
    expect(() => connection.migrate()).not.toThrow();
    connection.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fuses FTS, trigram, ANN, and summary candidates but delivers only raw evidence", async () => {
    const oms = createOms({ annEnabled: true, embeddingProvider: "local_hash", embeddingModel: "oms-local-hash-embedding-v2" });
    await seedMelanieMaterial(oms);

    const result = await oms.retrieveTool({
      query: "When did Melanie paint a sunrise?",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001",
      sessionId: "fresh-question-session"
    });

    expect(result.ok).toBe(true);
    expect(result.lanesUsed).toEqual(expect.arrayContaining(["fts_bm25", "trigram", "summary_dag", "ann_vector"]));
    expect(result.packet.status).toBe("delivered");
    expect(result.packet.rawExcerpts).toHaveLength(1);
    expect(result.packet.rawExcerpts[0].originalText).toContain("2022");
    expect(JSON.stringify(result.packet)).not.toContain("2021");
    expect(result.packet.sourceRoutes).toEqual(expect.arrayContaining(["fts_bm25"]));
    oms.connection.close();
  });

  it("keeps ANN optional and blocked without an embedding model", async () => {
    const oms = createOms();
    await seedMelanieMaterial(oms);

    const mainFlow = await oms.retrieveTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });
    expect(mainFlow.ok).toBe(true);
    expect(mainFlow.lanesUsed).not.toContain("ann_vector");
    expect(oms.status().features?.annVector).toBe("blocked");

    const annOnly = await oms.retrieveTool({
      query: "Melanie sunrise",
      mode: "high",
      requiredLane: "ann_vector",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });
    expect(annOnly.ok).toBe(false);
    expect(annOnly.lanesDegraded).toEqual(
      expect.arrayContaining([expect.objectContaining({ lane: "ann_vector", status: "blocked", error: "lane_disabled" })])
    );
    expect(annOnly.answerPolicy).toBe("must_not_answer_from_candidates");
    oms.connection.close();

    const enabledWithoutProvider = createOms({ annEnabled: true });
    await seedMelanieMaterial(enabledWithoutProvider);
    const disabledProvider = await enabledWithoutProvider.retrieveTool({
      query: "Melanie sunrise",
      mode: "high",
      requiredLane: "ann_vector",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });
    expect(disabledProvider.ok).toBe(false);
    expect(disabledProvider.lanesDegraded).toEqual(
      expect.arrayContaining([expect.objectContaining({ lane: "ann_vector", status: "blocked", error: "embedding_provider_disabled" })])
    );
    enabledWithoutProvider.connection.close();

    const enabledWithoutModel = createOms({ annEnabled: true, embeddingProvider: "openrouter" });
    await seedMelanieMaterial(enabledWithoutModel);
    const missingModel = await enabledWithoutModel.retrieveTool({
      query: "Melanie sunrise",
      mode: "high",
      requiredLane: "ann_vector",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });
    expect(missingModel.ok).toBe(false);
    expect(missingModel.lanesDegraded).toEqual(
      expect.arrayContaining([expect.objectContaining({ lane: "ann_vector", status: "blocked", error: "embedding_model_not_configured" })])
    );
    enabledWithoutModel.connection.close();
  });

  it("uses OpenRouter embeddings as an optional ANN/RAG lane without persisting the secret", async () => {
    const previousFetch = globalThis.fetch;
    const previousKey = process.env.OPENROUTER_API_KEY;
    const calls: Array<{ url: string; body: Record<string, unknown>; authorization?: string }> = [];
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url: String(url), body, authorization: headers?.Authorization });
      return {
        ok: true,
        json: async () => ({ data: [{ embedding: Array.from(localEmbedding(String(body.input ?? ""))) }] }),
        text: async () => ""
      } as Response;
    }) as typeof fetch;

    try {
      const oms = createOms({
        annEnabled: true,
        ragEnabled: true,
        embeddingProvider: "openrouter",
        embeddingModel: "baai/bge-m3"
      });
      await seedMelanieMaterial(oms);

      const result = await oms.retrieveTool({
        query: "When did Melanie paint a sunrise?",
        mode: "high",
        evidencePolicy: "material_evidence",
        caseId: "demo-001"
      });
      const agentConfig = oms.connection.db
        .prepare("SELECT config_json AS configJson FROM agents WHERE agent_id = ?")
        .get(oms.config.agentId) as { configJson: string };

      expect(result.ok).toBe(true);
      expect(result.lanesUsed).toContain("ann_vector");
      expect(result.packet.rawExcerpts[0].originalText).toContain("2022");
      expect(calls.some((call) => call.url.endsWith("/embeddings"))).toBe(true);
      expect(calls.every((call) => call.body.model === "baai/bge-m3")).toBe(true);
      expect(calls.every((call) => call.authorization === "Bearer test-openrouter-key")).toBe(true);
      expect(agentConfig.configJson).toContain("OPENROUTER_API_KEY");
      expect(agentConfig.configJson).not.toContain("test-openrouter-key");
      oms.connection.close();
    } finally {
      globalThis.fetch = previousFetch;
      if (previousKey === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = previousKey;
      }
    }
  });

  it("uses graph CTE as a required lane while still expanding to raw", async () => {
    const oms = createOms();
    await seedMelanieMaterial(oms);

    const result = await oms.retrieveTool({
      query: "Melanie lake sunrise",
      mode: "ultra",
      requiredLane: "graph_cte",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });

    expect(result.ok).toBe(true);
    expect(result.lanesUsed).toContain("graph_cte");
    expect(result.packet.status).toBe("delivered");
    expect(result.packet.rawExcerpts[0].sourcePurpose).toBe("material_corpus");
    oms.connection.close();
  });

  it("fails closed when graph paths do not resolve to authoritative raw", async () => {
    const oms = createOms();
    const nodeA = "gn_orphan_a";
    const nodeB = "gn_orphan_b";
    oms.connection.db
      .prepare(
        `INSERT INTO graph_nodes
          (node_id, agent_id, node_type, label, canonical_label, confidence, status, metadata_json)
         VALUES (?, ?, 'entity', 'Melanie', 'melanie', 0.9, 'active', '{}')`
      )
      .run(nodeA, oms.config.agentId);
    oms.connection.db
      .prepare(
        `INSERT INTO graph_nodes
          (node_id, agent_id, node_type, label, canonical_label, confidence, status, metadata_json)
         VALUES (?, ?, 'entity', 'sunrise', 'sunrise', 0.9, 'active', '{}')`
      )
      .run(nodeB, oms.config.agentId);
    oms.connection.db
      .prepare(
        `INSERT INTO graph_edges
          (edge_id, agent_id, from_node_id, to_node_id, relation, weight, confidence, source_raw_id, created_at, status, metadata_json)
         VALUES ('ge_orphan', ?, ?, ?, 'co_mentions', 1, 0.9, 'raw_missing', ?, 'active', '{}')`
      )
      .run(oms.config.agentId, nodeA, nodeB, new Date().toISOString());

    const result = await oms.retrieveTool({
      query: "Melanie sunrise",
      mode: "ultra",
      requiredLane: "graph_cte",
      evidencePolicy: "material_evidence"
    });

    expect(result.ok).toBe(false);
    expect(result.lanesUsed).toContain("graph_cte");
    expect(result.answerPolicy).toBe("must_not_answer_from_candidates");
    expect(result.packet.status).toBe("blocked");
    expect(result.packet.selectedAuthoritativeRawCount).toBe(0);
    oms.connection.close();
  });

  it("degrades trigram independently without blocking FTS-to-packet retrieval", async () => {
    const oms = createOms();
    await seedMelanieMaterial(oms);
    oms.connection.db.exec("DROP TABLE raw_trigram;");

    const result = await oms.retrieveTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });

    expect(result.ok).toBe(true);
    expect(result.lanesDegraded.some((lane) => lane.lane === "trigram")).toBe(true);
    expect(result.packet.status).toBe("delivered");
    oms.connection.close();
  });

  it("routes public FTS tool through packet authority gates", async () => {
    const oms = createOms();
    await seedMelanieMaterial(oms);

    const delivered = await oms.ftsSearchTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001",
      sessionId: "fresh-question-session"
    });
    expect(delivered.ok).toBe(true);
    expect(delivered.packet.status).toBe("delivered");
    expect(delivered.packet.rawExcerpts[0].originalText).toContain("2022");

    const sameSession = await oms.ftsSearchTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001",
      sessionId: "material-session"
    });
    expect(sameSession.ok).toBe(false);
    expect(sameSession.packet.status).toBe("blocked");
    expect(sameSession.packet.authorityReport.blockedReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "current_question_session" })])
    );

    const wrongCase = await oms.ftsSearchTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-002",
      sessionId: "fresh-question-session"
    });
    expect(wrongCase.ok).toBe(false);
    expect(wrongCase.packet.status).toBe("blocked");
    expect(wrongCase.packet.authorityReport.blockedReasons).toEqual(
      expect.arrayContaining([expect.objectContaining({ reason: "wrong_case_id" })])
    );
    oms.connection.close();
  });

  it("memory runtime search returns packet-backed snippets and readFile only reads packet items", async () => {
    const harness = runOpenClawRegistrationHarness({
      source: "test-host://oms",
      pluginConfig: { agentId: "runtime-agent", dbPath: ":memory:", debug: true }
    });
    const oms = harness.orchestrator as OmsOrchestrator;
    await seedMelanieMaterial(oms);

    const capability = harness.memoryCapabilities[0] as {
      runtime: {
        getMemorySearchManager: () => Promise<{ manager: unknown }>;
        resolveMemoryBackendConfig: () => Record<string, unknown>;
      };
      publicArtifacts: { listArtifacts: () => Array<{ kind: string; absolutePath: string }> };
    };
    const { manager } = await capability.runtime.getMemorySearchManager();
    const memory = manager as {
      search: (query: string, opts?: { maxResults?: number }) => Promise<Array<{ path: string; snippet: string }>>;
      readFile: (params: { path: string }) => Promise<{ text: string; disabled?: boolean; error?: string }>;
      status: () => Record<string, unknown>;
    };
    const results = await memory.search("Melanie sunrise", { maxResults: 5 });

    expect(results[0].path).toContain("oms/evidence/pkt_");
    expect(results[0].snippet).toContain("2022");
    const file = await memory.readFile({ path: results[0].path });
    expect(file.disabled).not.toBe(true);
    expect(file.text).toContain("2022");
    const bypass = await memory.readFile({ path: "oms/raw/raw_missing.md" });
    expect(bypass.disabled).toBe(true);
    const artifacts = capability.publicArtifacts.listArtifacts();
    expect(artifacts.every((artifact) => artifact.kind !== "oms-sqlite-ledger")).toBe(true);
    expect(artifacts.every((artifact) => artifact.absolutePath !== oms.config.dbPath)).toBe(true);
    expect(artifacts.every((artifact) => !artifact.absolutePath.endsWith(".sqlite"))).toBe(true);
    const runtimeStatus = memory.status();
    const backendConfig = capability.runtime.resolveMemoryBackendConfig();
    expect(runtimeStatus).not.toHaveProperty("dbPath");
    expect(runtimeStatus).not.toHaveProperty("workspaceDir");
    expect(JSON.stringify(runtimeStatus)).not.toContain(oms.config.dbPath);
    expect(JSON.stringify(runtimeStatus)).not.toContain("workspaceDir");
    expect(JSON.stringify(backendConfig)).not.toContain(oms.config.dbPath);
    expect(JSON.stringify(backendConfig)).not.toContain("dbPath");
    oms.connection.close();
  });

  it("redacts public status, timeline, debug, and raw-message trace surfaces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-public-surface-"));
    const dbPath = join(dir, "surface.sqlite");
    const oms = createOms({ dbPath, debug: true });
    await seedMelanieMaterial(oms);
    const packet = (await oms.retrieveTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    })).packet;
    const rawId = packet.rawMessageIds[0];
    const status = oms.status();
    const timeline = oms.timeline(10);
    const trace = oms.traceTool({ messageId: rawId });
    const debug = oms.debugRawTool({ limit: 10 });

    expect(JSON.stringify(status)).not.toContain(dbPath);
    expect(status).not.toHaveProperty("dbPath");
    expect(status).not.toHaveProperty("memoryRepoPath");
    expect(JSON.stringify(timeline)).not.toContain("painted that lake sunrise in 2022");
    expect(JSON.stringify(trace)).not.toContain("painted that lake sunrise in 2022");
    expect(JSON.stringify(debug)).not.toContain("painted that lake sunrise in 2022");
    expect(timeline[0].originalText).toBe("[redacted: use delivered evidence packet]");
    expect(timeline[0].normalizedText).toBe("[redacted]");
    expect(trace.message.originalText).toBe("[redacted: use delivered evidence packet]");
    expect(trace.message.normalizedText).toBe("[redacted]");
    expect(debug[0].originalText).toBe("[redacted: use delivered evidence packet]");
    expect(debug[0].normalizedText).toBe("[redacted]");
    oms.connection.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
