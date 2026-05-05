import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { RawMessage, RawWriteInput, RawWriteReceipt } from "../types.js";

function normalizeText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function countApproxTokens(text: string): number {
  const words = normalizeText(text).split(/\s+/u).filter(Boolean);
  return Math.max(1, Math.ceil(words.length * 1.25));
}

function hashOriginal(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function mapRaw(row: Record<string, unknown>): RawMessage {
  return {
    messageId: String(row.message_id),
    agentId: String(row.agent_id),
    sessionId: String(row.session_id),
    turnId: row.turn_id === null ? undefined : String(row.turn_id),
    role: row.role as RawMessage["role"],
    eventType: String(row.event_type),
    createdAt: String(row.created_at),
    sequence: Number(row.sequence),
    originalText: String(row.original_text),
    normalizedText: String(row.normalized_text),
    tokenCount: Number(row.token_count),
    originalHash: String(row.original_hash),
    visibleToUser: Number(row.visible_to_user) === 1,
    interrupted: Number(row.interrupted) === 1,
    sourceScope: String(row.source_scope),
    sourcePurpose: row.source_purpose as RawMessage["sourcePurpose"],
    sourceAuthority: row.source_authority as RawMessage["sourceAuthority"],
    retrievalAllowed: Number(row.retrieval_allowed) === 1,
    evidencePolicyMask: row.evidence_policy_mask as RawMessage["evidencePolicyMask"],
    caseId: row.case_id === null ? undefined : String(row.case_id),
    parentMessageId: row.parent_message_id === null ? undefined : String(row.parent_message_id),
    metadata: JSON.parse(String(row.metadata_json ?? "{}")) as Record<string, unknown>,
    turnIndex: row.turn_index === null || row.turn_index === undefined ? undefined : Number(row.turn_index)
  };
}

export class RawMessageStore {
  constructor(private readonly db: DatabaseSync) {}

  ensureSession(input: { agentId: string; sessionId: string; caseId?: string; metadata?: Record<string, unknown> }): void {
    this.db
      .prepare(
        `INSERT INTO agents (agent_id, created_at, display_name, config_json, status)
         VALUES (?, ?, ?, '{}', 'active')
         ON CONFLICT(agent_id) DO NOTHING`
      )
      .run(input.agentId, new Date().toISOString(), input.agentId);
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, agent_id, started_at, source_kind, case_id, metadata_json)
         VALUES (?, ?, ?, 'chat', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET case_id=COALESCE(excluded.case_id, sessions.case_id)`
      )
      .run(input.sessionId, input.agentId, new Date().toISOString(), input.caseId ?? null, JSON.stringify(input.metadata ?? {}));
  }

  ensureTurn(input: { agentId: string; sessionId: string; turnId: string; turnIndex: number; metadata?: Record<string, unknown> }): void {
    this.db
      .prepare(
        `INSERT INTO turns (turn_id, agent_id, session_id, turn_index, created_at, status, metadata_json)
         VALUES (?, ?, ?, ?, ?, 'complete', ?)
         ON CONFLICT(session_id, turn_index) DO NOTHING`
      )
      .run(input.turnId, input.agentId, input.sessionId, input.turnIndex, new Date().toISOString(), JSON.stringify(input.metadata ?? {}));
  }

  write(input: RawWriteInput & { agentId: string }): RawWriteReceipt {
    const messageId = `raw_${randomUUID()}`;
    const sequence = input.sequence ?? this.nextSequence(input.agentId);
    const normalizedText = normalizeText(input.originalText);
    const originalHash = hashOriginal(input.originalText);
    const createdAt = input.createdAt ?? new Date().toISOString();
    const turnId = input.turnId ?? `turn_${input.sessionId}_${input.turnIndex ?? sequence}`;
    const turnIndex = input.turnIndex ?? sequence;

    this.ensureSession({ agentId: input.agentId, sessionId: input.sessionId, caseId: input.caseId });
    this.ensureTurn({ agentId: input.agentId, sessionId: input.sessionId, turnId, turnIndex });

    this.db
      .prepare(
        `INSERT INTO raw_messages (
          message_id, agent_id, session_id, turn_id, role, event_type, created_at, sequence,
          original_text, normalized_text, token_count, original_hash, visible_to_user, interrupted,
          source_scope, source_purpose, source_authority, retrieval_allowed, evidence_policy_mask,
          case_id, parent_message_id, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        messageId,
        input.agentId,
        input.sessionId,
        turnId,
        input.role,
        input.eventType ?? "created",
        createdAt,
        sequence,
        input.originalText,
        normalizedText,
        countApproxTokens(input.originalText),
        originalHash,
        input.interrupted === true ? 1 : 0,
        input.sourceScope ?? "agent",
        input.sourcePurpose ?? "general_chat",
        input.sourceAuthority ?? "visible_transcript",
        input.retrievalAllowed === false ? 0 : 1,
        input.evidencePolicyMask ?? "general_history",
        input.caseId ?? null,
        input.parentMessageId ?? null,
        JSON.stringify(input.metadata ?? {})
      );

    const rowId = (this.db.prepare("SELECT rowid FROM raw_messages WHERE message_id = ?").get(messageId) as { rowid: number }).rowid;

    this.db
      .prepare(
        `INSERT INTO raw_messages_fts (rowid, message_id, agent_id, session_id, role, normalized_text)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(rowId, messageId, input.agentId, input.sessionId, input.role, normalizedText);

    this.updateTurnMessage(turnId, input.role, messageId);

    return {
      ok: true,
      agentId: input.agentId,
      sessionId: input.sessionId,
      turnId,
      messageId,
      originalHash,
      sequence,
      sourcePurpose: input.sourcePurpose ?? "general_chat",
      sourceAuthority: input.sourceAuthority ?? "visible_transcript",
      retrievalAllowed: input.retrievalAllowed !== false
    };
  }

  byId(messageId: string): RawMessage | undefined {
    const row = this.db
      .prepare(
        `SELECT rm.*, t.turn_index
         FROM raw_messages rm
         LEFT JOIN turns t ON t.turn_id = rm.turn_id
         WHERE rm.message_id = ?`
      )
      .get(messageId) as Record<string, unknown> | undefined;
    return row ? mapRaw(row) : undefined;
  }

  byIds(messageIds: string[]): RawMessage[] {
    return messageIds.map((id) => this.byId(id)).filter((item): item is RawMessage => item !== undefined);
  }

  recentCompleteTurns(agentId: string, sessionId: string, limit: number): RawMessage[] {
    return this.db
      .prepare(
        `SELECT rm.*, t.turn_index
         FROM raw_messages rm
         JOIN turns t ON t.turn_id = rm.turn_id
         WHERE rm.agent_id = ? AND rm.session_id = ?
         ORDER BY t.turn_index DESC, rm.sequence ASC
         LIMIT ?`
      )
      .all(agentId, sessionId, Math.max(1, limit * 2))
      .map((row) => mapRaw(row as Record<string, unknown>))
      .sort((a, b) => a.sequence - b.sequence);
  }

  messagesForTurn(turnId: string): RawMessage[] {
    return this.db
      .prepare(
        `SELECT rm.*, t.turn_index
         FROM raw_messages rm
         LEFT JOIN turns t ON t.turn_id = rm.turn_id
         WHERE rm.turn_id = ?
         ORDER BY rm.sequence ASC`
      )
      .all(turnId)
      .map((row) => mapRaw(row as Record<string, unknown>));
  }

  allForAgent(agentId: string, limit = 200): RawMessage[] {
    return this.db
      .prepare(
        `SELECT rm.*, t.turn_index
         FROM raw_messages rm
         LEFT JOIN turns t ON t.turn_id = rm.turn_id
         WHERE rm.agent_id = ?
         ORDER BY rm.sequence ASC
         LIMIT ?`
      )
      .all(agentId, limit)
      .map((row) => mapRaw(row as Record<string, unknown>));
  }

  count(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM raw_messages").get() as { count: number }).count);
  }

  private nextSequence(agentId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM raw_messages WHERE agent_id = ?").get(agentId) as {
      next: number;
    };
    return Number(row.next);
  }

  private updateTurnMessage(turnId: string, role: "user" | "assistant", messageId: string): void {
    const column = role === "user" ? "user_message_id" : "assistant_message_id";
    this.db.prepare(`UPDATE turns SET ${column} = ? WHERE turn_id = ?`).run(messageId, turnId);
  }
}
