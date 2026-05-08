import { RawMessageStore } from "../storage/RawMessageStore.js";
import { RetrievalRunStore } from "../storage/RetrievalRunStore.js";
import { SourceEdge, SourceEdgeStore } from "../storage/SourceEdgeStore.js";
import type { BuildInfo, EvidencePacket, EvidencePolicyRequest, OmsConfig, OmsMode, RawMessage } from "../types.js";
import { EvidencePacketBuilder } from "./EvidencePacketBuilder.js";
import { EvidencePolicy } from "./EvidencePolicy.js";
import { FtsSearch } from "./FtsSearch.js";

export interface ExpandEvidenceArgs {
  summaryId?: string;
  rawMessageId?: string;
  rawMessageIds?: string[];
  query?: string;
  queryId?: string;
  fusionRunId?: string;
  runId?: string;
  sourceRoutes?: string[];
  mode?: OmsMode;
  evidencePolicy?: EvidencePolicyRequest;
  caseId?: string;
  windowTurns?: number;
  maxRawMessages?: number;
  sessionId?: string;
}

export class EvidenceExpander {
  private readonly policy = new EvidencePolicy();
  private readonly packetBuilder = new EvidencePacketBuilder();

  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly sourceEdges: SourceEdgeStore,
    private readonly retrievalRuns: RetrievalRunStore,
    private readonly fts: FtsSearch,
    private readonly config: OmsConfig,
    private readonly build: BuildInfo
  ) {}

  expand(args: ExpandEvidenceArgs): EvidencePacket {
    const mode = args.mode ?? "high";
    const evidencePolicy = args.evidencePolicy ?? (args.caseId ? "material_evidence" : "general_history");
    const sourceSummaryIds = new Set<string>();
    const sourceEdgeIds = new Set<string>();
    let candidates: RawMessage[] = [];
    let summaryDerivedRawCount = 0;

    if (args.rawMessageIds !== undefined) {
      candidates = candidates.concat(this.rawMessages.byIds(args.rawMessageIds));
    }

    if (args.summaryId) {
      const fromSummary = this.rawFromSummary(args.summaryId, sourceSummaryIds, sourceEdgeIds);
      candidates = candidates.concat(fromSummary);
      summaryDerivedRawCount = fromSummary.length;
    }

    if (args.rawMessageId) {
      const raw = this.rawMessages.byId(args.rawMessageId);
      if (raw) {
        candidates.push(raw);
      }
    }

    if (args.query && candidates.length === 0 && args.rawMessageIds === undefined) {
      candidates = this.fts.search({
        agentId: this.config.agentId,
        query: args.query,
        evidencePolicy,
        caseId: args.caseId,
        limit: args.maxRawMessages ?? 20
      });
    }

    const uniqueCandidates = this.unique(candidates).slice(0, args.maxRawMessages ?? 20);
    const expandedCandidates = this.expandWindows(uniqueCandidates, args.windowTurns ?? 0);
    const authorityReport = this.policy.verify(expandedCandidates, evidencePolicy, args.caseId);
    const authoritative = this.policy.filter(expandedCandidates, evidencePolicy, args.caseId);
    const mustFailClosed = mode === "high" || mode === "xhigh" || mode === "ultra" || evidencePolicy === "material_evidence";
    const status: EvidencePacket["status"] =
      authoritative.length > 0 ? "delivered" : mustFailClosed ? "blocked" : expandedCandidates.length > 0 ? "empty" : "empty";
    const reason = authoritative.length > 0 ? undefined : "no_authoritative_raw_found";
    const packet = this.packetBuilder.build({
      build: this.build,
      queryId: args.queryId,
      fusionRunId: args.fusionRunId,
      status,
      reason,
      rawMessages: expandedCandidates,
      authoritativeRawMessages: authoritative,
      summaryDerivedRawCount,
      sourceSummaryIds: Array.from(sourceSummaryIds),
      sourceEdgeIds: Array.from(sourceEdgeIds),
      sourceRoutes: args.sourceRoutes,
      authorityReport
    });
    const runId =
      args.runId ??
      this.retrievalRuns.createRun({
        agentId: this.config.agentId,
        sessionId: args.sessionId,
        query: args.query ?? args.summaryId ?? args.rawMessageId ?? "",
        mode,
        intent: evidencePolicy,
        status: packet.status,
        config: this.config,
        build: this.build,
        metadata: { caseId: args.caseId, queryId: args.queryId, fusionRunId: args.fusionRunId }
      });
    for (const candidate of expandedCandidates) {
      this.retrievalRuns.recordCandidate({
        runId,
        candidateKind: "raw_message",
        candidateIdRef: candidate.messageId,
        score: authoritative.some((raw) => raw.messageId === candidate.messageId) ? 1 : 0,
        status: authoritative.some((raw) => raw.messageId === candidate.messageId) ? "authoritative" : "blocked"
      });
    }
    this.retrievalRuns.recordPacket(runId, this.config.agentId, packet);
    return packet;
  }

  rawMessageIdsForSummary(summaryId: string): string[] {
    return this.rawFromSummary(summaryId, new Set<string>(), new Set<string>()).map((raw) => raw.messageId);
  }

  private rawFromSummary(summaryId: string, sourceSummaryIds: Set<string>, sourceEdgeIds: Set<string>): RawMessage[] {
    sourceSummaryIds.add(summaryId);
    const edges = this.sourceEdges.fromSource("summary", summaryId);
    const raw: RawMessage[] = [];
    for (const edge of edges) {
      sourceEdgeIds.add(edge.edgeId);
      raw.push(...this.rawFromEdge(edge, sourceSummaryIds, sourceEdgeIds));
    }
    return raw;
  }

  private rawFromEdge(edge: SourceEdge, sourceSummaryIds: Set<string>, sourceEdgeIds: Set<string>): RawMessage[] {
    if (edge.targetKind === "raw_message") {
      const raw = this.rawMessages.byId(edge.targetId);
      return raw ? [raw] : [];
    }
    if (edge.targetKind === "summary") {
      return this.rawFromSummary(edge.targetId, sourceSummaryIds, sourceEdgeIds);
    }
    return [];
  }

  private expandWindows(messages: RawMessage[], windowTurns: number): RawMessage[] {
    if (windowTurns <= 0) {
      return this.unique(messages);
    }
    const expanded = [...messages];
    for (const message of messages) {
      if (message.turnId) {
        expanded.push(...this.rawMessages.messagesForTurn(message.turnId));
      }
    }
    return this.unique(expanded);
  }

  private unique(messages: RawMessage[]): RawMessage[] {
    const seen = new Set<string>();
    return messages.filter((message) => {
      if (seen.has(message.messageId)) {
        return false;
      }
      seen.add(message.messageId);
      return true;
    });
  }
}
