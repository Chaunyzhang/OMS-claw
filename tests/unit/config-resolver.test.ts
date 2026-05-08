import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";

describe("config resolver", () => {
  it("defaults sqlite and gitmd paths to the OMS agent identity", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oms-agent-paths-"));

    try {
      const config = createDefaultConfig({ baseDir, openclawConfigPath: join(baseDir, "missing-openclaw.json"), agentId: "agent/main" });

      expect(config.agentId).toBe("agent/main");
      expect(config.dbPath).toBe(resolve(join(baseDir, "agent-main.sqlite")));
      expect(config.memoryRepoPath).toBe(resolve(join(baseDir, "agent-main", "gitmd")));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("keeps explicit memoryRepoPath overrides", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oms-agent-paths-"));
    const explicitRepo = join(baseDir, "custom-repo");

    try {
      const config = createDefaultConfig({
        baseDir,
        openclawConfigPath: join(baseDir, "missing-openclaw.json"),
        agentId: "agent-a",
        memoryRepoPath: explicitRepo
      });

      expect(config.memoryRepoPath).toBe(resolve(explicitRepo));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("defaults summary compaction to lossless-style chunk thresholds", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oms-summary-config-"));

    try {
      const config = createDefaultConfig({
        baseDir,
        openclawConfigPath: join(baseDir, "missing-openclaw.json"),
        agentId: "agent-a"
      });

      expect(config.summaryFreshRawMessages).toBe(64);
      expect(config.summaryLeafChunkTokens).toBe(20000);
      expect(config.summaryLeafRollupMinFanout).toBe(8);
      expect(config.summaryRollupMinFanout).toBe(4);
      expect(config.summaryIncrementalMaxDepth).toBe(1);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a multi-agent OpenClaw config lacks explicit OMS agentId", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oms-agent-paths-"));
    const openclawConfigPath = join(baseDir, "openclaw.json");
    writeFileSync(
      openclawConfigPath,
      JSON.stringify({ agents: { list: [{ id: "main" }, { id: "work" }] } }),
      "utf8"
    );

    try {
      expect(() => createDefaultConfig({ baseDir, openclawConfigPath })).toThrow(
        "oms_agent_id_required_for_multi_agent_openclaw_config"
      );
      expect(createDefaultConfig({ baseDir, openclawConfigPath, agentId: "main" }).agentId).toBe("main");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
