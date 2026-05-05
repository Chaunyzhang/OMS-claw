import type { RawRole } from "../types.js";
import type { IngestCandidate } from "../ingest/IngestClassifier.js";

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && "text" in content) {
    return String((content as { text: unknown }).text);
  }
  return undefined;
}

export class PayloadNormalizer {
  normalize(input: unknown): IngestCandidate[] {
    if (!input || typeof input !== "object") {
      return [];
    }
    const value = input as Record<string, unknown>;
    const sessionId = String(value.sessionId ?? value.session_id ?? value.openclawSessionKey ?? "default-session");
    const turnId = value.turnId === undefined ? undefined : String(value.turnId);
    const turnIndex = value.turnIndex === undefined ? undefined : Number(value.turnIndex);

    if (Array.isArray(value.messages)) {
      return value.messages.flatMap((message, index) =>
        this.normalizeMessage(message, {
          sessionId,
          turnId,
          turnIndex: turnIndex ?? index + 1
        })
      );
    }

    return this.normalizeMessage(value, { sessionId, turnId, turnIndex });
  }

  private normalizeMessage(
    message: unknown,
    defaults: { sessionId: string; turnId?: string; turnIndex?: number }
  ): IngestCandidate[] {
    if (!message || typeof message !== "object") {
      return [];
    }
    const value = message as Record<string, unknown>;
    const role = value.role;
    if (role !== "user" && role !== "assistant") {
      return [];
    }
    const text = textFromContent(value.text ?? value.message ?? value.content);
    if (!text) {
      return [];
    }
    return [
      {
        sessionId: String(value.sessionId ?? value.session_id ?? defaults.sessionId),
        turnId: value.turnId === undefined ? defaults.turnId : String(value.turnId),
        turnIndex: value.turnIndex === undefined ? defaults.turnIndex : Number(value.turnIndex),
        role: role as RawRole,
        text,
        eventType: value.eventType === undefined ? undefined : String(value.eventType),
        createdAt: value.createdAt === undefined ? undefined : String(value.createdAt),
        interrupted: value.interrupted === true,
        metadata: { source: "openclaw_payload" }
      }
    ];
  }
}
