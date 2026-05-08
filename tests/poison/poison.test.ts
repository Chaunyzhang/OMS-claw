import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";

function createOms(extra: Record<string, unknown> = {}) {
  return new OmsOrchestrator(
    createDefaultConfig({
      agentId: `agent-${crypto.randomUUID()}`,
      dbPath: ":memory:",
      summaryFreshRawMessages: 0,
      summaryLeafChunkTokens: 1,
      ...extra
    })
  );
}

describe("poison tests", () => {
  it("answers material questions from material raw, not old assistant answers", async () => {
    const oms = createOms();
    oms.ingest({
      sessionId: "material",
      turnId: "mt1",
      turnIndex: 1,
      messages: [
        {
          role: "user",
          content:
            "<!-- OMS_CAPTURE source_purpose=material_corpus case_id=demo-001 evidence_policy=material_evidence -->\n[raw D1:14] Melanie: I painted that lake sunrise last year."
        },
        { role: "assistant", content: "Chunk stored." }
      ]
    });
    oms.ingest({
      sessionId: "question-old",
      turnId: "qt1",
      turnIndex: 1,
      messages: [
        { role: "user", content: "Before answering, search OMS. Question: When did Melanie paint a sunrise?" },
        { role: "assistant", content: "I do not have a record of that." }
      ]
    });
    await oms.afterTurn({ sessionId: "material", turnId: "mt1" });
    const packet = oms.expandEvidenceTool({
      query: "Melanie sunrise",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });

    expect(packet.status).toBe("delivered");
    expect(packet.rawExcerpts).toHaveLength(1);
    expect(packet.rawExcerpts[0].originalText).toContain("lake sunrise");
    expect(packet.rawExcerpts[0].sourcePurpose).toBe("material_corpus");
    oms.connection.close();
  });

  it("blocks a verified summary trace when authority is wrong", async () => {
    const oms = createOms();
    oms.ingest({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      messages: [
        { role: "user", content: "General chat says Melanie painted it in 2021." },
        { role: "assistant", content: "Okay." }
      ]
    });
    await oms.afterTurn({ sessionId: "s1", turnId: "t1" });
    const hit = oms.summarySearchTool({ query: "Melanie painted" })[0];
    const packet = oms.expandEvidenceTool({ summaryId: hit.summaryId, mode: "high", evidencePolicy: "material_evidence" });
    expect(packet.status).toBe("blocked");
    expect(packet.reason).toBe("no_authoritative_raw_found");
    expect(packet.authorityReport.blockedReasons.some((item) => item.reason === "wrong_source_purpose")).toBe(true);
    oms.connection.close();
  });

  it("does not use formal questions as material evidence even when they contain the answer", () => {
    const oms = createOms();
    oms.ingest({
      sessionId: "formal",
      turnId: "ft1",
      turnIndex: 1,
      role: "user",
      content: "Before answering, call OMS memory tools. Question: When? The answer is 2022."
    });
    const packet = oms.expandEvidenceTool({ query: "2022", mode: "high", evidencePolicy: "material_evidence" });
    expect(packet.status).toBe("blocked");
    expect(packet.authorityReport.authoritativeRawCount).toBe(0);
    oms.connection.close();
  });

  it("keeps transcript truncated receipts out of evidence", async () => {
    const oms = createOms();
    oms.ingest({
      sessionId: "receipt",
      turnId: "rt1",
      turnIndex: 1,
      role: "assistant",
      content: "transcript truncated"
    });
    const result = await oms.ftsSearchTool({ query: "transcript truncated", evidencePolicy: "general_history" });
    expect(result.ok).toBe(false);
    expect(result.candidateCount).toBe(0);
    oms.connection.close();
  });

  it("keeps detected secrets out of retrieval, evidence, summaries, and prompt context", async () => {
    const oms = createOms();
    const ingest = oms.ingest({
      sessionId: "secret-session",
      turnId: "secret-turn",
      turnIndex: 1,
      role: "user",
      content: "password: hunter2 token=aaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(ingest.ok).toBe(true);
    expect(ingest.receipts).toHaveLength(0);
    expect(oms.status().counts.rawMessages).toBe(0);

    const fts = await oms.ftsSearchTool({ query: "hunter2", evidencePolicy: "general_history" });
    expect(fts.ok).toBe(false);
    expect(fts.candidateCount).toBe(0);

    await oms.afterTurn({ sessionId: "secret-session", turnId: "secret-turn" });
    expect(oms.summaries.count()).toBe(0);
    expect(JSON.stringify(oms.summarySearchTool({ query: "hunter2" }))).not.toContain("hunter2");
    expect(oms.assemble({ sessionId: "secret-session" }).systemPromptAddition).not.toContain("hunter2");
    oms.connection.close();
  });

  it("blocks high mode when associative candidates cannot expand to raw", () => {
    const oms = createOms();
    const packet = oms.expandEvidenceTool({ query: "associative only memory", mode: "high", evidencePolicy: "material_evidence" });
    expect(packet.status).toBe("blocked");
    expect(packet.reason).toBe("no_authoritative_raw_found");
    oms.connection.close();
  });

  it("prefers the latest correction in raw FTS results", async () => {
    const oms = createOms();
    oms.ingest({
      sessionId: "version",
      turnId: "v1",
      turnIndex: 1,
      role: "user",
      content: "Project codename is amber."
    });
    oms.ingest({
      sessionId: "version",
      turnId: "v2",
      turnIndex: 2,
      role: "user",
      content: "Correction: Project codename is cobalt."
    });
    const result = await oms.ftsSearchTool({ query: "Project codename", evidencePolicy: "general_history" });
    expect(result.packet?.status).toBe("delivered");
    expect(result.packet?.rawExcerpts[0].originalText).toContain("cobalt");
    oms.connection.close();
  });

  it("does not auto-retrieve when OMS mode is off", () => {
    const oms = createOms({ mode: "off" });
    const result = oms.ingest({ sessionId: "s1", role: "user", content: "hello" });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("retrieval_mode_disabled");
    expect(oms.status().counts.rawMessages).toBe(0);
    oms.connection.close();
  });

  it("blocks git export when redaction scan fails", () => {
    const memoryRepo = mkdtempSync(join(tmpdir(), "oms-memory-"));
    const oms = createOms({ memoryRepoPath: memoryRepo });
    oms.rawWriter.write({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      role: "user",
      originalText: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"
    });
    const result = oms.gitExportTool();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("redaction_scan_failed");
    oms.connection.close();
    rmSync(memoryRepo, { recursive: true, force: true });
  });

  it("blocks compaction after a write failure event", async () => {
    const oms = createOms();
    oms.ingest({
      sessionId: "compact",
      turnId: "ct1",
      turnIndex: 1,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" }
      ]
    });
    await oms.afterTurn({ sessionId: "compact", turnId: "ct1" });
    oms.events.record({ agentId: oms.config.agentId, sessionId: "compact", eventType: "write_failed" });
    const plan = oms.compact({ sessionId: "compact", turnId: "ct1" });
    expect(plan.ok).toBe(false);
    expect(plan.blockers).toContain("pending_write_failure");
    oms.connection.close();
  });
});
