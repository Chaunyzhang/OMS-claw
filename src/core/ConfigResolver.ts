import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OmsConfig, OmsMode } from "../types.js";

function asMode(value: unknown): OmsMode {
  return value === "off" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "ultra"
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

  const embeddingProvider =
    input.embeddingProvider === "local_hash" || input.embeddingProvider === "openrouter" ? input.embeddingProvider : "disabled";
  const embeddingDimensions =
    input.embeddingDimensions === undefined || Number(input.embeddingDimensions) <= 0 ? undefined : Number(input.embeddingDimensions);
  const embeddingTimeoutMs = Number(input.embeddingTimeoutMs ?? 30000);

  return {
    agentId,
    mode: asMode(input.mode),
    dbPath,
    memoryRepoPath,
    recentCompleteTurns: Number(input.recentCompleteTurns ?? 5),
    contextThreshold: Number(input.contextThreshold ?? 0.75),
    summaryEnabled: input.summaryEnabled !== false,
    ftsEnabled: input.ftsEnabled !== false,
    trigramEnabled: input.trigramEnabled !== false,
    ragEnabled: input.ragEnabled === true,
    annEnabled: input.annEnabled === true,
    embeddingProvider,
    embeddingModel: input.embeddingModel === undefined ? undefined : String(input.embeddingModel),
    embeddingApiKeyEnv: String(input.embeddingApiKeyEnv ?? "OPENROUTER_API_KEY"),
    embeddingBaseUrl: String(input.embeddingBaseUrl ?? "https://openrouter.ai/api/v1"),
    embeddingDimensions,
    embeddingTimeoutMs: Number.isFinite(embeddingTimeoutMs) && embeddingTimeoutMs > 0 ? embeddingTimeoutMs : 30000,
    graphEnabled: input.graphEnabled !== false,
    sqlFusionEnabled: input.sqlFusionEnabled !== false,
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
