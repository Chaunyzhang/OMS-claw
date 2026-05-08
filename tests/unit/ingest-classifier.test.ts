import { describe, expect, it } from "vitest";
import { IngestClassifier } from "../../src/ingest/IngestClassifier.js";
import { SourcePurposeClassifier } from "../../src/ingest/SourcePurposeClassifier.js";

describe("ingest classification", () => {
  it("marks material corpus envelopes as material evidence", () => {
    const result = new IngestClassifier().classify({
      sessionId: "s1",
      role: "user",
      text: "<!-- OMS_CAPTURE source_purpose=material_corpus case_id=locomo-001 evidence_policy=material_evidence -->\nraw fact"
    });

    expect(result?.sourcePurpose).toBe("material_corpus");
    expect(result?.sourceAuthority).toBe("original_user_supplied_material");
    expect(result?.evidencePolicyMask).toBe("material_evidence");
    expect(result?.retrievalAllowed).toBe(true);
    expect(result?.caseId).toBe("locomo-001");
  });

  it("stores only material body after an OMS_CAPTURE wrapper", () => {
    const result = new IngestClassifier().classify({
      sessionId: "s1",
      role: "user",
      text:
        "Sender (untrusted metadata)\noriginCwd=D:\\OMS-claw\n<!-- OMS_CAPTURE source_purpose=material_corpus case_id=locomo-001 evidence_policy=material_evidence -->\n[raw] Melanie painted in 2022."
    });

    expect(result?.sourcePurpose).toBe("material_corpus");
    expect(result?.originalText).toBe("[raw] Melanie painted in 2022.");
    expect(result?.originalText).not.toContain("Sender");
    expect(result?.originalText).not.toContain("OMS_CAPTURE");
  });

  it("blocks retrieval and evidence when secrets are detected", () => {
    const result = new IngestClassifier().classify({
      sessionId: "s1",
      role: "user",
      text: "password: hunter2 token=aaaaaaaaaaaaaaaaaaaaaaaa"
    });

    expect(result?.retrievalAllowed).toBe(false);
    expect(result?.evidenceAllowed).toBe(false);
    expect(result?.evidencePolicyMask).toBe("never_evidence");
    expect(result?.metadata?.secretScan).toMatchObject({ ok: false, reason: "secret_detected" });
  });

  it("keeps assistant storage receipts out of evidence", () => {
    const result = new SourcePurposeClassifier().classify({
      role: "assistant",
      text: "Chunk stored. I'll recall it when needed."
    });

    expect(result.sourcePurpose).toBe("assistant_storage_receipt");
    expect(result.sourceAuthority).toBe("non_evidence_interaction");
    expect(result.evidencePolicyMask).toBe("never_evidence");
    expect(result.retrievalAllowed).toBe(false);
  });

  it("keeps formal questions out of material evidence", () => {
    const result = new SourcePurposeClassifier().classify({
      role: "user",
      text: "Before answering, call OMS memory tools. Question: When?"
    });

    expect(result.sourcePurpose).toBe("formal_question");
    expect(result.evidencePolicyMask).toBe("debug_only");
    expect(result.retrievalAllowed).toBe(false);
  });
});
