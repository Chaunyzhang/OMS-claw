import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export class EventStore {
  constructor(private readonly db: DatabaseSync) {}

  record(input: {
    agentId: string;
    sessionId: string;
    messageId?: string;
    eventType: string;
    payload?: Record<string, unknown>;
  }): string {
    const eventId = `evt_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO message_events
          (event_id, agent_id, session_id, message_id, event_type, created_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        input.agentId,
        input.sessionId,
        input.messageId ?? null,
        input.eventType,
        new Date().toISOString(),
        JSON.stringify(input.payload ?? {})
      );
    return eventId;
  }

  recent(limit = 100): Array<{ eventType: string; createdAt: string; payload: Record<string, unknown> }> {
    return this.db
      .prepare(
        `SELECT event_type AS eventType, created_at AS createdAt, payload_json AS payloadJson
         FROM message_events
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit)
      .map((row) => {
        const value = row as { eventType: string; createdAt: string; payloadJson: string };
        return { eventType: value.eventType, createdAt: value.createdAt, payload: JSON.parse(value.payloadJson) };
      });
  }
}
