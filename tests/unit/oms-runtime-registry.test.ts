import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { OmsRuntimeRegistry } from "../../src/core/OmsRuntimeRegistry.js";
import { runOpenClawRegistrationHarness } from "../../src/adapter/OpenClawRegistrationHarness.js";

describe("OMS runtime registry", () => {
  it("does not require a global agentId when OpenClaw has multiple agents", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oms-runtime-registry-"));
    const openclawConfigPath = join(baseDir, "openclaw.json");
    writeFileSync(openclawConfigPath, JSON.stringify({ agents: { list: [{ id: "main" }, { id: "work" }] } }), "utf8");
    let runtime: OmsRuntimeRegistry | undefined;

    try {
      const harness = runOpenClawRegistrationHarness({
        source: "test-host://oms",
        pluginConfig: {
          baseDir,
          openclawConfigPath
        }
      });
      runtime = harness.orchestrator as OmsRuntimeRegistry;
      const main = runtime.forContext({ sessionKey: "agent:main:main" });
      const work = runtime.forContext({ sessionKey: "agent:work:main" });
      const workFromBatch = runtime.forContext([{ sessionKey: "agent:work:main", messages: [] }]);

      expect(harness.ok).toBe(true);
      expect(harness.errors).toEqual([]);
      expect(harness.toolNames).toContain("oms_debug_raw");
      expect(main.config.agentId).toBe("main");
      expect(work.config.agentId).toBe("work");
      expect(workFromBatch.config.agentId).toBe("work");
      expect(main.config.dbPath).not.toBe(work.config.dbPath);
      expect(basename(main.config.dbPath)).toMatch(/^main-[a-f0-9]{10}\.sqlite$/u);
      expect(basename(work.config.dbPath)).toMatch(/^work-[a-f0-9]{10}\.sqlite$/u);
    } finally {
      for (const orchestrator of runtime?.activeOrchestrators() ?? []) {
        orchestrator.connection.close();
      }
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
