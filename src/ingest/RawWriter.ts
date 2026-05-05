import type { RawWriteInput, RawWriteReceipt } from "../types.js";
import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";

export class RawWriter {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly events: EventStore,
    private readonly agentId: string
  ) {}

  write(input: RawWriteInput): RawWriteReceipt {
    try {
      const receipt = this.rawMessages.write({ ...input, agentId: input.agentId ?? this.agentId });
      this.events.record({
        agentId: input.agentId ?? this.agentId,
        sessionId: input.sessionId,
        messageId: receipt.messageId,
        eventType: "created",
        payload: {
          originalHash: receipt.originalHash,
          sourcePurpose: receipt.sourcePurpose,
          sourceAuthority: receipt.sourceAuthority,
          retrievalAllowed: receipt.retrievalAllowed
        }
      });
      return receipt;
    } catch (error) {
      this.events.record({
        agentId: input.agentId ?? this.agentId,
        sessionId: input.sessionId,
        eventType: "write_failed",
        payload: {
          reason: error instanceof Error ? error.message : String(error)
        }
      });
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
        reason: "raw_write_not_confirmed"
      };
    }
  }
}
