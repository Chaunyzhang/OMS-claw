import { describe, expect, it } from "vitest";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";
import { RuntimeAttestation } from "../../src/core/RuntimeAttestation.js";

describe("compaction and runtime attestation", () => {
  it("does not compact before summary source edges exist", () => {
    const oms = new OmsOrchestrator(createDefaultConfig({ agentId: "agent", dbPath: ":memory:" }));
    oms.ingest({
      sessionId: "s1",
      turnId: "t1",
      turnIndex: 1,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" }
      ]
    });

    const plan = oms.compact({ sessionId: "s1", turnId: "t1" });
    expect(plan.ok).toBe(false);
    expect(plan.reason).toBe("compaction_preconditions_failed");
    expect(plan.blockers).toContain("summary_source_edges_missing");
    oms.connection.close();
  });

  it("reports schema and context engine attestation", () => {
    const build = new RuntimeAttestation("dist/index.js").current();
    expect(build.schemaVersion).toBe("v1");
    expect(build.contextEngineId).toBe("oms");
    expect(build.toolSchemaHash).toMatch(/^sha256:/u);
  });
});
