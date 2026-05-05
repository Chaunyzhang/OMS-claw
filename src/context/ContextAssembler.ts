import { RawMessageStore } from "../storage/RawMessageStore.js";
import type { OmsConfig } from "../types.js";
import { ContextBridge } from "./ContextBridge.js";
import { OMS_RECALL_POLICY_PROMPT } from "./RecallPolicyPrompt.js";

export class ContextAssembler {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly bridge: ContextBridge,
    private readonly config: OmsConfig
  ) {}

  assemble(input: { sessionId: string }) {
    const recentTurns = this.rawMessages.recentCompleteTurns(this.config.agentId, input.sessionId, this.config.recentCompleteTurns);
    return {
      prefix: "OMS OpenClaw memory context engine",
      recallPolicy: OMS_RECALL_POLICY_PROMPT,
      recentCompleteTurns: recentTurns.map((message) => ({
        role: message.role,
        originalText: message.originalText,
        turnIndex: message.turnIndex,
        sourcePurpose: message.sourcePurpose
      })),
      contextBridge: this.bridge.render(),
      longTermMemoryInjected: false,
      summaryTextIsNotEvidence: true
    };
  }
}
