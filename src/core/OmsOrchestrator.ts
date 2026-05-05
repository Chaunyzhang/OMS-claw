import { buildInfo } from "../generated/build-info.js";
import { PayloadNormalizer } from "../adapter/PayloadNormalizer.js";
import { ContextAssembler } from "../context/ContextAssembler.js";
import { CompactionPlanner } from "../context/CompactionPlanner.js";
import { ContextBridge } from "../context/ContextBridge.js";
import { SummaryDagBuilder } from "../processing/SummaryDagBuilder.js";
import { ConfigStore } from "../storage/ConfigStore.js";
import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import { RetrievalRunStore } from "../storage/RetrievalRunStore.js";
import { SQLiteConnection } from "../storage/SQLiteConnection.js";
import { SourceEdgeStore } from "../storage/SourceEdgeStore.js";
import { SummaryStore } from "../storage/SummaryStore.js";
import { IngestClassifier } from "../ingest/IngestClassifier.js";
import { RawWriter } from "../ingest/RawWriter.js";
import { FtsSearch } from "../retrieval/FtsSearch.js";
import { EvidenceExpander } from "../retrieval/EvidenceExpander.js";
import { SummarySearch } from "../retrieval/SummarySearch.js";
import { RetrievalRouter } from "../retrieval/RetrievalRouter.js";
import { QueryIntentClassifier } from "../retrieval/QueryIntentClassifier.js";
import { TimelineExporter } from "../git/TimelineExporter.js";
import { RuntimeAttestation } from "./RuntimeAttestation.js";
import { TaskQueue } from "./TaskQueue.js";
import { Logger } from "./Logger.js";
import type { BuildInfo, EvidencePolicyRequest, OmsConfig, OmsStatus, RawWriteInput } from "../types.js";

export interface RegistrationState {
  contextEngineRegistered: boolean;
  memorySlotRegistered: boolean;
  toolsRegistered: boolean;
  activeContextEngineId?: string;
  activeMemorySlotId?: string;
}

export class OmsOrchestrator {
  readonly connection: SQLiteConnection;
  readonly rawMessages: RawMessageStore;
  readonly events: EventStore;
  readonly summaries: SummaryStore;
  readonly sourceEdges: SourceEdgeStore;
  readonly retrievalRuns: RetrievalRunStore;
  readonly rawWriter: RawWriter;
  readonly summaryDag: SummaryDagBuilder;
  readonly fts: FtsSearch;
  readonly expander: EvidenceExpander;
  readonly summarySearch: SummarySearch;
  readonly retrievalRouter: RetrievalRouter;
  readonly contextBridge = new ContextBridge();
  readonly queue = new TaskQueue();
  readonly logger: Logger;

  private readonly classifier = new IngestClassifier();
  private readonly normalizer = new PayloadNormalizer();
  private readonly intentClassifier = new QueryIntentClassifier();
  private readonly attestation: RuntimeAttestation;
  private readonly registration: RegistrationState = {
    contextEngineRegistered: false,
    memorySlotRegistered: false,
    toolsRegistered: false
  };
  private lastError: string | undefined;

  constructor(
    readonly config: OmsConfig,
    options: { loadedFromPath?: string; logger?: Logger } = {}
  ) {
    this.logger = options.logger ?? new Logger();
    this.attestation = new RuntimeAttestation(options.loadedFromPath);
    this.connection = new SQLiteConnection(config.dbPath);
    new ConfigStore(this.connection.db).ensureAgent(config);
    this.rawMessages = new RawMessageStore(this.connection.db);
    this.events = new EventStore(this.connection.db);
    this.summaries = new SummaryStore(this.connection.db);
    this.sourceEdges = new SourceEdgeStore(this.connection.db);
    this.retrievalRuns = new RetrievalRunStore(this.connection.db);
    this.rawWriter = new RawWriter(this.rawMessages, this.events, config.agentId);
    this.summaryDag = new SummaryDagBuilder(this.summaries, this.sourceEdges, this.rawMessages, this.events);
    this.fts = new FtsSearch(this.connection.db);
    this.expander = new EvidenceExpander(
      this.rawMessages,
      this.sourceEdges,
      this.retrievalRuns,
      this.fts,
      config,
      this.build()
    );
    this.summarySearch = new SummarySearch(this.summaries, this.sourceEdges, this.rawMessages);
    this.retrievalRouter = new RetrievalRouter(this.summarySearch, this.fts, this.expander);
  }

