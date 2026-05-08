import { SourceEdgeStore } from "../storage/SourceEdgeStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import type { RawMessage } from "../types.js";
import { SummaryStore } from "../storage/SummaryStore.js";
import type { SummarySearchHit } from "../types.js";
import { EvidencePolicy } from "./EvidencePolicy.js";

export class SummarySearch {
  private readonly policy = new EvidencePolicy();

  constructor(
    private readonly summaries: SummaryStore,
    private readonly sourceEdges: SourceEdgeStore,
    private readonly rawMessages: RawMessageStore
  ) {}

  search(agentId: string, query: string, limit = 10): SummarySearchHit[] {
    return this.summaries
      .search(agentId, query, Math.max(limit * 5, 25))
      .map((summary, originalIndex) => {
        const edgeIds = new Set<string>();
        const rawCandidates = this.rawFromSummary(summary.summaryId, edgeIds);
        const authoritativeMaterialRawCount = this.policy.filter(rawCandidates, "material_evidence").length;
        return { summary, originalIndex, edgeIds, rawCandidates, authoritativeMaterialRawCount };
      })
      .sort((a, b) => {
        const materialPriority = Number(b.authoritativeMaterialRawCount > 0) - Number(a.authoritativeMaterialRawCount > 0);
        if (materialPriority !== 0) {
          return materialPriority;
        }
        if (b.authoritativeMaterialRawCount !== a.authoritativeMaterialRawCount) {
          return b.authoritativeMaterialRawCount - a.authoritativeMaterialRawCount;
        }
        return a.originalIndex - b.originalIndex;
      })
      .slice(0, limit)
      .map(({ summary, edgeIds, rawCandidates, authoritativeMaterialRawCount }, index) => {
      return {
        hitKind: "summary_navigation",
        summaryId: summary.summaryId,
        level: summary.level,
        score: Math.max(0.1, 1 - index * 0.05),
        summaryPreview: summary.summaryText.slice(0, 240),
        evidenceRequired: true,
        nextTool: "oms_expand_evidence",
        sourceSummaryId: summary.summaryId,
        sourceEdgeCount: edgeIds.size,
        rawCandidateCount: rawCandidates.length,
        authoritativeMaterialRawCount,
        traceHealth: edgeIds.size > 0 ? "ok" : "broken",
        summaryTextIsNotEvidence: true
      };
    });
  }

  private rawFromSummary(summaryId: string, edgeIds: Set<string>, seen = new Set<string>()): RawMessage[] {
    if (seen.has(summaryId)) {
      return [];
    }
    seen.add(summaryId);
    const raw: RawMessage[] = [];
    for (const edge of this.sourceEdges.fromSource("summary", summaryId)) {
      edgeIds.add(edge.edgeId);
      if (edge.targetKind === "raw_message") {
        const message = this.rawMessages.byId(edge.targetId);
        if (message) {
          raw.push(message);
        }
      }
      if (edge.targetKind === "summary") {
        raw.push(...this.rawFromSummary(edge.targetId, edgeIds, seen));
      }
    }
    return raw;
  }

}
