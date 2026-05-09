import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pinyin } from "pinyin-pro";
import type { OmsConfig, OmsMode } from "../types.js";

const DEFAULT_AGENT_ID = "oms-agent-default";
const AGENT_PATH_ID_MAX_LENGTH = 80;

interface OpenClawAgentConfig {
  id?: unknown;
  name?: unknown;
}

interface OpenClawConfigShape {
  agents?: {
    list?: OpenClawAgentConfig[];
  };
}

function transliterateHan(input: string): string {
  return input.replace(/\p{Script=Han}+/gu, (segment) =>
    (pinyin(segment, { toneType: "none", type: "array" }) as string[]).join("-")
  );
}

function slugifyAgentPathPart(value: string, fallback: string): string {
  return (
    transliterateHan(value.normalize("NFKC").trim())
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, AGENT_PATH_ID_MAX_LENGTH) || fallback
  );
}

function hashAgentIdentity(agentId: string): string {
  return createHash("sha256").update(agentId.normalize("NFKC"), "utf8").digest("hex").slice(0, 10);
}

export function pathSafeAgentId(agentId: string, agentUid?: string): string {
  const normalizedAgentId = agentId.normalize("NFKC").trim() || DEFAULT_AGENT_ID;
  if (normalizedAgentId === DEFAULT_AGENT_ID && !agentUid) {
    return DEFAULT_AGENT_ID;
  }

  const label = slugifyAgentPathPart(normalizedAgentId, "agent");
  const suffix = agentUid ? slugifyAgentPathPart(agentUid, hashAgentIdentity(normalizedAgentId)) : hashAgentIdentity(normalizedAgentId);
  const baseMaxLength = Math.max(1, AGENT_PATH_ID_MAX_LENGTH - suffix.length - 1);
  const base = label.slice(0, baseMaxLength).replace(/[-_.]+$/gu, "") || "agent";
  return `${base}-${suffix}`;
}

function readOpenClawAgents(configPath: string): OpenClawAgentConfig[] | undefined {
  if (!existsSync(configPath)) {
    return undefined;
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as OpenClawConfigShape;
    return Array.isArray(config.agents?.list) ? config.agents.list : undefined;
  } catch {
    return undefined;
  }
}

function resolveAgentId(input: Record<string, unknown>): string {
  if (typeof input.agentId === "string" && input.agentId.trim().length > 0) {
    return input.agentId.trim();
  }
  const configPath = resolve(String(input.openclawConfigPath ?? join(homedir(), ".openclaw", "openclaw.json")));
  const agents = readOpenClawAgents(configPath);
  if (agents?.length === 1) {
    const agentId = agents[0]?.id ?? agents[0]?.name;
    if (typeof agentId === "string" && agentId.trim().length > 0) {
      return agentId.trim();
    }
  }
  if (agents !== undefined && agents.length > 1 && input.allowDefaultAgentId !== true) {
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
  const agentUid = typeof input.agentUid === "string" && input.agentUid.trim().length > 0 ? input.agentUid.trim() : undefined;
  const agentPathId = pathSafeAgentId(agentId, agentUid);
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
    agentUid,
    agentPathId,
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
