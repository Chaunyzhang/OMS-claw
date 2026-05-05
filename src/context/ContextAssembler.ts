import { RawMessageStore } from "../storage/RawMessageStore.js";
import type { OmsConfig } from "../types.js";
import { ContextBridge } from "./ContextBridge.js";
import { OMS_RECALL_POLICY_PROMPT } from "./RecallPolicyPrompt.js";

interface AssembleInput {
  sessionId: string;
  messages?: unknown[];
  availableTools?: Set<string> | string[];
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function estimateMessagesTokens(messages: unknown[]): number {
  return messages.reduce<number>((total, message) => total + estimateTokens(JSON.stringify(message)), 0);
}

function hasTool(availableTools: AssembleInput["availableTools"], name: string): boolean {
  if (!availableTools) {
    return false;
  }
  if (availableTools instanceof Set) {
    return availableTools.has(name);
  }
  return availableTools.includes(name);
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

export class ContextAssembler {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly bridge: ContextBridge,
    private readonly config: OmsConfig
  ) {}

  assemble(input: AssembleInput) {
    const recentTurns = this.rawMessages.recentCompleteTurns(this.config.agentId, input.sessionId, this.config.recentCompleteTurns);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const lines = [
      "## OMS OpenClaw Memory",
      OMS_RECALL_POLICY_PROMPT,
      "",
      "Use OMS tools before answering questions about prior conversation facts, dates, people, corrections, or formal memory tests.",
      "For formal memory tests, call oms_summary_search first with the exact question text, then call oms_expand_evidence on a summary hit before answering.",
      "Do not answer from oms_fts_search alone in formal memory tests; FTS is only a fallback when summary navigation is empty.",
      "If authoritative raw evidence is not available, say no traceable authoritative raw evidence was found."
    ];

    const hasOmsTool =
      hasTool(input.availableTools, "oms_summary_search") ||
      hasTool(input.availableTools, "oms_expand_evidence") ||
      hasTool(input.availableTools, "oms_fts_search");
    if (hasOmsTool) {
      lines.push(
        "",
        "Available OMS path: oms_summary_search -> oms_expand_evidence is the required path for formal memory tests; oms_fts_search is fallback only after summary navigation is empty."
      );
    }

    if (recentTurns.length > 0) {
      lines.push("", "Recent complete OMS turns:");
      for (const message of recentTurns.slice(-Math.max(1, this.config.recentCompleteTurns * 2))) {
        const turn = message.turnIndex === undefined ? "?" : String(message.turnIndex);
        lines.push(`- turn ${turn} ${message.role} (${message.sourcePurpose}): ${truncate(message.originalText, 700)}`);
      }
    }

    const bridgeText = this.bridge.render();
    if (bridgeText) {
      lines.push("", "Context bridge:", bridgeText);
    }

    const systemPromptAddition = lines.join("\n");
    return {
      messages,
      estimatedTokens: estimateMessagesTokens(messages) + estimateTokens(systemPromptAddition),
      systemPromptAddition
    };
  }
}
