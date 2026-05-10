import { RawMessageStore } from "../storage/RawMessageStore.js";
import type { OmsConfig } from "../types.js";
import { ContextBridge } from "./ContextBridge.js";
import { OMS_MEMORY_REFLEX_PROMPT, OMS_RECALL_POLICY_PROMPT } from "./RecallPolicyPrompt.js";
import { hasDetectedSecrets } from "../ingest/SecretScanner.js";

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
    const recentTurns = this.rawMessages
      .recentCompleteTurns(this.config.agentId, input.sessionId, this.config.recentCompleteTurns)
      .filter((message) => message.retrievalAllowed && !hasDetectedSecrets(message.metadata));
    const messages = Array.isArray(input.messages) ? input.messages : [];
    const lines = [
      "## OMS OpenClaw Memory",
      OMS_RECALL_POLICY_PROMPT,
      OMS_MEMORY_REFLEX_PROMPT,
      "",
      "Use OMS naturally whenever prior memory may change the answer, not only when the user uses explicit memory words.",
      "If an OMS Preloaded Memory Evidence block is present, treat it as already-delivered raw memory evidence.",
      "Use oms_search as the first recall path for ordinary memory questions; it may route through timeline, summaries, FTS, vectors, or graph and return raw evidence.",
      "Use oms_expand_evidence when you only have a summary/raw id candidate and need an authoritative raw evidence packet.",
      "If authoritative raw evidence is not available, say no traceable authoritative raw evidence was found."
    ];

    const hasOmsTool =
      hasTool(input.availableTools, "oms_summary_search") ||
      hasTool(input.availableTools, "oms_expand_evidence") ||
      hasTool(input.availableTools, "oms_fts_search");
    if (hasOmsTool) {
      lines.push(
        "",
        "Available OMS path: decide whether memory matters, then call oms_search for ordinary recall; use oms_expand_evidence for summary/raw candidates that still need raw evidence."
      );
    } else {
      lines.push(
        "",
        "If OMS tool names are not visible in this session's tool list, report that OMS tools are unavailable in this session instead of claiming OMS is not installed or that no memory exists."
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