  build(): BuildInfo {
    return { ...buildInfo, loadedFromPath: this.attestation.current().loadedFromPath };
  }

  markRegistered(partial: Partial<RegistrationState>): void {
    Object.assign(this.registration, partial);
  }

  ingest(input: unknown) {
    if (this.config.mode === "off") {
      return { ok: false, reason: "retrieval_mode_disabled", receipts: [] };
    }
    const candidates = this.normalizer.normalize(input);
    const receipts = candidates
      .map((candidate) => this.classifier.classify(candidate))
      .filter((candidate): candidate is RawWriteInput => candidate !== undefined)
      .map((candidate) => this.rawWriter.write(candidate));
    if (receipts.some((receipt) => !receipt.ok)) {
      this.lastError = "raw_write_not_confirmed";
    }
    return { ok: receipts.every((receipt) => receipt.ok), receipts };
  }

  ingestBatch(inputs: unknown[] | unknown) {
    const payloads = Array.isArray(inputs) ? inputs : [inputs];
    const results = payloads.map((input) => this.ingest(input));
    return {
      ok: results.every((result) => result.ok),
      results
    };
  }

  assemble(input: { sessionId?: string; messages?: unknown[]; availableTools?: Set<string> | string[] } = {}) {
    const assembler = new ContextAssembler(this.rawMessages, this.contextBridge, this.config);
    return assembler.assemble({
      sessionId: input.sessionId ?? "default-session",
      messages: input.messages,
      availableTools: input.availableTools
    });
  }

  compact(input: { sessionId?: string; turnId?: string } = {}) {
    const turnId = input.turnId;
    if (!turnId) {
      return { ok: false, compacted: false, reason: "compaction_preconditions_failed", blockers: ["turn_id_required"] };
    }
    const planner = new CompactionPlanner(this.rawMessages, this.sourceEdges, this.events);
    const plan = planner.check({ agentId: this.config.agentId, sessionId: input.sessionId ?? "default-session", turnId });
    if (!plan.ok) {
      this.lastError = plan.reason;
      return plan;
    }
    this.events.record({
      agentId: this.config.agentId,
      sessionId: input.sessionId ?? "default-session",
      eventType: "compacted",
      payload: { turnId, compacted: true }
    });
    return { ...plan, compacted: true };
  }

  async afterTurn(input: { sessionId?: string; turnId?: string; messages?: unknown[]; prePromptMessageCount?: number }) {
    const sessionId = input.sessionId ?? "default-session";
    let ingestResult: ReturnType<OmsOrchestrator["ingest"]> | undefined;
    if (Array.isArray(input.messages)) {
      const start =
        typeof input.prePromptMessageCount === "number" && Number.isFinite(input.prePromptMessageCount)
          ? Math.max(0, Math.floor(input.prePromptMessageCount))
          : 0;
      ingestResult = this.ingest({
        sessionId,
        messages: input.messages.slice(start)
      });
    }

    const turnIds = input.turnId
      ? [input.turnId]
      : Array.from(
          new Set(
            (ingestResult?.receipts ?? [])
              .filter((receipt) => receipt.ok && typeof receipt.turnId === "string" && receipt.turnId.length > 0)
              .map((receipt) => receipt.turnId as string)
          )
        );
    if (turnIds.length === 0) {
      return {
        ok: ingestResult?.ok ?? true,
        summarized: false,
        reason: "turn_id_unavailable",
        receipts: ingestResult?.receipts ?? []
      };
    }

    for (const turnId of turnIds) {
      await this.queue.enqueue({
        id: `summary:${turnId}`,
        kind: "leaf_summary",
        run: () => {
          this.summaryDag.buildLeafForTurn({ agentId: this.config.agentId, sessionId, turnId });
        }
      });
    }
    return { ok: ingestResult?.ok ?? true, summarized: true, turnIds, receipts: ingestResult?.receipts ?? [] };
  }

