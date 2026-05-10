import { buildInfo } from "../generated/build-info.js";
import { PayloadNormalizer } from "../adapter/PayloadNormalizer.js";
import { ContextAssembler } from "../context/ContextAssembler.js";
import { CompactionPlanner } from "../context/CompactionPlanner.js";
import { ContextBridge } from "../context/ContextBridge.js";
import { SummaryDagBuilder } from "../processing/SummaryDagBuilder.js";
import { EmbeddingBuilder } from "../processing/EmbeddingBuilder.js";
import { createEmbeddingProvider } from "../processing/EmbeddingProvider.js";
import type { EmbeddingProvider } from "../processing/EmbeddingProvider.js";
import { GraphBuilder } from "../processing/GraphBuilder.js";
import { CandidateLaneStore } from "../storage/CandidateLaneStore.js";
import { ConfigStore } from "../storage/ConfigStore.js";
import { EmbeddingStore } from "../storage/EmbeddingStore.js";
import { EventStore } from "../storage/EventStore.js";
import { GraphStore } from "../storage/GraphStore.js";
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
import { FTS5Bm25Lane } from "../retrieval/lanes/FTS5Bm25Lane.js";
import { TrigramLane } from "../retrieval/lanes/TrigramLane.js";
import { SummaryDagLane } from "../retrieval/lanes/SummaryDagLane.js";
import { AnnVectorLane } from "../retrieval/lanes/AnnVectorLane.js";
import { GraphCteLane } from "../retrieval/lanes/GraphCteLane.js";
import { TimelineLane } from "../retrieval/lanes/TimelineLane.js";
import { SQLRRFusion } from "../retrieval/SQLRRFusion.js";
import { QueryIntentClassifier } from "../retrieval/QueryIntentClassifier.js";
import { GitMdWriter } from "../git/GitMdWriter.js";
import { TimelineExporter } from "../git/TimelineExporter.js";
import { GitMdImporter } from "../git/GitMdImporter.js";
import { RuntimeAttestation } from "./RuntimeAttestation.js";
import { TaskQueue } from "./TaskQueue.js";
import { Logger } from "./Logger.js";
import { FeatureHealthRegistry } from "./FeatureHealthRegistry.js";
import type { BuildInfo, EvidencePolicyRequest, OmsConfig, OmsStatus, RawMessage, RawWriteInput } from "../types.js";

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
  readonly laneStore: CandidateLaneStore;
  readonly featureHealth: FeatureHealthRegistry;
  readonly embeddings: EmbeddingStore;
  readonly embeddingProvider: EmbeddingProvider;
  readonly graph: GraphStore;
  readonly rawWriter: RawWriter;
  readonly summaryDag: SummaryDagBuilder;
  readonly embeddingBuilder: EmbeddingBuilder;
  readonly graphBuilder: GraphBuilder;
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
    this.laneStore = new CandidateLaneStore(this.connection.db);
    this.featureHealth = new FeatureHealthRegistry(this.connection.db, config.agentId);
    this.embeddings = new EmbeddingStore(this.connection.db);
    this.embeddingProvider = createEmbeddingProvider(config);
    this.graph = new GraphStore(this.connection.db);
    this.rawWriter = new RawWriter(
      this.rawMessages,
      this.events,
      config.agentId,
      config.gitExportEnabled && config.memoryRepoPath ? new GitMdWriter(config.memoryRepoPath) : undefined
    );
    this.summaryDag = new SummaryDagBuilder(this.summaries, this.sourceEdges, this.rawMessages, this.events, config);
    this.embeddingBuilder = new EmbeddingBuilder(this.rawMessages, this.embeddings, this.embeddingProvider);
    this.graphBuilder = new GraphBuilder(this.rawMessages, this.graph);
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
    this.retrievalRouter = new RetrievalRouter(
      config,
      this.build(),
      this.rawMessages,
      this.retrievalRuns,
      this.laneStore,
      this.featureHealth,
      this.expander,
      new FTS5Bm25Lane(this.connection.db),
      new TrigramLane(this.connection.db),
      new SummaryDagLane(this.summarySearch, this.sourceEdges, this.rawMessages),
      new AnnVectorLane(config, this.embeddingBuilder, this.embeddings, this.embeddingProvider),
      new GraphCteLane(this.connection.db, this.graph),
      new TimelineLane(this.rawMessages),
      new SQLRRFusion(this.connection.db)
    );
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
        turnId: input.turnId,
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

    let summaryResult:
      | {
          summarized: boolean;
          leaf?: unknown;
          rollups: unknown[];
          reason?: string;
          rawTokensOutsideTail: number;
        }
      | undefined;
    if (this.config.summaryEnabled) {
      await this.queue.enqueue({
        id: `summary_compaction:${sessionId}`,
        kind: "summary_compaction",
        run: () => {
          summaryResult = this.summaryDag.compactSession({ agentId: this.config.agentId, sessionId });
        }
      });
    }
    if (this.vectorRetrievalConfigured()) {
      await this.queue.enqueue({
        id: `embedding:${sessionId}:${Date.now()}`,
        kind: "embedding_build",
        run: () => this.embeddingBuilder.buildForAgent(this.config.agentId).then(() => undefined)
      });
    }
    if (this.config.graphEnabled) {
      await this.queue.enqueue({
        id: `graph:${sessionId}:${Date.now()}`,
        kind: "graph_extract",
        run: () => {
          this.graphBuilder.buildIncremental(this.config.agentId);
        }
      });
    }
    return {
      ok: ingestResult?.ok ?? true,
      summarized: summaryResult?.summarized ?? false,
      turnIds,
      receipts: ingestResult?.receipts ?? [],
      summary: summaryResult
    };
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
    return this.rawMessages.allForAgent(this.config.agentId, limit).map((message) => this.redactedRaw(message));
  }

  status(): OmsStatus {
    const queueCounts = this.queue.counts();
    const features = this.featureHealth.statusMap();
    if (!this.vectorRetrievalConfigured()) {
      features.annVector = "blocked";
    }
    return {
      ok: this.lastError === undefined,
      agentId: this.config.agentId,
      mode: this.config.mode,
      build: this.build(),
      openclaw: this.registration,
      counts: {
        rawMessages: this.rawMessages.countForAgent(this.config.agentId),
        summaries: this.summaries.countForAgent(this.config.agentId),
        sourceEdges: this.sourceEdges.countForAgent(this.config.agentId),
        retrievalRuns: this.retrievalRuns.countRunsForAgent(this.config.agentId),
        evidencePackets: this.retrievalRuns.countPacketsForAgent(this.config.agentId),
        embeddingChunks: this.embeddings.countForAgent(this.config.agentId),
        graphNodes: this.graph.countNodes(this.config.agentId),
        graphEdges: this.graph.countEdges(this.config.agentId),
        pendingJobs: queueCounts.pendingJobs,
        failedJobs: queueCounts.failedJobs
      },
      health: {
        rawWriteOk: this.lastError !== "raw_write_not_confirmed",
        ftsReady: features.ftsBm25 !== "failed" && features.ftsBm25 !== "degraded",
        trigramReady: features.trigram !== "failed" && features.trigram !== "degraded" && features.trigram !== "blocked",
        summaryDagOk: features.summaryDag !== "failed" && features.summaryDag !== "degraded",
        annVectorOk: features.annVector !== "failed",
        graphCteOk: features.graphCte !== "failed",
        sqlFusionOk: features.sqlFusion !== "failed" && features.sqlFusion !== "degraded",
        gitExportOk: true,
        lastError: this.lastError
      },
      features
    };
  }

  summarySearchTool(params: Record<string, unknown>) {
    return this.summarySearch.search(this.config.agentId, String(params.query ?? ""), Number(params.limit ?? 10));
  }

  async retrieveTool(params: Record<string, unknown>) {
    const query = String(params.query ?? "");
    const mode = (params.mode === undefined ? this.config.mode : String(params.mode)) as never;
    const caseId = params.caseId === undefined ? undefined : String(params.caseId);
    const policy = this.evidencePolicyFor(query, params.evidencePolicy, caseId);
    return this.retrievalRouter.retrieve({
      agentId: this.config.agentId,
      query,
      mode,
      evidencePolicy: policy,
      caseId,
      sessionId: params.sessionId === undefined ? undefined : String(params.sessionId),
      requiredLane: params.requiredLane as never,
      limit: params.limit === undefined ? undefined : Number(params.limit)
    });
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

  async ftsSearchTool(params: Record<string, unknown>) {
    const query = String(params.query ?? "");
    const caseId = params.caseId === undefined ? undefined : String(params.caseId);
    const policy = this.evidencePolicyFor(query, params.evidencePolicy, caseId);
    return this.retrieveTool({
      query,
      evidencePolicy: policy,
      caseId,
      sessionId: params.sessionId,
      mode: params.mode ?? "medium",
      requiredLane: "fts_bm25",
      limit: params.limit
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
      const message = this.rawMessages.byId(String(params.messageId));
      return {
        traceKind: "raw_message",
        message: message ? this.redactedRaw(message) : undefined,
        note: "Raw text is redacted on message traces. Use packet-backed oms_search/oms_expand_evidence for evidence excerpts.",
        sourceEdges: this.sourceEdges.toTarget("raw_message", String(params.messageId))
      };
    }
    return { traceKind: "none", reason: "summaryId_packetId_or_messageId_required" };
  }

  async whyTool(params: Record<string, unknown>) {
    const query = String(params.query ?? "");
    const mode = params.mode ? String(params.mode) : this.config.mode;
    const caseId = params.caseId === undefined ? undefined : String(params.caseId);
    const intent = this.evidencePolicyFor(query, params.evidencePolicy, caseId);
    const result = await this.retrievalRouter.retrieve({
      agentId: this.config.agentId,
      query,
      mode: mode as never,
      evidencePolicy: intent,
      caseId
    });
    return {
      queryTerms: query.split(/\s+/u).filter(Boolean),
      mode,
      enabledModules: {
        summary: this.config.summaryEnabled,
        fts5: this.config.ftsEnabled,
        trigram: this.config.trigramEnabled,
        rag: this.config.ragEnabled,
        ann: this.config.annEnabled,
        embeddingProvider: this.config.embeddingProvider,
        embeddingModelConfigured: Boolean(this.config.embeddingModel),
        embeddingApiKeyEnv: this.config.embeddingApiKeyEnv,
        graph: this.config.graphEnabled,
        sqlFusion: this.config.sqlFusionEnabled
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

  gitImportTool(params: Record<string, unknown> = {}) {
    if (typeof params.sourceRepoPath !== "string" || params.sourceRepoPath.trim().length === 0) {
      return { ok: false, reason: "source_repo_path_required" };
    }
    return new GitMdImporter(this.rawMessages, this.rawWriter, this.events).import({
      targetAgentId: this.config.agentId,
      sourceRepoPath: params.sourceRepoPath,
      mode: typeof params.mode === "string" ? params.mode : undefined,
      duplicatePolicy: typeof params.duplicatePolicy === "string" ? params.duplicatePolicy : undefined,
      limit: params.limit === undefined ? undefined : Number(params.limit)
    });
  }

  debugRawTool(params: Record<string, unknown> = {}) {
    if (!this.config.debug) {
      return { ok: false, reason: "debug_mode_disabled" };
    }
    return this.rawMessages.allForAgent(this.config.agentId, Number(params.limit ?? 100)).map((message) => this.redactedRaw(message));
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

  private redactedRaw(message: RawMessage) {
    return {
      messageId: message.messageId,
      agentId: message.agentId,
      sessionId: message.sessionId,
      turnId: message.turnId,
      role: message.role,
      eventType: message.eventType,
      createdAt: message.createdAt,
      sequence: message.sequence,
      tokenCount: message.tokenCount,
      originalHash: message.originalHash,
      visibleToUser: message.visibleToUser,
      interrupted: message.interrupted,
      sourceScope: message.sourceScope,
      sourcePurpose: message.sourcePurpose,
      sourceAuthority: message.sourceAuthority,
      retrievalAllowed: message.retrievalAllowed,
      evidenceAllowed: message.evidenceAllowed,
      evidencePolicyMask: message.evidencePolicyMask,
      caseId: message.caseId,
      parentMessageId: message.parentMessageId,
      turnIndex: message.turnIndex,
      originalText: "[redacted: use delivered evidence packet]",
      normalizedText: "[redacted]"
    };
  }

  private vectorRetrievalConfigured(): boolean {
    const status = this.embeddingProvider.status();
    return (this.config.annEnabled || this.config.ragEnabled) && status.ok && Boolean(this.embeddingProvider.model);
  }

  private evidencePolicyFor(query: string, requested: unknown, caseId?: string): EvidencePolicyRequest {
    if (requested !== undefined) {
      return requested as EvidencePolicyRequest;
    }
    return caseId ? "material_evidence" : this.intentClassifier.classify(query);
  }
}
