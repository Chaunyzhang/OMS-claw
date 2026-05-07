import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export class EventLogger {
  constructor(private readonly db: DatabaseSync) {}

  record(input: {
    agentId: string;
    sessionId?: string;
    eventType: string;
    severity?: "debug" | "info" | "warn" | "error";
    correlationId?: string;
    payload?: Record<string, unknown>;
  }): string {
    const eventId = `evt_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO oms_events (event_id, agent_id, session_id, event_type, severity, created_at, correlation_id, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        input.agentId,
        input.sessionId ?? null,
        input.eventType,
        input.severity ?? "info",
        new Date().toISOString(),
        input.correlationId ?? null,
        JSON.stringify(input.payload ?? {})
      );
    return eventId;
  }
}
