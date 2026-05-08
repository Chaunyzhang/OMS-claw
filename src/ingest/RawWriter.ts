import type { RawWriteInput, RawWriteReceipt } from "../types.js";
import { GitMdWriter } from "../git/GitMdWriter.js";
import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";

export class RawWriter {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly events: EventStore,
    private readonly agentId: string,
    private readonly gitMdWriter?: GitMdWriter
  ) {}

  write(input: RawWriteInput): RawWriteReceipt {
    let receipt: RawWriteReceipt;
    try {
      receipt = this.rawMessages.write({ ...input, agentId: input.agentId ?? this.agentId });
    } catch (error) {
      this.recordWriteFailure(input, error);
      return {
        ok: false,
        agentId: input.agentId ?? this.agentId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        messageId: "",
        originalHash: "",
        sequence: -1,
        sourcePurpose: input.sourcePurpose ?? "general_chat",
        sourceAuthority: input.sourceAuthority ?? "visible_transcript",
        retrievalAllowed: false,
        evidenceAllowed: false,
        reason: "raw_write_not_confirmed"
      };
    }

    try {
      this.events.record({
        agentId: input.agentId ?? this.agentId,
        sessionId: input.sessionId,
        messageId: receipt.messageId,
        eventType: "created",
        payload: {
          originalHash: receipt.originalHash,
          sourcePurpose: receipt.sourcePurpose,
          sourceAuthority: receipt.sourceAuthority,
          retrievalAllowed: receipt.retrievalAllowed,
          evidenceAllowed: receipt.evidenceAllowed
        }
      });
    } catch (error) {
      void error;
    }
    this.writeGitMd(receipt);
    return receipt;
  }

  private writeGitMd(receipt: RawWriteReceipt): void {
    if (!this.gitMdWriter || !receipt.ok || !receipt.messageId || !receipt.agentId) {
      return;
    }
    const raw = this.rawMessages.byId(receipt.messageId);
    if (!raw) {
      return;
    }
    try {
      const result = this.gitMdWriter.writeRaw({ agentId: receipt.agentId, message: raw });
      this.events.record({
        agentId: receipt.agentId,
        sessionId: receipt.sessionId ?? raw.sessionId,
        messageId: receipt.messageId,
        eventType: result.ok ? "gitmd_written" : "gitmd_write_failed",
        payload: result.ok
          ? { path: result.path, skipped: result.skipped, redacted: result.redacted }
          : { reason: result.reason, foundAgentId: "foundAgentId" in result ? result.foundAgentId : undefined }
      });
    } catch (error) {
      try {
        this.events.record({
          agentId: receipt.agentId,
          sessionId: receipt.sessionId ?? raw.sessionId,
          messageId: receipt.messageId,
          eventType: "gitmd_write_failed",
          payload: { reason: error instanceof Error ? error.message : String(error) }
        });
      } catch {
        // GitMD mirroring is best-effort after the raw ledger commit.
      }
    }
  }

  private recordWriteFailure(input: RawWriteInput, error: unknown): void {
    try {
      this.events.record({
        agentId: input.agentId ?? this.agentId,
        sessionId: input.sessionId,
        eventType: "write_failed",
        payload: {
          reason: error instanceof Error ? error.message : String(error)
        }
      });
    } catch {
      // Raw write failure reporting is best-effort; callers still receive the failed receipt.
    }
  }
}
