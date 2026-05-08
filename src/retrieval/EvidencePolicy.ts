import type { AuthorityReport, EvidencePolicyRequest, RawMessage } from "../types.js";
import { hasDetectedSecrets } from "../ingest/SecretScanner.js";

export class EvidencePolicy {
  verify(
    rawMessages: RawMessage[],
    expectedPolicy: EvidencePolicyRequest,
    caseId?: string
  ): AuthorityReport {
    const blockedReasons: AuthorityReport["blockedReasons"] = [];
    const authoritative = rawMessages.filter((message) => {
      const reason = this.blockReason(message, expectedPolicy, caseId);
      if (reason) {
        blockedReasons.push({ messageId: message.messageId, reason });
        return false;
      }
      return true;
    });
    return {
      ok: authoritative.length > 0,
      expectedPolicy,
      totalRawCount: rawMessages.length,
      authoritativeRawCount: authoritative.length,
      blockedRawCount: rawMessages.length - authoritative.length,
      blockedReasons
    };
  }

  filter(rawMessages: RawMessage[], expectedPolicy: EvidencePolicyRequest, caseId?: string): RawMessage[] {
    return rawMessages.filter((message) => this.blockReason(message, expectedPolicy, caseId) === undefined);
  }

  private blockReason(
    message: RawMessage,
    expectedPolicy: EvidencePolicyRequest,
    caseId?: string
  ): AuthorityReport["blockedReasons"][number]["reason"] | undefined {
    if (hasDetectedSecrets(message.metadata)) {
      return "secret_detected";
    }
    if (!message.retrievalAllowed) {
      return "retrieval_not_allowed";
    }
    if (message.evidenceAllowed === false) {
      return "wrong_source_purpose";
    }
    if (caseId && message.caseId !== caseId) {
      return "wrong_case_id";
    }
    if (message.sourcePurpose === "assistant_storage_receipt") {
      return "assistant_storage_receipt";
    }
    if (message.sourcePurpose === "formal_question") {
      return "formal_question";
    }
    if (expectedPolicy !== "diagnostic_history" && message.sourcePurpose === "diagnostic") {
      return "diagnostic_not_allowed";
    }

    if (expectedPolicy === "material_evidence") {
      if (message.sourcePurpose !== "material_corpus" || message.evidencePolicyMask !== "material_evidence") {
        return "wrong_source_purpose";
      }
      if (message.sourceAuthority !== "original_user_supplied_material" && message.sourceAuthority !== "authoritative_material") {
        return "wrong_source_authority";
      }
      return undefined;
    }

    if (expectedPolicy === "assistant_history") {
      if (
        message.role !== "assistant" ||
        (message.sourceAuthority !== "assistant_visible_final" && message.sourceAuthority !== "assistant_visible")
      ) {
        return "wrong_source_authority";
      }
      return undefined;
    }

    if (expectedPolicy === "diagnostic_history") {
      if (message.sourcePurpose !== "diagnostic" || message.sourceAuthority !== "diagnostic_explanation") {
        return "wrong_source_purpose";
      }
      return undefined;
    }

    if (message.evidencePolicyMask === "never_evidence" || message.evidencePolicyMask === "debug_only") {
      return "wrong_source_purpose";
    }
    return undefined;
  }
}
