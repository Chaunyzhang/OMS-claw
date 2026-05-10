import type { BuildInfo, CandidateLaneResult, EvidencePolicyRequest, LaneName, OmsConfig, OmsMode, OmsRetrieveResult } from "../types.js";
import { CandidateLaneStore } from "../storage/CandidateLaneStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import { RetrievalRunStore } from "../storage/RetrievalRunStore.js";
import { FeatureHealthRegistry } from "../core/FeatureHealthRegistry.js";
import { DeterministicReranker } from "./DeterministicReranker.js";
import { EvidenceExpander } from "./EvidenceExpander.js";
import { SQLRRFusion } from "./SQLRRFusion.js";
import { AnnVectorLane } from "./lanes/AnnVectorLane.js";
import { FTS5Bm25Lane } from "./lanes/FTS5Bm25Lane.js";
import { GraphCteLane } from "./lanes/GraphCteLane.js";
import { SummaryDagLane } from "./lanes/SummaryDagLane.js";
import { TimelineLane } from "./lanes/TimelineLane.js";
import { TrigramLane } from "./lanes/TrigramLane.js";
import { isTimelineRecallQuery } from "./RecallIntent.js";

function canonicalMode(mode: OmsMode): OmsMode {
  return mode === "xhigh" ? "ultra" : mode;
}

export class RetrievalRouter {
  private readonly reranker = new DeterministicReranker();

  constructor(
    private readonly config: OmsConfig,
    private readonly build: BuildInfo,
    private readonly rawMessages: RawMessageStore,
    private readonly retrievalRuns: RetrievalRunStore,
    private readonly laneStore: CandidateLaneStore,
    private readonly health: FeatureHealthRegistry,
    private readonly expander: EvidenceExpander,
    private readonly ftsLane: FTS5Bm25Lane,
    private readonly trigramLane: TrigramLane,
    private readonly summaryLane: SummaryDagLane,
    private readonly annLane: AnnVectorLane,
    private readonly graphLane: GraphCteLane,
    private readonly timelineLane: TimelineLane,
    private readonly fusion: SQLRRFusion
  ) {}

