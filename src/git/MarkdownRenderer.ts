import type { RawMessage } from "../types.js";

export class MarkdownRenderer {
  render(message: RawMessage, text: string, redacted: boolean): string {
    return `---\nmessage_id: ${message.messageId}\nagent_id: ${message.agentId}\nsession_id: ${message.sessionId}\nturn_id: ${message.turnId ?? ""}\ntimestamp: ${message.createdAt}\nrole: ${message.role}\nevent_type: ${message.eventType}\nsource_purpose: ${message.sourcePurpose}\noriginal_hash: ${message.originalHash}\nredacted: ${redacted}\n---\n\n${text}\n`;
  }
}
