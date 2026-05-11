import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeResults } from "../../src/realtest/scripts/summarize-results.js";
import { writeJson } from "../../src/realtest/common.js";

describe("realtest batch summary", () => {
  it("aggregates verdicts, query traces, and sender timings into a compact summary", () => {
    const root = mkdtempSync(join(tmpdir(), "oms-realtest-summary-"));
    try {
      const runA = join(root, "001-case-a");
      const runB = join(root, "002-case-b");

      writeJson(join(runA, "run-plan.json"), { runId: "run-a", caseId: "case-a" });
      writeJson(join(runA, "verdict.json"), {
        status: "PASS",
        overallPass: true,
        answerCorrect: true,
        authoritativeEvidenceValid: true,
        runValid: true,
        failureReasons: []
      });
      writeJson(join(runA, "query-trace.json"), {
        ok: true,
        run: { mode: "high", query: "When did Melanie paint a sunrise?" },
        summary: {
          lanesUsed: ["fts_bm25", "summary_dag"],
          lanesDegraded: [],
          answerPolicy: "ready_for_openclaw",
          packetStatus: "delivered",
          candidateCount: 3
        }
      });
      writeJson(join(runA, "send-question.json"), { durationMs: 1200 });

      writeJson(join(runB, "run-plan.json"), { runId: "run-b", caseId: "case-b" });
      writeJson(join(runB, "verdict.json"), {
        status: "FAIL",
        overallPass: false,
        answerCorrect: false,
        authoritativeEvidenceValid: false,
        runValid: true,
        failureReasons: ["judge_overall_pass_false", "wrong_case_id"]
      });
      writeJson(join(runB, "query-trace.json"), {
        ok: true,
        run: { mode: "ultra", query: "Melanie sunrise" },
        summary: {
          lanesUsed: ["graph_cte"],
          lanesDegraded: [{ lane: "ann_vector", status: "blocked", error: "lane_disabled" }],
          answerPolicy: "must_not_answer_from_candidates",
          packetStatus: "blocked",
          candidateCount: 1
        }
      });
      writeJson(join(runB, "send-question.json"), { durationMs: 1800 });

      const summary = summarizeResults({ sourceRoot: root });

      expect(summary.totalRuns).toBe(2);
      expect(summary.passedRuns).toBe(1);
      expect(summary.failedRuns).toBe(1);
      expect(summary.passRate).toBe(50);
      expect(summary.averageQuestionDurationMs).toBe(1500);
      expect(summary.averageCandidateCount).toBe(2);
      expect(summary.answerPolicyCounts.ready_for_openclaw).toBe(1);
      expect(summary.answerPolicyCounts.must_not_answer_from_candidates).toBe(1);
      expect(summary.packetStatusCounts.delivered).toBe(1);
      expect(summary.packetStatusCounts.blocked).toBe(1);
      expect(summary.laneUsageCounts.fts_bm25).toBe(1);
      expect(summary.laneUsageCounts.graph_cte).toBe(1);
      expect(summary.degradedLaneCounts.ann_vector).toBe(1);
      expect(summary.failureReasonCounts.wrong_case_id).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
