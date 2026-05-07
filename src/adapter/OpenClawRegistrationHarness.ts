import entry from "./PluginRegistration.js";
import type { OpenClawPluginApi, OpenClawToolDefinition } from "./OpenClawTypes.js";

export interface RegistrationHarnessResult {
  ok: boolean;
  source: string;
  toolNames: string[];
  contextEngineIds: string[];
  memoryCapabilityIds: string[];
  memoryCapabilities: Array<Record<string, unknown>>;
  bootstrapStatus?: unknown;
  errors: string[];
  orchestrator?: unknown;
}

export function runOpenClawRegistrationHarness(input: {
  source: string;
  pluginConfig?: Record<string, unknown>;
}): RegistrationHarnessResult {
  const toolNames: string[] = [];
  const contextFactories = new Map<string, () => Record<string, unknown>>();
  const memoryCapabilityIds: string[] = [];
  const memoryCapabilities: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  let orchestrator: unknown;

  const api: OpenClawPluginApi = {
    id: "oms",
    name: "OMS OpenClaw Memory",
    source: input.source,
    rootDir: process.cwd(),
    pluginConfig: input.pluginConfig ?? {},
    logger: {},
    registerTool(tool: OpenClawToolDefinition) {
      toolNames.push(tool.name);
    },
    registerContextEngine(id: string, factory: () => Record<string, unknown>) {
      contextFactories.set(id, factory);
    },
    registerMemoryCapability(capability: Record<string, unknown>) {
      memoryCapabilityIds.push(String(capability.id ?? "unknown"));
      memoryCapabilities.push(capability);
    }
  };

  try {
    orchestrator = entry.register(api);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  let bootstrapStatus: unknown;
  try {
    const factory = contextFactories.get("oms");
    const engine = factory?.();
    bootstrapStatus = typeof engine?.bootstrap === "function" ? engine.bootstrap() : undefined;
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const requiredTools = [
    "oms_status",
    "oms_search",
    "oms_retrieve",
    "oms_timeline",
    "oms_summary_search",
    "oms_expand_evidence",
    "oms_fts_search",
    "oms_trace",
    "oms_why",
    "oms_git_export"
  ];
  const ok =
    errors.length === 0 &&
    contextFactories.has("oms") &&
    memoryCapabilityIds.includes("oms") &&
    requiredTools.every((name) => toolNames.includes(name));

  return {
    ok,
    source: input.source,
    toolNames,
    contextEngineIds: Array.from(contextFactories.keys()),
    memoryCapabilityIds,
    memoryCapabilities,
    bootstrapStatus,
    errors,
    orchestrator
  };
}
