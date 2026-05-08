import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import { SourceEdgeStore } from "../storage/SourceEdgeStore.js";
import { SummaryStore } from "../storage/SummaryStore.js";
import type { RawMessage, SummaryRecord } from "../types.js";

function makeSummaryText(messages: RawMessage[]): string {
  const joined = messages
    .map((message) => `${message.role}: ${message.originalText}`)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
  return joined.length > 360 ? `${joined.slice(0, 357)}...` : joined;
}

export class SummaryDagBuilder {
  constructor(
    private readonly summaries: SummaryStore,
    private readonly sourceEdges: SourceEdgeStore,
    private readonly rawMessages: RawMessageStore,
    private readonly events: EventStore
  ) {}

  buildLeafForTurn(input: { agentId: string; sessionId: string; turnId: string }): SummaryRecord {
    const messages = this.rawMessages.messagesForTurn(input.turnId);
    if (messages.length === 0) {
      this.events.record({
        agentId: input.agentId,
        sessionId: input.sessionId,
        eventType: "summary_failed",
        payload: { reason: "no_raw_messages_for_turn", turnId: input.turnId }
      });
      throw new Error("no_raw_messages_for_turn");
    }
    const sourceHash = SummaryStore.hashSources(messages.map((message) => `${message.messageId}:${message.originalHash}:${message.sequence}`));
    const existing = this.summaries.activeBySourceHash({
      agentId: input.agentId,
      sourceHash,
      nodeKind: "leaf"
    });
    if (existing) {
      return existing;
    }
    const summary = this.summaries.create({
      agentId: input.agentId,
      sessionId: input.sessionId,
      level: 0,
      nodeKind: "leaf",
      summaryText: makeSummaryText(messages),
      sourceHash,
      sourceMessageCount: messages.length,
      metadata: { turnId: input.turnId }
    });
    for (const message of messages) {
      this.sourceEdges.create({
        agentId: input.agentId,
        sourceKind: "summary",
        sourceId: summary.summaryId,
        targetKind: "raw_message",
        targetId: message.messageId,
        relation: "derived_from",
        sourceHash,
        targetHash: message.originalHash
      });
    }
    return summary;
  }

  buildRollup(input: { agentId: string; sessionId?: string; childSummaryIds: string[] }): SummaryRecord {
    const children = input.childSummaryIds.map((id) => this.summaries.byId(id));
    if (children.some((child) => child === undefined)) {
      throw new Error("rollup_child_summary_missing");
    }
    const summaries = children.filter((child): child is SummaryRecord => child !== undefined);
    const sourceHash = SummaryStore.hashSources(summaries.map((summary) => `${summary.summaryId}:${summary.sourceHash}`));
    const rollup = this.summaries.create({
      agentId: input.agentId,
      sessionId: input.sessionId,
      level: Math.max(...summaries.map((summary) => summary.level)) + 1,
      nodeKind: "rollup",
      summaryText: summaries.map((summary) => summary.summaryText).join("\n"),
      sourceHash,
      sourceMessageCount: summaries.reduce((total, summary) => total + summary.sourceMessageCount, 0),
      metadata: { childSummaryIds: input.childSummaryIds }
    });
    for (const child of summaries) {
      this.sourceEdges.create({
        agentId: input.agentId,
        sourceKind: "summary",
        sourceId: rollup.summaryId,
        targetKind: "summary",
        targetId: child.summaryId,
        relation: "rolls_up",
        sourceHash,
        targetHash: child.sourceHash
      });
    }
    return rollup;
  }
}
