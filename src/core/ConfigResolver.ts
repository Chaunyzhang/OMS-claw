import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { OmsConfig, OmsMode } from "../types.js";

const DEFAULT_AGENT_ID = "oms-agent-default";

function pathSafeAgentId(agentId: string): string {
  return (
    agentId
      .normalize("NFKC")
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || DEFAULT_AGENT_ID
  );
}

function configuredOpenClawAgentCount(configPath: string): number | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      agents?: { list?: unknown[] };
    };
    return Array.isArray(config.agents?.list) ? config.agents.list.length : undefined;
  } catch {
    return undefined;
  }
}

function resolveAgentId(input: Record<string, unknown>): string {
  if (typeof input.agentId === "string" && input.agentId.trim().length > 0) {
    return input.agentId.trim();
  }
  const configPath = resolve(String(input.openclawConfigPath ?? join(homedir(), ".openclaw", "openclaw.json")));
  const agentCount = configuredOpenClawAgentCount(configPath);
  if (agentCount !== undefined && agentCount > 1 && input.allowDefaultAgentId !== true) {
    throw new Error("oms_agent_id_required_for_multi_agent_openclaw_config");
  }
  return DEFAULT_AGENT_ID;
}

function asMode(value: unknown): OmsMode {
  return value === "off" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "ultra"
    ? value
    : "auto";
}

function positiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

export function createDefaultConfig(input: Record<string, unknown> = {}): OmsConfig {
  const baseDir = resolve(String(input.baseDir ?? join(homedir(), ".openclaw", "oms")));
  mkdirSync(baseDir, { recursive: true });
  const agentId = resolveAgentId(input);
  const agentPathId = pathSafeAgentId(agentId);
  const dbPathInput = String(input.dbPath ?? join(baseDir, `${agentPathId}.sqlite`));
  const dbPath = dbPathInput === ":memory:" ? ":memory:" : resolve(dbPathInput);
  const memoryRepoPath = input.memoryRepoPath === undefined ? join(baseDir, agentPathId, "gitmd") : resolve(String(input.memoryRepoPath));

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
    summaryFreshRawMessages: nonNegativeInteger(input.summaryFreshRawMessages ?? input.freshTailCount, 64),
    summaryLeafChunkTokens: positiveInteger(input.summaryLeafChunkTokens ?? input.leafChunkTokens, 20000),
    summaryLeafRollupMinFanout: positiveInteger(input.summaryLeafRollupMinFanout ?? input.leafMinFanout, 8),
    summaryRollupMinFanout: positiveInteger(input.summaryRollupMinFanout ?? input.condensedMinFanout, 4),
    summaryIncrementalMaxDepth: nonNegativeInteger(input.summaryIncrementalMaxDepth ?? input.incrementalMaxDepth, 1),
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
