import { EventStore } from "../storage/EventStore.js";
import { RawMessageStore } from "../storage/RawMessageStore.js";
import { SourceEdgeStore } from "../storage/SourceEdgeStore.js";
import { SummaryStore } from "../storage/SummaryStore.js";
import type { OmsConfig, RawMessage, SummaryRecord } from "../types.js";
import { hasDetectedSecrets } from "../ingest/SecretScanner.js";

interface SummaryDagConfig {
  freshRawMessages: number;
  leafChunkTokens: number;
  leafRollupMinFanout: number;
  rollupMinFanout: number;
  incrementalMaxDepth: number;
}

interface LeafChunk {
  messages: RawMessage[];
  rawTokensOutsideTail: number;
  threshold: number;
}

function configFromOms(config?: OmsConfig): SummaryDagConfig {
  return {
    freshRawMessages: Math.max(0, Math.floor(config?.summaryFreshRawMessages ?? 64)),
    leafChunkTokens: Math.max(1, Math.floor(config?.summaryLeafChunkTokens ?? 20000)),
    leafRollupMinFanout: Math.max(1, Math.floor(config?.summaryLeafRollupMinFanout ?? 8)),
    rollupMinFanout: Math.max(1, Math.floor(config?.summaryRollupMinFanout ?? 4)),
    incrementalMaxDepth: Math.max(0, Math.floor(config?.summaryIncrementalMaxDepth ?? 1))
  };
}

function makeSummaryText(messages: RawMessage[]): string {
  const joined = messages
    .map((message) => {
      const turn = message.turnId ? ` turn=${message.turnId}` : "";
      return `[seq=${message.sequence}${turn} role=${message.role}] ${summaryTextFor(message)}`;
    })
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
  return joined.length > 1200 ? `${joined.slice(0, 1197)}...` : joined;
}

function makeRollupText(children: SummaryRecord[]): string {
  const joined = children
    .map((summary) => `[summary=${summary.summaryId} level=${summary.level}] ${summary.summaryText}`)
    .join("\n")
    .replace(/\s+/gu, " ")
    .trim();
  return joined.length > 1600 ? `${joined.slice(0, 1597)}...` : joined;
}

function summaryTextFor(message: RawMessage): string {
  return hasDetectedSecrets(message.metadata) ? "[blocked: sensitive content]" : message.originalText;
}

export class SummaryDagBuilder {
  private readonly config: SummaryDagConfig;

  constructor(
    private readonly summaries: SummaryStore,
    private readonly sourceEdges: SourceEdgeStore,
    private readonly rawMessages: RawMessageStore,
    private readonly events: EventStore,
    config?: OmsConfig
  ) {
    this.config = configFromOms(config);
  }

  compactSession(input: { agentId: string; sessionId: string; force?: boolean }): {
    leaf?: SummaryRecord;
    rollups: SummaryRecord[];
    summarized: boolean;
    reason?: string;
    rawTokensOutsideTail: number;
  } {
    const leaf = this.buildLeafForSession(input);
    const rollups: SummaryRecord[] = [];
    for (let depth = 0; depth < this.config.incrementalMaxDepth; depth += 1) {
      const rollup = this.buildNextRollup({
        agentId: input.agentId,
        sessionId: input.sessionId,
        targetLevel: depth
      });
      if (!rollup) {
        break;
      }
      rollups.push(rollup);
    }
    const rawTokensOutsideTail = this.rawTokensOutsideFreshTail(input.agentId, input.sessionId);
    return {
      leaf,
      rollups,
      summarized: leaf !== undefined || rollups.length > 0,
      reason: leaf === undefined && rollups.length === 0 ? "below_leaf_compaction_threshold" : undefined,
      rawTokensOutsideTail
    };
  }

