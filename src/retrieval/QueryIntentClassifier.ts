import type { EvidencePolicyRequest } from "../types.js";

export class QueryIntentClassifier {
  classify(query: string): EvidencePolicyRequest {
    if (/\b(?:benchmark|formal|material|case)\b/iu.test(query)) {
      return "material_evidence";
    }
    if (/你之前答应|previously promised|assistant said/iu.test(query)) {
      return "assistant_history";
    }
    if (/why.*wrong|上次答错|diagnostic/iu.test(query)) {
      return "diagnostic_history";
    }
    return "general_history";
  }
}
