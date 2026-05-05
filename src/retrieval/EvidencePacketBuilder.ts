import { createHash, randomUUID } from "node:crypto";
import type { AuthorityReport, BuildInfo, EvidencePacket, RawMessage } from "../types.js";

export class EvidencePacketBuilder {
  build(input: {
    build: BuildInfo;
    status: EvidencePacket["status"];
    reason?: string;
    rawMessages: RawMessage[];
    authoritativeRawMessages: RawMessage[];
    summaryDerivedRawCount: number;
    sourceSummaryIds: string[];
    sourceEdgeIds: string[];
    authorityReport: AuthorityReport;
  }): EvidencePacket {
    const rawExcerptHash = `sha256:${createHash("sha256")
      .update(input.authoritativeRawMessages.map((message) => `${message.messageId}:${message.originalHash}:${message.originalText}`).join("\n"))
      .digest("hex")}`;
    return {
      packetId: `pkt_${randomUUID()}`,
      status: input.status,
      reason: input.reason,
      selectedAuthoritativeRawCount: input.authoritativeRawMessages.length,
      selectedRawCount: input.rawMessages.length,
      summaryDerivedRawCount: input.summaryDerivedRawCount,
      rawMessageIds: input.authoritativeRawMessages.map((message) => message.messageId),
      sourceSummaryIds: input.sourceSummaryIds,
      sourceEdgeIds: input.sourceEdgeIds,
      rawExcerptHash,
      rawExcerpts: input.authoritativeRawMessages.map((message) => ({
        messageId: message.messageId,
        role: message.role,
        createdAt: message.createdAt,
        sourcePurpose: message.sourcePurpose,
        sourceAuthority: message.sourceAuthority,
        turnIndex: message.turnIndex ?? -1,
        originalText: message.originalText
      })),
      authorityReport: input.authorityReport,
      deliveryReceipt: {
        deliveredToOpenClaw: input.status === "delivered",
        deliveredAt: new Date().toISOString(),
        build: input.build
      },
      answerInstruction:
        input.status === "delivered"
          ? "Answer only from the included raw excerpts. Summary text is navigation, not evidence."
          : "If this packet status is blocked or empty, do not answer from memory. Say: \"I did not find traceable raw evidence for that.\" 中文：请说：“我没有找到可回溯的原文记录。”"
    };
  }
}