  async retrieve(input: {
    agentId: string;
    query: string;
    mode: OmsMode;
    evidencePolicy?: EvidencePolicyRequest;
    caseId?: string;
    sessionId?: string;
    requiredLane?: LaneName;
    limit?: number;
  }): Promise<OmsRetrieveResult> {
    const timings: Record<string, number> = {};
    const started = Date.now();
    const mode = canonicalMode(input.mode === "auto" ? "medium" : input.mode);
    const evidencePolicy = input.evidencePolicy ?? (mode === "high" || mode === "ultra" ? "material_evidence" : "general_history");
    const queryId = this.laneStore.createQuery({
      agentId: input.agentId,
      sessionId: input.sessionId,
      query: input.query,
      mode,
      config: this.config,
      metadata: { caseId: input.caseId, requiredLane: input.requiredLane }
    });
    const runId = this.retrievalRuns.createRun({
      agentId: input.agentId,
      sessionId: input.sessionId,
      query: input.query,
      mode,
      intent: evidencePolicy,
      status: "candidate",
      config: this.config,
      build: this.build,
      metadata: { queryId, caseId: input.caseId, requiredLane: input.requiredLane }
    });

    const laneResults = await this.runLanes({
      agentId: input.agentId,
      query: input.query,
      mode,
      limit: input.limit ?? 20,
      requiredLane: input.requiredLane
    });
    this.laneStore.recordLaneResults(runId, queryId, input.agentId, laneResults);
    for (const result of laneResults) {
      this.health.mark(this.featureName(result.lane), result.status === "ok" ? "ready" : result.status, result.timingsMs, result.error);
      timings[result.lane] = result.timingsMs.total ?? 0;
    }

    let fusionRunId: string | undefined;
    let fusedCandidates = [];
    try {
      fusionRunId = this.laneStore.createFusionRun(queryId, input.agentId, "rrf_sql_v1");
      fusedCandidates = this.fusion.fuse(queryId, input.limit ?? 20);
      const rawForRerank = this.rawMessages.byIds(fusedCandidates.map((candidate) => candidate.rawId));
      fusedCandidates = this.reranker.rerank({ query: input.query, candidates: fusedCandidates, rawMessages: rawForRerank });
      this.laneStore.recordFused(fusionRunId, fusedCandidates);
      this.health.mark("sqlFusion", "ready", { candidateCount: fusedCandidates.length });
    } catch (error) {
      this.health.mark("sqlFusion", "degraded", {}, error);
      fusedCandidates = this.fusion.fallbackFromLaneResults(queryId, input.limit ?? 20);
    }

    const lanesUsed = laneResults.filter((result) => result.status === "ok").map((result) => result.lane);
    const lanesDegraded = laneResults
      .filter((result) => result.status !== "ok")
      .map((result) => ({ lane: result.lane, status: result.status, error: result.error }));
    const candidateCount = laneResults.reduce((count, result) => count + result.candidates.length, 0);
    const rawIdHints = fusedCandidates.map((candidate) => candidate.rawId);
    const sourceRoutes = Array.from(new Set(fusedCandidates.flatMap((candidate) => candidate.laneVotes.map((vote) => vote.lane))));
    const packet =
      rawIdHints.length > 0
        ? this.expander.expand({
            rawMessageIds: rawIdHints,
            query: input.query,
            queryId,
            fusionRunId,
            runId,
            sourceRoutes,
            mode,
            evidencePolicy,
            caseId: input.caseId,
            sessionId: input.sessionId,
            maxRawMessages: input.limit ?? 20
          })
        : null;
    const requiredLaneSatisfied = input.requiredLane === undefined || lanesUsed.includes(input.requiredLane);
    const packetDelivered = packet?.status === "delivered";
    const mustHavePacket = mode === "medium" || mode === "high" || mode === "ultra" || evidencePolicy === "material_evidence";
    timings.total = Date.now() - started;
    if (packetDelivered && requiredLaneSatisfied) {
      return {
        ok: true,
        queryId,
        mode,
        lanesUsed,
        lanesDegraded,
        candidateCount,
        packet,
        details: { fusionRunId, timingsMs: timings, fusedCandidates },
        answerPolicy: "ready_for_openclaw"
      };
    }
    return {
      ok: !mustHavePacket && candidateCount > 0,
      queryId,
      mode,
      lanesUsed,
      lanesDegraded,
      candidateCount,
      packet,
      details: { fusionRunId, timingsMs: timings, fusedCandidates },
      reason: packet === null ? "no_candidates" : packet.reason ?? "no_authoritative_raw_evidence",
      answerPolicy: packetDelivered ? "candidate_only" : "must_not_answer_from_candidates"
    };
  }

  private async runLanes(input: {
    agentId: string;
    query: string;
    mode: OmsMode;
    limit: number;
    requiredLane?: LaneName;
  }): Promise<CandidateLaneResult[]> {
    const timelineRecall = isTimelineRecallQuery(input.query);
    const vectorEnabled = this.config.annEnabled || this.config.ragEnabled;
    const lanes: Array<[LaneName, () => CandidateLaneResult | Promise<CandidateLaneResult>, boolean]> = [
      ["timeline", () => this.timelineLane.search(input), timelineRecall],
      ["fts_bm25", () => this.ftsLane.search(input), !timelineRecall && this.config.ftsEnabled],
      ["trigram", () => this.trigramLane.search(input), !timelineRecall && this.config.trigramEnabled && (input.mode === "high" || input.mode === "ultra")],
      ["summary_dag", () => this.summaryLane.search(input), !timelineRecall && this.config.summaryEnabled && input.mode !== "low"],
      ["ann_vector", () => this.annLane.search(input), !timelineRecall && vectorEnabled && (input.mode === "high" || input.mode === "ultra")],
      ["graph_cte", () => this.graphLane.search(input), !timelineRecall && this.config.graphEnabled && input.mode === "ultra"]
    ];
    return Promise.all(
      lanes
      .filter(([lane, , enabled]) => (input.requiredLane ? lane === input.requiredLane : enabled))
      .map(([lane, run, enabled]) => {
        if (!enabled && input.requiredLane === lane) {
          return { lane, status: "blocked", candidates: [], timingsMs: { total: 0 }, error: "lane_disabled" } as CandidateLaneResult;
        }
        return run();
      })
    );
  }

  private featureName(lane: LaneName): string {
    return (
      {
        fts_bm25: "ftsBm25",
        trigram: "trigram",
        summary_dag: "summaryDag",
        ann_vector: "annVector",
        graph_cte: "graphCte",
        timeline: "timeline"
      } satisfies Record<LaneName, string>
    )[lane];
  }
}
