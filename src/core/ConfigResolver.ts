import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OmsConfig, OmsMode } from "../types.js";

function asMode(value: unknown): OmsMode {
  return value === "off" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : "auto";
}

export function createDefaultConfig(input: Record<string, unknown> = {}): OmsConfig {
  const baseDir = resolve(String(input.baseDir ?? join(homedir(), ".openclaw", "oms")));
  mkdirSync(baseDir, { recursive: true });
  const agentId = String(input.agentId ?? "oms-agent-default");
  const dbPathInput = String(input.dbPath ?? join(baseDir, `${agentId}.sqlite`));
  const dbPath = dbPathInput === ":memory:" ? ":memory:" : resolve(dbPathInput);
  const memoryRepoPath = input.memoryRepoPath === undefined ? join(baseDir, "memory-repo") : resolve(String(input.memoryRepoPath));

  return {
    agentId,
    mode: asMode(input.mode),
    dbPath,
    memoryRepoPath,
    recentCompleteTurns: Number(input.recentCompleteTurns ?? 5),
    contextThreshold: Number(input.contextThreshold ?? 0.75),
    summaryEnabled: input.summaryEnabled !== false,
    ftsEnabled: input.ftsEnabled !== false,
    ragEnabled: input.ragEnabled === true,
    graphEnabled: input.graphEnabled === true,
    gitExportEnabled: input.gitExportEnabled !== false,
    redactionEnabled: input.redactionEnabled !== false,
    debug: input.debug === true,
    manualRetrievalDisabled: input.manualRetrievalDisabled === true,
    manualRetrievalPath: input.manualRetrievalPath as OmsConfig["manualRetrievalPath"]
  };
}

export class ConfigResolver {
  static resolve(pluginConfig: Record<string, unknown> = {}): OmsConfig {
    return createDefaultConfig(pluginConfig);
  }
}
