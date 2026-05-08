import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";

describe("summary DAG and evidence expansion", () => {
  it("returns navigation hits that must expand to raw original text", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "agent",
        dbPath: ":memory:",
        summaryFreshRawMessages: 0,
        summaryLeafChunkTokens: 1
      })
    );
    const ingest = oms.ingest({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      messages: [
        {
          role: "user",
          content:
            "<!-- OMS_CAPTURE source_purpose=material_corpus case_id=demo-001 evidence_policy=material_evidence -->\n[raw] Melanie painted the lake sunrise in 2022."
        },
        { role: "assistant", content: "Stored successfully." }
      ]
    });

    expect(ingest.ok).toBe(true);
    await oms.afterTurn({ sessionId: "s1", turnId: "t1" });
    const hits = oms.summarySearchTool({ query: "Melanie sunrise" });
    expect(hits[0].hitKind).toBe("summary_navigation");
    expect(hits[0].summaryTextIsNotEvidence).toBe(true);
    const packet = oms.expandEvidenceTool({
      summaryId: hits[0].summaryId,
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001"
    });
    expect(packet.status).toBe("delivered");
    expect(packet.rawExcerpts[0].originalText).toContain("Melanie painted");
    expect(packet.rawExcerpts.every((excerpt) => excerpt.sourcePurpose === "material_corpus")).toBe(true);
    oms.connection.close();
  });

  it("does not create duplicate chunk leaf summaries for already summarized raw", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "summary-dedupe-agent",
        dbPath: ":memory:",
        graphEnabled: false,
        summaryFreshRawMessages: 0,
        summaryLeafChunkTokens: 1
      })
    );

    oms.ingest({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      role: "user",
      content: "Remember: OMS summaries should not summarize the same raw twice."
    });

    const first = await oms.afterTurn({ sessionId: "s1", turnId: "t1" });
    const second = await oms.afterTurn({ sessionId: "s1", turnId: "t1" });

    expect(first.summarized).toBe(true);
    expect(second.summarized).toBe(false);
    expect(oms.summaries.count()).toBe(1);
    oms.connection.close();
  });

  it("uses the host turn id when afterTurn ingests hook messages", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "after-turn-agent",
        dbPath: ":memory:",
        summaryFreshRawMessages: 0,
        summaryLeafChunkTokens: 1
      })
    );

    const result = await oms.afterTurn({
      sessionId: "hook-session",
      turnId: "host-turn-1",
      messages: [
        { role: "user", content: "Remember: host turn id must be preserved." },
        { role: "assistant", content: "I will remember it." }
      ]
    });

    expect(result.ok).toBe(true);
    expect(result.receipts.every((receipt) => receipt.ok && receipt.turnId === "host-turn-1")).toBe(true);
    expect(oms.queue.recentFailures()).toHaveLength(0);
    expect(oms.summaries.count()).toBe(1);
    oms.connection.close();
  });

  it("keeps fresh raw messages unsummarized until they age past the tail", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "fresh-tail-agent",
        dbPath: ":memory:",
        graphEnabled: false,
        summaryFreshRawMessages: 2,
        summaryLeafChunkTokens: 4
      })
    );

    for (let index = 1; index <= 3; index += 1) {
      oms.ingest({
        sessionId: "s1",
        turnId: `t${index}`,
        turnIndex: index,
        messages: [{ role: "user", content: `Durable topic ${index} with enough words.` }]
      });
      await oms.afterTurn({ sessionId: "s1", turnId: `t${index}` });
    }

    expect(oms.summaries.count()).toBe(1);
    const summary = oms.summarySearchTool({ query: "Durable topic 1" })[0];
    const packet = oms.expandEvidenceTool({ summaryId: summary.summaryId, evidencePolicy: "general_history", mode: "medium" });

    expect(packet.rawMessageIds).toHaveLength(1);
    expect(packet.rawExcerpts[0].originalText).toContain("Durable topic 1");
    oms.connection.close();
  });

  it("rolls up active leaf summaries and keeps raw evidence reachable", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "rollup-agent",
        dbPath: ":memory:",
        graphEnabled: false,
        summaryFreshRawMessages: 0,
        summaryLeafChunkTokens: 4,
        summaryLeafRollupMinFanout: 2,
        summaryIncrementalMaxDepth: 1
      })
    );

    for (let index = 1; index <= 2; index += 1) {
      oms.ingest({
        sessionId: "s1",
        turnId: `t${index}`,
        turnIndex: index,
        messages: [{ role: "user", content: `Rollup source ${index} mentions lake sunrise.` }]
      });
      await oms.afterTurn({ sessionId: "s1", turnId: `t${index}` });
    }

    const activeRollups = oms.summaries.activeForSessionLevel({ agentId: oms.config.agentId, sessionId: "s1", level: 1 });
    const activeLeaves = oms.summaries.activeForSessionLevel({ agentId: oms.config.agentId, sessionId: "s1", level: 0 });
    const packet = oms.expandEvidenceTool({
      summaryId: activeRollups[0].summaryId,
      evidencePolicy: "general_history",
      mode: "medium"
    });

    expect(activeRollups).toHaveLength(1);
    expect(activeLeaves).toHaveLength(0);
    expect(packet.status).toBe("delivered");
    expect(packet.rawMessageIds).toHaveLength(2);
    oms.connection.close();
  });

  it("ranks summary navigation with the same material evidence policy used by expansion", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "summary-policy-agent",
        dbPath: ":memory:",
        summaryFreshRawMessages: 0,
        summaryLeafChunkTokens: 1
      })
    );

    oms.rawWriter.write({
      sessionId: "valid",
      turnId: "valid-turn",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "material_corpus",
      sourceAuthority: "authoritative_material",
      evidencePolicyMask: "material_evidence",
      originalText: "ranked sunrise valid evidence"
    });
    oms.summaryDag.buildLeafForSession({ agentId: oms.config.agentId, sessionId: "valid", force: true });

    oms.rawWriter.write({
      sessionId: "invalid",
      turnId: "invalid-turn",
      turnIndex: 1,
      role: "user",
      sourcePurpose: "material_corpus",
      sourceAuthority: "original_user_supplied_material",
      evidencePolicyMask: "general_history",
      originalText: "ranked sunrise extra invalid evidence"
    });
    oms.summaryDag.buildLeafForSession({ agentId: oms.config.agentId, sessionId: "invalid", force: true });

    const hits = oms.summarySearchTool({ query: "ranked sunrise extra", limit: 2 });
    const packet = oms.expandEvidenceTool({
      summaryId: hits[0].summaryId,
      mode: "high",
      evidencePolicy: "material_evidence"
    });

    expect(packet.status).toBe("delivered");
    expect(packet.rawExcerpts[0].originalText).toContain("valid evidence");
    oms.connection.close();
  });
});
