import { describe, expect, it } from "vitest";
import { QueryIntentClassifier } from "../../src/retrieval/QueryIntentClassifier.js";
import { isProactiveRecallQuery, isTimelineRecallQuery } from "../../src/retrieval/RecallIntent.js";

describe("query intent classifier", () => {
  const classifier = new QueryIntentClassifier();

  it("defaults ordinary prior conversation recall to general history", () => {
    expect(classifier.classify("retrieve the first five messages from our chat")).toBe("general_history");
    expect(classifier.classify("formal memory test: what did I say first?")).toBe("general_history");
    expect(classifier.classify("benchmark check: what were the first turns?")).toBe("general_history");
  });

  it("uses material evidence only for explicit material corpus signals", () => {
    expect(classifier.classify("OMS_CAPTURE source_purpose=material_corpus case_id=demo-001")).toBe("material_evidence");
  });

  it("detects recall queries that should be preloaded before model response", () => {
    expect(isProactiveRecallQuery("what did we decide last time?")).toBe(true);
    expect(isProactiveRecallQuery("\u4e4b\u524d\u6211\u4eec\u804a\u4e86\u4ec0\u4e48")).toBe(true);
    expect(isTimelineRecallQuery("\u4e4b\u524d\u6211\u4eec\u804a\u4e86\u4ec0\u4e48")).toBe(true);
    expect(isProactiveRecallQuery("write a new sorting function")).toBe(false);
  });
});
