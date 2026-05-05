import { SourceEdgeStore } from "../storage/SourceEdgeStore.js";
import { SummaryStore } from "../storage/SummaryStore.js";
import type { SummarySearchHit } from "../types.js";

export class SummarySearch {
  constructor(
    private readonly summaries: SummaryStore,
    private readonly sourceEdges: SourceEdgeStore
  ) {}

  search(agentId: string, query: string, limit = 10): SummarySearchHit[] {
    return this.summaries.search(agentId, query, limit).map((summary, index) => {
      const edges = this.sourceEdges.fromSource("summary", summary.summaryId);
      const rawCandidateCount = edges.filter((edge) => edge.targetKind === "raw_message").length;
      return {
        hitKind: "summary_navigation",
        summaryId: summary.summaryId,
        level: summary.level,
        score: Math.max(0.1, 1 - index * 0.05),
        summaryPreview: summary.summaryText.slice(0, 240),
        evidenceRequired: true,
        nextTool: "oms_expand_evidence",
        sourceSummaryId: summary.summaryId,
        sourceEdgeCount: edges.length,
        rawCandidateCount,
        traceHealth: edges.length > 0 ? "ok" : "broken",
        summaryTextIsNotEvidence: true
      };
    });
  }
}
