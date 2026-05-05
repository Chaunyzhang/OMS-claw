export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  level: LogLevel;
  message: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

type LoggerSink = Partial<Record<LogLevel, (message: string, metadata?: Record<string, unknown>) => void>>;

export class Logger {
  private readonly entries: LogEntry[] = [];

  constructor(private readonly sink?: LoggerSink) {}

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.write("debug", message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.write("info", message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.write("warn", message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.write("error", message, metadata);
  }

  recent(limit = 100): LogEntry[] {
    return this.entries.slice(-limit);
  }

  private write(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    const entry = { level, message, createdAt: new Date().toISOString(), metadata };
    this.entries.push(entry);
    if (this.entries.length > 1000) {
      this.entries.splice(0, this.entries.length - 1000);
    }
    this.sink?.[level]?.(message, metadata ?? {});
  }
}
