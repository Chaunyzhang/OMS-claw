import { describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";
import { runOpenClawRegistrationHarness } from "../../src/adapter/OpenClawRegistrationHarness.js";

describe("minimal runnable acceptance scenario", () => {
  it("stores material, excludes interference, expands evidence, traces, and exports timeline", async () => {
    const memoryRepo = mkdtempSync(join(tmpdir(), "oms-accept-"));
    const harness = runOpenClawRegistrationHarness({
      source: "test-host://oms",
      pluginConfig: {
        agentId: "accept-agent",
        dbPath: ":memory:",
        memoryRepoPath: memoryRepo,
        debug: true
      }
    });
    expect(harness.ok).toBe(true);
    expect(harness.contextEngineIds).toContain("oms");
    expect(harness.memoryCapabilityIds).toContain("oms");
    expect(harness.toolNames).toContain("oms_expand_evidence");
    expect(harness.eventNames).toContain("before_prompt_build");
    expect(harness.eventNames).toContain("agent_end");
    const oms = harness.orchestrator as OmsOrchestrator;

    oms.ingest({
      sessionId: "material-session",
      turnId: "material-turn-1",
      turnIndex: 1,
      messages: [
        {
          role: "user",
          content:
            "<!-- OMS_CAPTURE source_purpose=material_corpus case_id=demo-001 evidence_policy=material_evidence -->\n## Turn 1\n[raw D1:14] Melanie: I painted that lake sunrise last year."
        },
        { role: "assistant", content: "memory saved" }
      ]
    });
    oms.ingest({
      sessionId: "question-session",
      turnId: "question-turn-1",
      turnIndex: 1,
      messages: [
        {
          role: "user",
          content: "Before answering, call OMS memory tools.\nQuestion: When did Melanie paint a sunrise?"
        },
        { role: "assistant", content: "I do not have a record of that." }
      ]
    });

    await oms.afterTurn({ sessionId: "material-session", turnId: "material-turn-1" });
    const hits = oms.summarySearchTool({ query: "Melanie lake sunrise" });
    const packet = oms.expandEvidenceTool({
      summaryId: hits[0].summaryId,
      query: "When did Melanie paint a sunrise?",
      mode: "high",
      evidencePolicy: "material_evidence",
      caseId: "demo-001",
      sessionId: "fresh-question-session"
    });
    const trace = oms.traceTool({ packetId: packet.packetId });
    const exportResult = oms.gitExportTool();
    const status = oms.status();

    expect(status.build.commitSha).toBeTruthy();
    expect(status.openclaw.toolsRegistered).toBe(true);
    expect(packet.status).toBe("delivered");
    expect(packet.selectedAuthoritativeRawCount).toBeGreaterThan(0);
    expect(packet.rawExcerptHash).toMatch(/^sha256:/u);
    expect(packet.rawExcerpts[0].sourcePurpose).toBe("material_corpus");
    expect(packet.rawExcerpts[0].originalText).toContain("I painted that lake sunrise last year");
    expect(JSON.stringify(packet)).not.toContain("I do not have a record");
    expect(trace.path).toContain("evidence packet");
    expect(exportResult.ok).toBe(true);
    expect(existsSync(join(memoryRepo, "manifest.json"))).toBe(true);
    oms.connection.close();
    rmSync(memoryRepo, { recursive: true, force: true });
  });
});
