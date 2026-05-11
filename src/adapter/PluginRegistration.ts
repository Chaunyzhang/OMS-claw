import { basename, dirname } from "node:path";
import { Logger } from "../core/Logger.js";
import { OmsOrchestrator } from "../core/OmsOrchestrator.js";
import { OmsRuntimeRegistry } from "../core/OmsRuntimeRegistry.js";
import { OMS_MEMORY_REFLEX_PROMPT } from "../context/RecallPolicyPrompt.js";
import { isProactiveRecallQuery, isTimelineRecallQuery } from "../retrieval/RecallIntent.js";
import { controlPanelContract } from "../ui/ControlPanelContract.js";
import { DebugLogPresenter } from "../ui/DebugLogPresenter.js";
import { graphStatusSnapshot } from "../ui/GraphStatusPresenter.js";
import { asToolResponse, jsonSchema } from "./OpenClawDiplomat.js";
import type { OpenClawPluginApi, OpenClawToolDefinition } from "./OpenClawTypes.js";
import type { EvidencePacket } from "../types.js";

function tool(name: string, description: string, parameters: Record<string, unknown>, execute: OpenClawToolDefinition["execute"]): OpenClawToolDefinition {
  return { name, description, parameters, execute };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function sessionIdFrom(event: Record<string, unknown>, ctx: Record<string, unknown>): string {
  return (
    optionalString(ctx.sessionKey, ctx.sessionId, event.sessionKey, event.sessionId, ctx.conversationId, event.conversationId) ??
    "default-session"
  );
}

function availableToolsFrom(event: Record<string, unknown>, ctx: Record<string, unknown>): Set<string> | string[] | undefined {
  const availableTools = ctx.availableTools ?? event.availableTools;
  if (availableTools instanceof Set || Array.isArray(availableTools)) {
    return availableTools as Set<string> | string[];
  }
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function textFromMessagePart(part: unknown): string {
  if (typeof part === "string") {
    return part;
  }
  const record = asRecord(part);
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  return "";
}

function messageText(message: unknown): string {
  const record = asRecord(message);
  const content = record.content ?? record.text ?? record.message;
  if (Array.isArray(content)) {
    return content.map(textFromMessagePart).filter(Boolean).join("\n").trim();
  }
  return textFromMessagePart(content).trim();
}

function latestUserMessageText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message.role === "user") {
      const text = messageText(message);
      if (text.length > 0) {
        return text;
      }
    }
  }
  return undefined;
}

