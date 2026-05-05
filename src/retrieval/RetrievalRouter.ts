import type { EvidencePolicyRequest, OmsMode } from "../types.js";
import { EvidenceExpander } from "./EvidenceExpander.js";
import { FtsSearch } from "./FtsSearch.js";
import { SummarySearch } from "./SummarySearch.js";

export class RetrievalRouter {
  constructor(
    private readonly summaries: SummarySearch,
    private readonly fts: FtsSearch,
    private readonly expander: EvidenceExpander
  ) {}

  retrieve(input: {
    agentId: string;
    query: string;
    mode: OmsMode;
    evidencePolicy?: EvidencePolicyRequest;
    caseId?: string;
  }) {
    if (input.mode === "low") {
      return {
        mode: "low",
        rawHits: this.fts.search({
          agentId: input.agentId,
          query: input.query,
          evidencePolicy: input.evidencePolicy,
          caseId: input.caseId
        })
      };
    }

    const navigationHits = this.summaries.search(input.agentId, input.query);
    const expandedEvidencePackets = navigationHits.map((hit) =>
      this.expander.expand({
        summaryId: hit.summaryId,
        query: input.query,
        mode: input.mode,
        evidencePolicy: input.evidencePolicy,
        caseId: input.caseId
      })
    );
    const fallbackRawFtsHits =
      expandedEvidencePackets.some((packet) => packet.status === "delivered")
        ? []
        : this.fts.search({
            agentId: input.agentId,
            query: input.query,
            evidencePolicy: input.evidencePolicy,
            caseId: input.caseId
          });
    return {
      mode: input.mode,
      navigationHits,
      expandedEvidencePackets,
      fallbackRawFtsHits
    };
  }
}