  buildLeafForSession(input: { agentId: string; sessionId: string; force?: boolean }): SummaryRecord | undefined {
    const chunk = this.selectOldestLeafChunk(input);
    if (chunk.messages.length === 0 || (!input.force && chunk.rawTokensOutsideTail < chunk.threshold)) {
      this.events.record({
        agentId: input.agentId,
        sessionId: input.sessionId,
        eventType: "summary_skipped",
        payload: {
          reason: "below_leaf_compaction_threshold",
          rawTokensOutsideTail: chunk.rawTokensOutsideTail,
          threshold: chunk.threshold,
          freshRawMessages: this.config.freshRawMessages
        }
      });
      return undefined;
    }

    const sourceHash = SummaryStore.hashSources(
      chunk.messages.map((message) => `${message.messageId}:${message.originalHash}:${message.sequence}`)
    );
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
      summaryText: makeSummaryText(chunk.messages),
      sourceHash,
      sourceMessageCount: chunk.messages.length,
      metadata: {
        strategy: "lossless_chunk_leaf",
        firstSequence: chunk.messages[0]?.sequence,
        lastSequence: chunk.messages[chunk.messages.length - 1]?.sequence,
        rawTokensOutsideTail: chunk.rawTokensOutsideTail,
        threshold: chunk.threshold,
        freshRawMessages: this.config.freshRawMessages
      }
    });
    for (const [index, message] of chunk.messages.entries()) {
      this.sourceEdges.create({
        agentId: input.agentId,
        sourceKind: "summary",
        sourceId: summary.summaryId,
        targetKind: "raw_message",
        targetId: message.messageId,
        relation: "derived_from",
        sourceHash,
        targetHash: message.originalHash,
        metadata: { ordinal: index, strategy: "lossless_chunk_leaf" }
      });
    }
    return summary;
  }

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
      metadata: { turnId: input.turnId, strategy: "manual_turn_leaf" }
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
    const existing = this.summaries.activeBySourceHash({
      agentId: input.agentId,
      sourceHash,
      nodeKind: "rollup"
    });
    if (existing) {
      return existing;
    }
    const rollup = this.summaries.create({
      agentId: input.agentId,
      sessionId: input.sessionId,
      level: Math.max(...summaries.map((summary) => summary.level)) + 1,
      nodeKind: "rollup",
      summaryText: makeRollupText(summaries),
      sourceHash,
      sourceMessageCount: summaries.reduce((total, summary) => total + summary.sourceMessageCount, 0),
      metadata: {
        strategy: "lossless_condensed_rollup",
        childSummaryIds: input.childSummaryIds
      }
    });
    for (const [index, child] of summaries.entries()) {
      this.sourceEdges.create({
        agentId: input.agentId,
        sourceKind: "summary",
        sourceId: rollup.summaryId,
        targetKind: "summary",
        targetId: child.summaryId,
        relation: "rolls_up",
        sourceHash,
        targetHash: child.sourceHash,
        metadata: { ordinal: index, strategy: "lossless_condensed_rollup" }
      });
    }
    this.summaries.markInactive(summaries.map((summary) => summary.summaryId));
    return rollup;
  }

  private buildNextRollup(input: { agentId: string; sessionId: string; targetLevel: number }): SummaryRecord | undefined {
    const fanout = input.targetLevel === 0 ? this.config.leafRollupMinFanout : this.config.rollupMinFanout;
    const children = this.summaries.activeForSessionLevel({
      agentId: input.agentId,
      sessionId: input.sessionId,
      level: input.targetLevel,
      limit: fanout
    });
    if (children.length < fanout) {
      return undefined;
    }
    return this.buildRollup({
      agentId: input.agentId,
      sessionId: input.sessionId,
      childSummaryIds: children.map((summary) => summary.summaryId)
    });
  }

  private selectOldestLeafChunk(input: { agentId: string; sessionId: string }): LeafChunk {
    const messages = this.rawMessages.allForSession(input.agentId, input.sessionId);
    const compactableEnd = Math.max(0, messages.length - this.config.freshRawMessages);
    const oldMessages = messages.slice(0, compactableEnd);
    const unsummarizedOldMessages = oldMessages.filter((message) => !this.hasLeafSummary(message.messageId));
    const rawTokensOutsideTail = unsummarizedOldMessages.reduce((total, message) => total + message.tokenCount, 0);
    const chunk: RawMessage[] = [];
    let chunkTokens = 0;
    let started = false;

    for (const message of oldMessages) {
      if (this.hasLeafSummary(message.messageId)) {
        if (started) {
          break;
        }
        continue;
      }
      started = true;
      if (chunk.length > 0 && chunkTokens + message.tokenCount > this.config.leafChunkTokens) {
        break;
      }
      chunk.push(message);
      chunkTokens += message.tokenCount;
      if (chunkTokens >= this.config.leafChunkTokens) {
        break;
      }
    }

    return { messages: chunk, rawTokensOutsideTail, threshold: this.config.leafChunkTokens };
  }

  private rawTokensOutsideFreshTail(agentId: string, sessionId: string): number {
    const messages = this.rawMessages.allForSession(agentId, sessionId);
    const compactableEnd = Math.max(0, messages.length - this.config.freshRawMessages);
    return messages
      .slice(0, compactableEnd)
      .filter((message) => !this.hasLeafSummary(message.messageId))
      .reduce((total, message) => total + message.tokenCount, 0);
  }

  private hasLeafSummary(messageId: string): boolean {
    return this.sourceEdges
      .toTarget("raw_message", messageId)
      .some((edge) => edge.sourceKind === "summary" && edge.relation === "derived_from" && this.summaries.byId(edge.sourceId)?.nodeKind === "leaf");
  }
}
