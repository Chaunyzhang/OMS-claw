import type { EvidencePolicyRequest } from "../types.js";

export class QueryIntentClassifier {
  classify(query: string): EvidencePolicyRequest {
    if (/why.*wrong|diagnostic|\u4e3a\u4ec0\u4e48.*\u9519|\u4e0a\u6b21\u7b54\u9519|\u8bca\u65ad/iu.test(query)) {
      return "diagnostic_history";
    }
    if (/source_purpose\s*=\s*material_corpus|oms_capture|material_corpus|case[_\s-]?id/iu.test(query)) {
      return "material_evidence";
    }
    if (
      /previously promised|assistant said|\u4f60\u4e4b\u524d\u7b54\u5e94|\u4f60\u4e4b\u524d\u8bf4/iu.test(query)
    ) {
      return "assistant_history";
    }
    return "general_history";
  }
}
