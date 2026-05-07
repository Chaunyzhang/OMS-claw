import { RawMessageStore } from "../../storage/RawMessageStore.js";
import { SourceEdgeStore } from "../../storage/SourceEdgeStore.js";
import { SummarySearch } from "../SummarySearch.js";
import type { CandidateLaneResult, RawMessage } from "../../types.js";

export class SummaryDagLane {
  readonly lane = "summary_dag" as const;

  constructor(
    private readonly summarySearch: SummarySearch,
    private readonly sourceEdges: SourceEdgeStore,
    private readonly rawMessages: RawMessageStore
  ) {}

  search(input: { agentId: string; query: string; limit?: number }): CandidateLaneResult {
    const started = Date.now();
    try {
      const hits = this.summarySearch.search(input.agentId, input.query, input.limit ?? 10);
      const candidates = hits.flatMap((hit, hitIndex) =>
        this.rawIdsForSummary(hit.summaryId).map((raw, rawIndex) => ({
          targetKind: "summary" as const,
          targetId: hit.summaryId,
          rawIdHint: raw.messageId,
          summaryIdHint: hit.summaryId,
          rank: hitIndex + rawIndex + 1,
          score: hit.score,
          reason: {
            summaryNavigationHit: true,
            summaryTextIsNotEvidence: true,
            candidateOnly: true,
            evidenceRequired: true
          }
        }))
      );
      return { lane: this.lane, status: "ok", candidates, timingsMs: { total: Date.now() - started } };
    } catch (error) {
      return {
        lane: this.lane,
        status: "degraded",
        candidates: [],
        timingsMs: { total: Date.now() - started },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private rawIdsForSummary(summaryId: string, seen = new Set<string>()): RawMessage[] {
    if (seen.has(summaryId)) {
      return [];
    }
    seen.add(summaryId);
    const raw: RawMessage[] = [];
    for (const edge of this.sourceEdges.fromSource("summary", summaryId)) {
      if (edge.targetKind === "raw_message") {
        const message = this.rawMessages.byId(edge.targetId);
        if (message) {
          raw.push(message);
        }
      }
      if (edge.targetKind === "summary") {
        raw.push(...this.rawIdsForSummary(edge.targetId, seen));
      }
    }
    return raw;
  }
}
