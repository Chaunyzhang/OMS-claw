import type { RawRole, RawWriteInput, SourcePurpose } from "../types.js";
import { SecretScanner } from "./SecretScanner.js";
import { SourcePurposeClassifier } from "./SourcePurposeClassifier.js";
import { VisibilityGate } from "./VisibilityGate.js";

export interface IngestCandidate {
  sessionId: string;
  turnId?: string;
  turnIndex?: number;
  role: RawRole;
  text: string;
  eventType?: string;
  createdAt?: string;
  interrupted?: boolean;
  metadata?: Record<string, unknown>;
}

const RAW_MEMORY_SOURCE_PURPOSES = new Set<SourcePurpose>(["general_chat", "assistant_final_answer", "material_corpus"]);

export class IngestClassifier {
  private readonly visibility = new VisibilityGate();
  private readonly sourcePurpose = new SourcePurposeClassifier();
  private readonly secretScanner = new SecretScanner();

  classify(candidate: IngestCandidate): RawWriteInput | undefined {
    if (!this.visibility.isVisibleUserAssistant({ role: candidate.role, text: candidate.text, type: candidate.eventType })) {
      return undefined;
    }
    const classification = this.sourcePurpose.classify({
      role: candidate.role,
      text: candidate.text,
      metadata: candidate.metadata
    });
    const originalText = classification.materialText ?? candidate.text;
    const secretScan = this.secretScanner.scan(originalText);
    const secretDetected = secretScan.detected.length > 0;
    if (secretDetected || !classification.retrievalAllowed || !RAW_MEMORY_SOURCE_PURPOSES.has(classification.sourcePurpose)) {
      return undefined;
    }
    return {
      sessionId: candidate.sessionId,
      turnId: candidate.turnId,
      turnIndex: candidate.turnIndex,
      role: candidate.role,
      eventType: candidate.eventType ?? "created",
      originalText,
      createdAt: candidate.createdAt,
      sourceScope: classification.sourceScope,
      sourcePurpose: classification.sourcePurpose,
      sourceAuthority: classification.sourceAuthority,
      retrievalAllowed: classification.retrievalAllowed,
      evidenceAllowed: undefined,
      evidencePolicyMask: classification.evidencePolicyMask,
      caseId: classification.caseId,
      interrupted: candidate.interrupted,
      metadata: {
        ...(candidate.metadata ?? {}),
        secretScan
      }
    };
  }
}