function formatPreloadedEvidencePacket(input: { agentId: string; query: string; packet: EvidencePacket }): string {
  const lines = [
    "## OMS Preloaded Memory Evidence",
    "OMS already retrieved this delivered raw evidence packet before the model response. Treat it as your own traceable memory evidence.",
    `agentId: ${input.agentId}`,
    `query: ${truncate(input.query, 180)}`,
    `packetId: ${input.packet.packetId}`,
    `sourceRoutes: ${(input.packet.sourceRoutes ?? []).join(", ") || "unknown"}`,
    "Use only these raw excerpts for prior-conversation claims unless you call OMS again and receive another delivered packet."
  ];
  for (const excerpt of input.packet.rawExcerpts.slice(0, 8)) {
    const turn = Number.isFinite(excerpt.turnIndex) ? excerpt.turnIndex : "?";
    lines.push(
      `- seq ${excerpt.sequence} turn ${turn} ${excerpt.role} (${excerpt.sourcePurpose}): ${truncate(excerpt.originalText.replace(/\s+/gu, " ").trim(), 700)}`
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function buildPreloadedMemoryEvidence(orchestrator: OmsOrchestrator, input: { query?: string; sessionId: string }): Promise<string> {
  const query = input.query?.trim();
  if (!query || !isProactiveRecallQuery(query)) {
    return "";
  }
  const result = await orchestrator.retrieveTool({
    query,
    evidencePolicy: "general_history",
    mode: "high",
    sessionId: input.sessionId,
    limit: isTimelineRecallQuery(query) ? 6 : 8
  });
  if (result.ok && result.packet?.status === "delivered") {
    return formatPreloadedEvidencePacket({ agentId: orchestrator.config.agentId, query, packet: result.packet });
  }
  return [
    "## OMS Preloaded Memory Evidence",
    "OMS proactively checked memory for this prior-conversation query, but no delivered raw evidence packet was found.",
    `agentId: ${orchestrator.config.agentId}`,
    `query: ${truncate(query, 180)}`,
    `reason: ${result.reason ?? result.packet?.reason ?? "no_authoritative_raw_evidence"}`,
    ""
  ].join("\n");
}

function registerRuntimeTool(
  api: OpenClawPluginApi,
  runtime: OmsRuntimeRegistry,
  name: string,
  build: (orchestrator: OmsOrchestrator) => OpenClawToolDefinition
): void {
  api.registerTool?.((ctx) => {
    const definition = build(runtime.forContext(ctx));
    return { label: definition.name, ...definition };
  }, { names: [name], name });
}

const evidencePolicyDescription =
  "Policy selector. Use general_history for ordinary prior conversation and timeline recall. Use assistant_history only when the user asks what the assistant previously said or promised. Use material_evidence only for OMS_CAPTURE/material_corpus/case-pack evidence, usually with caseId. Use diagnostic_history only for debugging prior OMS failures.";

const OMS_RECALL_TOOL_NAMES = ["oms_summary_search", "oms_search", "oms_retrieve", "oms_expand_evidence", "oms_fts_search"] as const;

const retrievalToolParameters = jsonSchema(
  {
    query: { type: "string" },
    mode: { type: "string", enum: ["low", "medium", "high", "xhigh", "ultra"], default: "high" },
    evidencePolicy: {
      type: "string",
      enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"],
      description: evidencePolicyDescription
    },
    caseId: { type: "string", description: "Only use with material_evidence for OMS_CAPTURE/material_corpus case packs." },
    sessionId: { type: "string" },
    requiredLane: { type: "string", enum: ["fts_bm25", "trigram", "summary_dag", "ann_vector", "graph_cte", "timeline"] },
    limit: { type: "number", default: 20 }
  },
  ["query"]
);

function registerTools(api: OpenClawPluginApi, runtime: OmsRuntimeRegistry): void {
  const tools: Array<{ name: string; build: (orchestrator: OmsOrchestrator) => OpenClawToolDefinition }> = [
    {
      name: "oms_status",
      build: (orchestrator) =>
        tool("oms_status", "Return OMS runtime attestation, registration state, counts, and health.", jsonSchema({}), () =>
          asToolResponse(orchestrator.status())
        )
    },
    {
      name: "oms_search",
      build: (orchestrator) =>
        tool(
          "oms_search",
          "Run decoupled OMS retrieval lanes, SQL fusion, and raw-only evidence packet construction.",
          retrievalToolParameters,
          async (_id, params) => asToolResponse(await orchestrator.retrieveTool(params))
        )
    },
    {
      name: "oms_retrieve",
      build: (orchestrator) =>
        tool(
          "oms_retrieve",
          "Alias for oms_search. Returns candidates plus raw-only packet; never answers from candidates.",
          retrievalToolParameters,
          async (_id, params) => asToolResponse(await orchestrator.retrieveTool(params))
        )
    },
    {
      name: "oms_timeline",
      build: (orchestrator) =>
        tool(
          "oms_timeline",
          "Return recent raw visible user/assistant timeline records.",
          jsonSchema({ limit: { type: "number", default: 100 } }),
          (_id, params) => asToolResponse(orchestrator.timeline(Number(params.limit ?? 100)))
        )
    },
    {
      name: "oms_summary_search",
      build: (orchestrator) =>
        tool(
          "oms_summary_search",
          "Search summary DAG navigation hits. Returned summaries are not evidence and must be expanded.",
          jsonSchema({ query: { type: "string" }, limit: { type: "number", default: 10 } }, ["query"]),
          (_id, params) => asToolResponse(orchestrator.summarySearchTool(params))
        )
    },
    {
      name: "oms_expand_evidence",
      build: (orchestrator) =>
        tool(
          "oms_expand_evidence",
          "Expand a summary/raw/query candidate into an authoritative raw evidence packet.",
          jsonSchema({
            summaryId: { type: "string" },
            rawMessageId: { type: "string" },
            query: { type: "string" },
            mode: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
            evidencePolicy: {
              type: "string",
              enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"],
              description: evidencePolicyDescription
            },
            caseId: { type: "string", description: "Only use with material_evidence for OMS_CAPTURE/material_corpus case packs." },
            windowTurns: { type: "number" },
            maxRawMessages: { type: "number" },
            sessionId: { type: "string" }
          }),
          (_id, params) => asToolResponse(orchestrator.expandEvidenceTool(params))
        )
    },
    {
      name: "oms_fts_search",
      build: (orchestrator) =>
        tool(
          "oms_fts_search",
          "FTS BM25 lane retrieval through the raw-only evidence packet path. Candidates are not evidence.",
          jsonSchema({
            query: { type: "string" },
            mode: { type: "string", enum: ["low", "medium", "high", "xhigh", "ultra"], default: "medium" },
            evidencePolicy: {
              type: "string",
              enum: ["general_history", "assistant_history", "material_evidence", "diagnostic_history"],
              description: evidencePolicyDescription
            },
            caseId: { type: "string", description: "Only use with material_evidence for OMS_CAPTURE/material_corpus case packs." },
            sessionId: { type: "string" },
            limit: { type: "number" }
          }, ["query"]),
          async (_id, params) => asToolResponse(await orchestrator.ftsSearchTool(params))
        )
    },
    {
      name: "oms_trace",
      build: (orchestrator) =>
        tool(
          "oms_trace",
          "Trace query/run/summary/source-edge/raw/evidence delivery lineage.",
          jsonSchema({ summaryId: { type: "string" }, packetId: { type: "string" }, messageId: { type: "string" } }),
          (_id, params) => asToolResponse(orchestrator.traceTool(params))
        )
    },
    {
      name: "oms_debug_lanes",
      build: (orchestrator) =>
        tool(
          "oms_debug_lanes",
          "Inspect lane candidates and degradation for a query. Candidate text is not evidence.",
          jsonSchema({ query: { type: "string" }, mode: { type: "string" }, caseId: { type: "string" } }, ["query"]),
          async (_id, params) => asToolResponse(await orchestrator.whyTool(params))
        )
    },
    {
      name: "oms_why",
      build: (orchestrator) =>
        tool(
          "oms_why",
          "Explain why a query matched or failed, including blocked reasons and enabled modules.",
          jsonSchema({ query: { type: "string" }, mode: { type: "string" }, caseId: { type: "string" } }, ["query"]),
          async (_id, params) => asToolResponse(await orchestrator.whyTool(params))
        )
    },
    {
      name: "oms_debug_raw",
      build: (orchestrator) =>
        tool(
          "oms_debug_raw",
          "Debug-only raw table inspection. Returns disabled unless OMS debug mode is enabled.",
          jsonSchema({ limit: { type: "number", default: 100 } }),
          (_id, params) => asToolResponse(orchestrator.debugRawTool(params))
        )
    },
    {
      name: "oms_inspect_graph",
      build: (orchestrator) =>
        tool(
          "oms_inspect_graph",
          "Return graph-health snapshot data for local OMS inspection UIs.",
          jsonSchema({}),
          () => asToolResponse(graphStatusSnapshot(orchestrator))
        )
    },
    {
      name: "oms_inspect_logs",
      build: (orchestrator) =>
        tool(
          "oms_inspect_logs",
          "Return recent OMS logs and events for local inspection UIs.",
          jsonSchema({}),
          () => asToolResponse(new DebugLogPresenter(orchestrator.events, orchestrator.logger).present())
        )
    },
    {
      name: "oms_git_export",
      build: (orchestrator) =>
        tool(
          "oms_git_export",
          "Export redacted raw timeline Markdown to the configured memory repo.",
          jsonSchema({ limit: { type: "number" }, force: { type: "boolean" } }),
          (_id, params) => asToolResponse(orchestrator.gitExportTool(params))
        )
    },
    {
      name: "oms_git_import",
      build: (orchestrator) =>
        tool(
          "oms_git_import",
          "Import another agent's GitMD brainpack into the current agent with provenance. Preview by default.",
          jsonSchema(
            {
              sourceRepoPath: { type: "string" },
              mode: { type: "string", enum: ["preview", "import"], default: "preview" },
              duplicatePolicy: { type: "string", enum: ["skip", "force", "import_as_reference"], default: "skip" },
              limit: { type: "number", default: 10000 }
            },
            ["sourceRepoPath"]
          ),
          (_id, params) => asToolResponse(orchestrator.gitImportTool(params))
        )
    }
  ];

  for (const definition of tools) {
    registerRuntimeTool(api, runtime, definition.name, definition.build);
  }
  runtime.markRegistered({ toolsRegistered: true });
}

function registerRuntimeHooks(api: OpenClawPluginApi, runtime: OmsRuntimeRegistry, logger: Logger): void {
  if (!api.on) {
    return;
  }

  api.on(
    "before_prompt_build",
    async (eventInput, ctxInput) => {
      const event = asRecord(eventInput);
      const ctx = asRecord(ctxInput);
      try {
        const orchestrator = runtime.forContext({ event, ctx });
        const assembled = orchestrator.assemble({
          sessionId: sessionIdFrom(event, ctx),
          messages: Array.isArray(event.messages) ? event.messages : [],
          availableTools: availableToolsFrom(event, ctx)
        });
        const preloadedEvidence = await buildPreloadedMemoryEvidence(orchestrator, {
          query: Array.isArray(event.messages) ? latestUserMessageText(event.messages) : undefined,
          sessionId: sessionIdFrom(event, ctx)
        });
        const systemPromptAddition = [assembled.systemPromptAddition, preloadedEvidence].filter((section) => section.trim()).join("\n");
        if (!systemPromptAddition.trim()) {
          return;
        }
        return {
          prependSystemContext: systemPromptAddition,
          prependContext: systemPromptAddition
        };
      } catch (error) {
        logger.warn("oms before_prompt_build hook failed", {
          reason: error instanceof Error ? error.message : String(error)
        });
        return;
      }
    },
    { timeoutMs: 5000 }
  );

  api.on(
    "agent_end",
    async (eventInput, ctxInput) => {
      const event = asRecord(eventInput);
      const ctx = asRecord(ctxInput);
      if (!Array.isArray(event.messages) || event.messages.length === 0) {
        return;
      }
      try {
        const orchestrator = runtime.forContext({ event, ctx });
        await orchestrator.afterTurn({
          sessionId: sessionIdFrom(event, ctx),
          turnId: optionalString(event.turnId, ctx.turnId),
          messages: event.messages
        });
      } catch (error) {
        logger.warn("oms agent_end ingest hook failed", {
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    },
    { timeoutMs: 10000 }
  );
}

function hasAvailableTool(availableTools: unknown, name: string): boolean {
  if (!availableTools) {
    return false;
  }
  if (availableTools instanceof Set) {
    return availableTools.has(name);
  }
  if (Array.isArray(availableTools)) {
    return availableTools.includes(name);
  }
  if (typeof availableTools === "object" && typeof (availableTools as { has?: unknown }).has === "function") {
    return Boolean((availableTools as { has: (toolName: string) => boolean }).has(name));
  }
  return false;
}

export function buildOmsPromptSection(params: { availableTools?: unknown; citationsMode?: string } = {}): string[] {
  const hasOmsTools = OMS_RECALL_TOOL_NAMES.some((name) => hasAvailableTool(params.availableTools, name));
  const lines = [
    "## OMS Memory Recall",
    "OMS is your system-level long-term memory for prior visible conversation. Treat it as part of your own memory, not as an optional external plugin.",
    OMS_MEMORY_REFLEX_PROMPT,
    "Before answering, decide whether the current task may depend on prior conversation facts, dates, corrections, commitments, preferences, project decisions, or formal memory tests.",
    "Use oms_search as the first recall path for ordinary memory questions and continuity-sensitive work; it may route through timeline, summaries, FTS, vectors, or graph and return raw evidence.",
    "Evidence policy: use general_history for ordinary prior conversation, including first/last messages and formal memory tests over chat history. Use material_evidence only for OMS_CAPTURE/material_corpus/case-pack evidence and include caseId when known. Use assistant_history only for what the assistant previously said or promised. Use diagnostic_history only for debugging prior OMS failures.",
    "Do not use material_evidence for ordinary chat just because the user says formal test, benchmark, or first messages. When expanding known messageIds or summaryIds from normal chat, pass evidencePolicy=general_history even in high/ultra mode.",
    "If an ## OMS Preloaded Memory Evidence block is present, it is already a delivered raw evidence packet and may be used directly as memory evidence.",
    "Answer only when oms_search or oms_expand_evidence returns a delivered raw evidence packet. Candidate lanes, summaries, embeddings, graph labels, and snippets are not evidence."
  ];
  if (!hasOmsTools) {
    lines.push(
      "If OMS tool names are not visible in this session's tool list, say the OMS tools are unavailable in this session instead of claiming the OMS plugin is not installed or that no memory exists."
    );
  }
  if (params.citationsMode === "off") {
    lines.push("Citations are disabled: do not mention internal paths unless the user explicitly asks.");
  } else {
    lines.push("Mention evidence succinctly when it helps verification, but do not expose raw internal details unnecessarily.");
  }
  lines.push("");
  return lines;
}

function createOmsContextEngine(runtime: OmsRuntimeRegistry) {
  return {
    info: {
      id: "oms",
      name: "OMS OpenClaw Context Engine",
      version: runtime.forContext().build().packageVersion,
      ownsCompaction: true
    },
    bootstrap: (input: Record<string, unknown> = {}) => runtime.forContext(input).status(),
    ingest: (payload: unknown) => runtime.forContext(payload).ingest(payload),
    ingestBatch: (payloads: unknown[] | unknown) => runtime.forContext(payloads).ingestBatch(payloads),
    assemble: (input: { sessionId?: string; sessionKey?: string; messages?: unknown[]; availableTools?: Set<string> | string[] } = {}) =>
      runtime.forContext(input).assemble({
        sessionId: input.sessionId,
        messages: input.messages,
        availableTools: input.availableTools
      }),
    compact: (input: { sessionId?: string; sessionKey?: string; turnId?: string } = {}) =>
      runtime.forContext(input).compact({ sessionId: input.sessionId, turnId: input.turnId }),
    afterTurn: (input: { sessionId?: string; sessionKey?: string; turnId?: string; messages?: unknown[]; prePromptMessageCount?: number } = {}) =>
      runtime.forContext(input).afterTurn({
        sessionId: input.sessionId,
        turnId: input.turnId,
        messages: input.messages,
        prePromptMessageCount: input.prePromptMessageCount
      }),
    prepareSubagentSpawn: (input: Record<string, unknown> = {}) => runtime.forContext(input).prepareSubagentSpawn(input),
    onSubagentEnded: (input: Record<string, unknown> = {}) => runtime.forContext(input).onSubagentEnded(input),
    dispose: () => {}
  };
}

function createOmsMemoryRuntime(runtime: OmsRuntimeRegistry) {
  const packetAgents = new Map<string, string>();
  const manager = {
    async search(
      query: string,
      opts: { maxResults?: number; minScore?: number; sessionId?: string; sessionKey?: string; agentId?: string } = {}
    ) {
      const orchestrator = runtime.forContext(opts);
      const result = await orchestrator.retrieveTool({
        query,
        evidencePolicy: "general_history",
        mode: "medium",
        requiredLane: "fts_bm25",
        sessionId: opts.sessionId,
        limit: opts.maxResults ?? 10
      });
      if (!result.ok || result.packet?.status !== "delivered") {
        return [];
      }
      if (result.packet.packetId) {
        packetAgents.set(result.packet.packetId, orchestrator.config.agentId);
      }
      const excerpts = result.packet.rawExcerpts;
      return excerpts.map((excerpt, index) => ({
        source: "memory",
        path: `oms/evidence/${result.packet?.packetId}/${excerpt.messageId}.md`,
        startLine: 1,
        endLine: 1,
        score: Math.max(0.01, 1 - index / Math.max(1, excerpts.length + 1)),
        snippet: excerpt.originalText
      }));
    },
    async readFile(params: { relPath?: string; path?: string; sessionId?: string; sessionKey?: string; agentId?: string }) {
      const lookup = String(params.relPath ?? params.path ?? "");
      const packetId = lookup.match(/pkt_[A-Za-z0-9-]+/)?.[0];
      const rawId = lookup.match(/raw_[A-Za-z0-9-]+/)?.[0];
      const orchestrator = runtime.forContext(packetId && packetAgents.has(packetId) ? { agentId: packetAgents.get(packetId) } : params);
      if (!packetId || !rawId) {
        return {
          path: lookup,
          text: "",
          disabled: true,
          error: "OMS evidence packet id and raw message id are required"
        };
      }
      const item = orchestrator.connection.db
        .prepare("SELECT excerpt_text AS text FROM evidence_packet_items WHERE packet_id = ? AND raw_id = ?")
        .get(packetId, rawId) as { text: string } | undefined;
      if (!item) {
        return {
          path: lookup,
          text: "",
          disabled: true,
          error: "OMS evidence packet item not found"
        };
      }
      return {
        path: lookup,
        text: item.text
      };
    },
    status() {
      const orchestrator = runtime.forContext();
      return {
        backend: "builtin",
        provider: "oms",
        model: "sqlite-fts5+trigram+sqlite-canonical-vectors+graph-cte+sql-rrf",
        sources: ["memory"],
        files: orchestrator.rawMessages.count(),
        chunks: orchestrator.rawMessages.count(),
        dirty: false,
        custom: {
          oms: {
            agentId: orchestrator.config.agentId,
            rawMessages: orchestrator.rawMessages.count(),
            summaries: orchestrator.summaries.count()
          }
        }
      };
    },
    async sync() {},
    async probeEmbeddingAvailability() {
      const orchestrator = runtime.forContext();
      const status = orchestrator.embeddingProvider.status();
      return {
        ok: (orchestrator.config.annEnabled || orchestrator.config.ragEnabled) && status.ok,
        provider: status.provider,
        model: status.model,
        reason: status.reason,
        optional: true
      };
    },
    async probeVectorAvailability() {
      const orchestrator = runtime.forContext();
      const status = orchestrator.embeddingProvider.status();
      return (orchestrator.config.annEnabled || orchestrator.config.ragEnabled) && status.ok;
    },
    async close() {}
  };

  return {
    async getMemorySearchManager() {
      return { manager };
    },
    resolveMemoryBackendConfig(params: { cfg?: { memory?: { citations?: string } } } = {}) {
      return {
        backend: "builtin",
        citations: params.cfg?.memory?.citations ?? "auto",
        oms: {
          agentId: runtime.forContext().config.agentId
        }
      };
    },
    async closeAllMemorySearchManagers() {
      await manager.close();
    }
  };
}

function listOmsPublicArtifacts(runtime: OmsRuntimeRegistry) {
  const orchestrators = runtime.activeOrchestrators();
  const visible = orchestrators.length > 0 ? orchestrators : [runtime.forContext()];
  return visible.flatMap((orchestrator) => {
    if (!orchestrator.config.memoryRepoPath) {
      return [];
    }
    return [
      {
        kind: "oms-redacted-timeline-repo",
        workspaceDir: dirname(orchestrator.config.memoryRepoPath),
        relativePath: basename(orchestrator.config.memoryRepoPath),
        absolutePath: orchestrator.config.memoryRepoPath,
        agentIds: [orchestrator.config.agentId],
        contentType: "directory"
      }
    ];
  });
}

const entry = {
  id: "oms",
  name: "OMS OpenClaw Memory",
  description: "Long-term raw transcript memory. Summary is navigation; raw is truth.",
  register(api: OpenClawPluginApi) {
    const logger = new Logger(api.logger);
    const runtime = new OmsRuntimeRegistry(api.pluginConfig ?? {}, { loadedFromPath: api.source ?? "dist/index.js", logger });

    if (api.registerContextEngine) {
      api.registerContextEngine("oms", () => createOmsContextEngine(runtime));
      runtime.markRegistered({ contextEngineRegistered: true, activeContextEngineId: "oms" });
    }

    if (api.registerMemoryCapability) {
      api.registerMemoryCapability({
        id: "oms",
        kind: "memory",
        description: "Raw transcript ledger with evidence expansion and Git Markdown export.",
        promptBuilder: buildOmsPromptSection,
        runtime: createOmsMemoryRuntime(runtime),
        publicArtifacts: {
          listArtifacts: () => listOmsPublicArtifacts(runtime)
        },
        controlPanel: controlPanelContract()
      });
      runtime.markRegistered({ memorySlotRegistered: true, activeMemorySlotId: "oms" });
    }

    registerTools(api, runtime);
    registerRuntimeHooks(api, runtime, logger);
    return runtime;
  }
};

export default entry;
