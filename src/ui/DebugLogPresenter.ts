import { EventStore } from "../storage/EventStore.js";
import { Logger } from "../core/Logger.js";
import type { DebugLogSnapshot } from "../types.js";

export class DebugLogPresenter {
  constructor(
    private readonly events: EventStore,
    private readonly logger: Logger
  ) {}

  present(): DebugLogSnapshot {
    return {
      logs: this.logger.recent(),
      events: this.events.recent(),
      visible: [
        "raw_write",
        "hook",
        "summary",
        "dag_trace",
        "tags",
        "compact",
        "git_export",
        "redaction",
        "retrieval",
        "why_not_found",
        "background_failure",
        "plugin_version"
      ]
    };
  }
}