  prepareSubagentSpawn(input: Record<string, unknown> = {}) {
    return {
      contextBridge: this.contextBridge.render(),
      note: "OMS passes only current-session bridge context to subagents; long-term memory still requires tools.",
      input
    };
  }

  onSubagentEnded(input: Record<string, unknown> = {}) {
    this.contextBridge.add(`Subagent ended: ${JSON.stringify(input).slice(0, 240)}`);
    return { ok: true };
  }

  timeline(limit = 100) {
    return this.rawMessages.allForAgent(this.config.agentId, limit);
  }

  status(): OmsStatus {
    const queueCounts = this.queue.counts();
    return {
      ok: this.lastError === undefined,
      agentId: this.config.agentId,
      mode: this.config.mode,
      dbPath: this.config.dbPath,
      memoryRepoPath: this.config.memoryRepoPath,
      build: this.build(),
      openclaw: this.registration,
      counts: {
        rawMessages: this.rawMessages.count(),
        summaries: this.summaries.count(),
        sourceEdges: this.sourceEdges.count(),
        retrievalRuns: this.retrievalRuns.countRuns(),
        evidencePackets: this.retrievalRuns.countPackets(),
        pendingJobs: queueCounts.pendingJobs,
        failedJobs: queueCounts.failedJobs
      },
      health: {
        rawWriteOk: this.lastError !== "raw_write_not_confirmed",
        ftsReady: true,
        summaryDagOk: true,
        gitExportOk: true,
        lastError: this.lastError
      }
    };
  }

  summarySearchTool(params: Record<string, unknown>) {
    return this.summarySearch.search(this.config.agentId, String(params.query ?? ""), Number(params.limit ?? 10));
  }

  expandEvidenceTool(params: Record<string, unknown>) {
    return this.expander.expand({
      summaryId: params.summaryId === undefined ? undefined : String(params.summaryId),
      rawMessageId: params.rawMessageId === undefined ? undefined : String(params.rawMessageId),
      query: params.query === undefined ? undefined : String(params.query),
      mode: params.mode as never,
      evidencePolicy: params.evidencePolicy as EvidencePolicyRequest | undefined,
      caseId: params.caseId === undefined ? undefined : String(params.caseId),
      windowTurns: params.windowTurns === undefined ? undefined : Number(params.windowTurns),
      maxRawMessages: params.maxRawMessages === undefined ? undefined : Number(params.maxRawMessages),
      sessionId: params.sessionId === undefined ? undefined : String(params.sessionId)
    });
  }

  ftsSearchTool(params: Record<string, unknown>) {
    const query = String(params.query ?? "");
    const policy =
      params.evidencePolicy === undefined ? this.intentClassifier.classify(query) : (params.evidencePolicy as EvidencePolicyRequest);
    const caseId = params.caseId === undefined ? undefined : String(params.caseId);
    if (policy === "material_evidence" && this.config.summaryEnabled) {
      const summaryHits = this.summarySearch.search(this.config.agentId, query, Number(params.limit ?? 10));
      const expanded = summaryHits.map((hit) => ({
        navigationHit: hit,
        evidencePacket: this.expander.expand({
          summaryId: hit.summaryId,
          query,
          mode: "high",
          evidencePolicy: policy,
          caseId
        })
      }));
      const delivered = expanded.find((item) => item.evidencePacket.status === "delivered");
      if (delivered ?? expanded[0]) {
        return {
          hitKind: "summary_dag_expand_evidence",
          usedModule: "summary_dag_expand_evidence",
          rawExactSearchOnly: false,
          ftsFallbackUsed: false,
          note:
            "Material-evidence queries must not answer from FTS alone. OMS found summary navigation and expanded it to an authoritative raw evidence packet.",
          summaryNavigationHitCount: summaryHits.length,
          selected: delivered ?? expanded[0],
          attempted: expanded
        };
      }
    }
    return this.fts.search({
      agentId: this.config.agentId,
      query,
      evidencePolicy: policy,
      caseId,
      limit: params.limit === undefined ? undefined : Number(params.limit)
    });
  }

