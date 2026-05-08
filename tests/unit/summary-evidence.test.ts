import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";

describe("summary DAG and evidence expansion", () => {
  it("returns navigation hits that must expand to raw original text", async () => {
    const oms = new OmsOrchestrator(createDefaultConfig({ agentId: "agent", dbPath: ":memory:" }));
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

  it("does not create duplicate leaf summaries for the same raw turn", async () => {
    const oms = new OmsOrchestrator(
      createDefaultConfig({
        agentId: "summary-dedupe-agent",
        dbPath: ":memory:",
        graphEnabled: false
      })
    );

    oms.ingest({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      messages: [
        { role: "user", content: "Remember: OMS summaries should dedupe by source hash." },
        { role: "assistant", content: "Stored." }
      ]
    });

    const first = await oms.afterTurn({ sessionId: "s1", turnId: "t1" });
    const second = await oms.afterTurn({ sessionId: "s1", turnId: "t1" });

    expect(first.summarized).toBe(true);
    expect(second.summarized).toBe(true);
    expect(oms.summaries.count()).toBe(1);
    oms.connection.close();
  });
});
