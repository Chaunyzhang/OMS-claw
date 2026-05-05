import { describe, expect, it } from "vitest";
import { EvidencePolicy } from "../../src/retrieval/EvidencePolicy.js";
import type { RawMessage } from "../../src/types.js";

function raw(overrides: Partial<RawMessage>): RawMessage {
  return {
    messageId: "raw-1",
    agentId: "agent",
    sessionId: "session",
    role: "user",
    eventType: "created",
    createdAt: "2026-05-05T00:00:00.000Z",
    sequence: 1,
    originalText: "text",
    normalizedText: "text",
    tokenCount: 1,
    originalHash: "sha256:x",
    visibleToUser: true,
    interrupted: false,
    sourceScope: "agent",
    sourcePurpose: "general_chat",
    sourceAuthority: "visible_transcript",
    retrievalAllowed: true,
    evidencePolicyMask: "general_history",
    metadata: {},
    ...overrides
  };
}

describe("evidence policy", () => {
  it("accepts only material corpus for material evidence", () => {
    const policy = new EvidencePolicy();
    const report = policy.verify(
      [
        raw({
          messageId: "material",
          sourcePurpose: "material_corpus",
          sourceAuthority: "original_user_supplied_material",
          evidencePolicyMask: "material_evidence",
          caseId: "case-1"
        }),
        raw({
          messageId: "formal",
          sourcePurpose: "formal_question",
          sourceAuthority: "non_evidence_interaction",
          evidencePolicyMask: "debug_only",
          retrievalAllowed: false,
          caseId: "case-1"
        })
      ],
      "material_evidence",
      "case-1"
    );

    expect(report.ok).toBe(true);
    expect(report.authoritativeRawCount).toBe(1);
    expect(report.blockedReasons).toContainEqual({ messageId: "formal", reason: "retrieval_not_allowed" });
  });
});
