import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import { SourceEdgeStore } from "../storage/SourceEdgeStore.js";

export interface CompactionPlan {
  ok: boolean;
  compacted: false;
  reason?: "compaction_preconditions_failed";
  blockers: string[];
}

export class CompactionPlanner {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly sourceEdges: SourceEdgeStore,
    private readonly events: EventStore
  ) {}

  check(input: { agentId: string; sessionId: string; turnId: string }): CompactionPlan {
    const blockers: string[] = [];
    const raw = this.rawMessages.messagesForTurn(input.turnId);
    if (raw.length === 0) {
      blockers.push("raw_messages_not_written");
    }
    const hasUser = raw.some((message) => message.role === "user");
    const hasAssistant = raw.some((message) => message.role === "assistant");
    if (!hasUser || !hasAssistant) {
      blockers.push("turn_boundary_incomplete");
    }
    if (raw.some((message) => !(message.metadata.secretScan as { ok?: boolean } | undefined)?.ok)) {
      blockers.push("sensitive_scan_incomplete");
    }
    const summaryEdges = raw.flatMap((message) => this.sourceEdges.toTarget("raw_message", message.messageId));
    if (summaryEdges.length < raw.length) {
      blockers.push("summary_source_edges_missing");
    }
    const recentEvents = this.events.recent(200);
    if (recentEvents.some((event) => event.eventType === "write_failed")) {
      blockers.push("pending_write_failure");
    }
    return blockers.length === 0
      ? { ok: true, compacted: false, blockers }
      : { ok: false, compacted: false, reason: "compaction_preconditions_failed", blockers };
  }
}
