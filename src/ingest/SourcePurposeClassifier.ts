import type { EvidencePolicyMask, RawRole, SourceAuthority, SourcePurpose } from "../types.js";

export interface SourceClassification {
  sourcePurpose: SourcePurpose;
  sourceAuthority: SourceAuthority;
  evidencePolicyMask: EvidencePolicyMask;
  retrievalAllowed: boolean;
  caseId?: string;
  sourceScope: string;
}

const STORAGE_RECEIPT_PATTERNS = [
  /chunk stored/iu,
  /i'?ll recall it when needed/iu,
  /stored successfully/iu,
  /memory saved/iu,
  /transcript truncated/iu,
  /没有记录/u
];

const FORMAL_QUESTION_PATTERNS = [/before answering,\s*(?:call|search) oms/iu, /\bformal question\b/iu, /\bbenchmark\b/iu];

export class SourcePurposeClassifier {
  classify(input: { role: RawRole; text: string; metadata?: Record<string, unknown> }): SourceClassification {
    const envelope = this.parseEnvelope(input.text);
    if (envelope) {
      return {
        sourcePurpose: "material_corpus",
        sourceAuthority: "original_user_supplied_material",
        evidencePolicyMask: "material_evidence",
        retrievalAllowed: true,
        caseId: envelope.caseId,
        sourceScope: "case_pack"
      };
    }

    if (input.role === "assistant" && STORAGE_RECEIPT_PATTERNS.some((pattern) => pattern.test(input.text))) {
      return {
        sourcePurpose: "assistant_storage_receipt",
        sourceAuthority: "non_evidence_interaction",
        evidencePolicyMask: "never_evidence",
        retrievalAllowed: false,
        sourceScope: "agent"
      };
    }

    if (FORMAL_QUESTION_PATTERNS.some((pattern) => pattern.test(input.text))) {
      return {
        sourcePurpose: "formal_question",
        sourceAuthority: "non_evidence_interaction",
        evidencePolicyMask: "debug_only",
        retrievalAllowed: false,
        sourceScope: "agent"
      };
    }

    if (input.role === "assistant") {
      return {
        sourcePurpose: "assistant_final_answer",
        sourceAuthority: "assistant_visible_final",
        evidencePolicyMask: "assistant_history",
        retrievalAllowed: true,
        sourceScope: "agent"
      };
    }

    return {
      sourcePurpose: "general_chat",
      sourceAuthority: "visible_transcript",
      evidencePolicyMask: "general_history",
      retrievalAllowed: true,
      sourceScope: "agent"
    };
  }

  parseEnvelope(text: string): { caseId?: string } | undefined {
    const match = text.match(/<!--\s*OMS_CAPTURE\s+([^>]+?)\s*-->/u);
    if (!match) {
      return undefined;
    }
    const attrs = Object.fromEntries(
      match[1]
        .split(/\s+/u)
        .map((part) => part.split("="))
        .filter((parts): parts is [string, string] => parts.length === 2)
    );
    if (attrs.source_purpose !== "material_corpus" || attrs.evidence_policy !== "material_evidence") {
      return undefined;
    }
    return { caseId: attrs.case_id };
  }
}
