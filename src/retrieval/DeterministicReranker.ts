import type { FusionCandidate, RawMessage } from "../types.js";

function terms(query: string): string[] {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .filter((term) => term.length > 1);
}

export class DeterministicReranker {
  rerank(input: { query: string; candidates: FusionCandidate[]; rawMessages: RawMessage[] }): FusionCandidate[] {
    const queryTerms = terms(input.query);
    const rawById = new Map(input.rawMessages.map((raw) => [raw.messageId, raw]));
    return input.candidates
      .map((candidate) => {
        const raw = rawById.get(candidate.rawId);
        if (!raw) {
          return { candidate, boost: -1 };
        }
        const text = raw.normalizedText;
        const exactMatches = queryTerms.filter((term) => text.includes(term)).length;
        const dateOrPathMatches = queryTerms.filter((term) => /(?:\d{4}|[./:-])/u.test(term) && text.includes(term)).length;
        const authorityBoost =
          raw.sourceAuthority === "original_user_supplied_material" || raw.sourceAuthority === "authoritative_material" ? 0.03 : 0;
        const correctionBoost = /\bcorrection\s*:/u.test(text) ? 0.04 : 0;
        const recencyBoost = Math.min(Math.max(raw.sequence, 0), 100000) * 0.000000001;
        const nonEvidencePenalty = raw.evidenceAllowed && raw.retrievalAllowed ? 0 : -0.1;
        return {
          candidate,
          boost: exactMatches * 0.01 + dateOrPathMatches * 0.02 + authorityBoost + correctionBoost + recencyBoost + nonEvidencePenalty
        };
      })
      .sort((a, b) => b.candidate.fusedScore + b.boost - (a.candidate.fusedScore + a.boost))
      .map((item, index) => ({
        ...item.candidate,
        fusedRank: index + 1,
        fusedScore: item.candidate.fusedScore + item.boost,
        reason: { ...(item.candidate.reason ?? {}), deterministicRerank: true }
      }));
  }
}