  traceTool(params: Record<string, unknown>) {
    if (params.packetId) {
      const trace = this.retrievalRuns.traceForPacket(String(params.packetId));
      return {
        traceKind: "packet",
        path: "query -> retrieval run -> candidate -> summary/source edge -> raw message -> evidence packet -> delivered to OpenClaw",
        trace
      };
    }
    if (params.summaryId) {
      return {
        traceKind: "summary",
        summaryId: String(params.summaryId),
        sourceEdges: this.sourceEdges.fromSource("summary", String(params.summaryId))
      };
    }
    if (params.messageId) {
      return {
        traceKind: "raw_message",
        message: this.rawMessages.byId(String(params.messageId)),
        sourceEdges: this.sourceEdges.toTarget("raw_message", String(params.messageId))
      };
    }
    return { traceKind: "none", reason: "summaryId_packetId_or_messageId_required" };
  }

  whyTool(params: Record<string, unknown>) {
    const query = String(params.query ?? "");
    const mode = params.mode ? String(params.mode) : this.config.mode;
    const intent = this.intentClassifier.classify(query);
    const result = this.retrievalRouter.retrieve({
      agentId: this.config.agentId,
      query,
      mode: mode as never,
      evidencePolicy: intent,
      caseId: params.caseId === undefined ? undefined : String(params.caseId)
    });
    return {
      queryTerms: query.split(/\s+/u).filter(Boolean),
      mode,
      enabledModules: {
        summary: this.config.summaryEnabled,
        fts5: this.config.ftsEnabled,
        rag: this.config.ragEnabled,
        graph: this.config.graphEnabled
      },
      intent,
      candidateCounts: JSON.stringify(result).match(/messageId|summaryId/g)?.length ?? 0,
      result,
      failedJobs: this.queue.recentFailures()
    };
  }

  gitExportTool(params: Record<string, unknown> = {}) {
    if (!this.config.memoryRepoPath) {
      return { ok: false, reason: "memory_repo_path_missing" };
    }
    const messages = this.rawMessages.allForAgent(this.config.agentId, Number(params.limit ?? 10000));
    return new TimelineExporter(this.events).export({
      agentId: this.config.agentId,
      memoryRepoPath: this.config.memoryRepoPath,
      messages,
      force: params.force === true
    });
  }

  debugRawTool(params: Record<string, unknown> = {}) {
    if (!this.config.debug) {
      return { ok: false, reason: "debug_mode_disabled" };
    }
    return this.rawMessages.allForAgent(this.config.agentId, Number(params.limit ?? 100));
  }

  createContextEngine() {
    return {
      info: {
        id: "oms",
        name: "OMS OpenClaw Context Engine",
        version: this.build().packageVersion,
        ownsCompaction: true
      },
      bootstrap: () => this.status(),
      ingest: (payload: unknown) => this.ingest(payload),
      ingestBatch: (payloads: unknown[] | unknown) => this.ingestBatch(payloads),
      assemble: (input: { sessionId?: string; messages?: unknown[]; availableTools?: Set<string> | string[] } = {}) => this.assemble(input),
      compact: (input: { sessionId?: string; turnId?: string } = {}) => this.compact(input),
      afterTurn: (input: { sessionId?: string; turnId?: string; messages?: unknown[]; prePromptMessageCount?: number }) => this.afterTurn(input),
      prepareSubagentSpawn: (input: Record<string, unknown> = {}) => this.prepareSubagentSpawn(input),
      onSubagentEnded: (input: Record<string, unknown> = {}) => this.onSubagentEnded(input),
      dispose: () => {}
    };
  }
}
