import type { CandidateLaneResult } from "../../types.js";
import { RawMessageStore } from "../../storage/RawMessageStore.js";
import { isRecallMetaMessage } from "../RecallIntent.js";

export class TimelineLane {
  readonly lane = "timeline" as const;

  constructor(private readonly rawMessages: RawMessageStore) {}

  search(input: { agentId: string; limit?: number }): CandidateLaneResult {
    const started = Date.now();
    const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), 40);
    const scanLimit = Math.max(limit * 4, 80);
    const rows = this.rawMessages
      .recentForAgent(input.agentId, scanLimit)
      .filter((message) => message.retrievalAllowed && message.evidenceAllowed && !isRecallMetaMessage(message))
      .slice(0, limit);
    return {
      lane: this.lane,
      status: "ok",
      timingsMs: { total: Date.now() - started },
      candidates: rows.map((row, index) => ({
        targetKind: "raw",
        targetId: row.messageId,
        rawIdHint: row.messageId,
        rank: index + 1,
        score: 1 / (index + 1),
        reason: {
          timelineRecall: true,
          sequence: row.sequence,
          candidateOnly: true,
          evidenceRequired: true
        }
      }))
    };
  }
}
