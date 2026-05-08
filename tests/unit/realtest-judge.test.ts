import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexJudge } from "../../src/realtest/scripts/run-codex-judge.js";

describe("realtest judge", () => {
  it("rejects answers that include any forbidden phrase", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-judge-"));
    const previous = process.env.OMS_REALTEST_INTERNAL_JUDGE;
    process.env.OMS_REALTEST_INTERNAL_JUDGE = "1";
    try {
      writeFileSync(join(dir, "preflight.json"), `${JSON.stringify({ ok: true })}\n`, "utf8");
      writeFileSync(join(dir, "collector-report.json"), `${JSON.stringify({ ok: true })}\n`, "utf8");
      writeFileSync(join(dir, "transcript.jsonl"), "{}\n", "utf8");
      writeFileSync(join(dir, "final-answer.txt"), "The answer is 2022, last year.", "utf8");
      writeFileSync(
        join(dir, "judge-input.json"),
        `${JSON.stringify({
          caseId: "locomo_melanie_sunrise",
          answerKey: {
            expected: "2022",
            acceptable: ["2022", "in 2022"],
            forbidden: ["no record", "not found", "2023", "last year"]
          },
          transcriptFile: join(dir, "transcript.jsonl"),
          finalAnswerFile: join(dir, "final-answer.txt")
        })}\n`,
        "utf8"
      );

      const output = runCodexJudge({ bundleDir: dir });

      expect(output.answer_correct).toBe(false);
      expect(output.status).toBe("ANSWER_FAIL");
    } finally {
      if (previous === undefined) {
        delete process.env.OMS_REALTEST_INTERNAL_JUDGE;
      } else {
        process.env.OMS_REALTEST_INTERNAL_JUDGE = previous;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
