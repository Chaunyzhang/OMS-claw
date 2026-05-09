import { ConfigResolver } from "./ConfigResolver.js";
import { Logger } from "./Logger.js";
import { OmsOrchestrator, type RegistrationState } from "./OmsOrchestrator.js";

const DEFAULT_RUNTIME_AGENT_ID = "main";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function optionalString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseAgentIdFromSessionKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.match(/^agent:([^:]+)/u);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export class OmsRuntimeRegistry {
  private readonly orchestrators = new Map<string, OmsOrchestrator>();
  private readonly registration: Partial<RegistrationState> = {};

  constructor(
    private readonly pluginConfig: Record<string, unknown> = {},
    private readonly options: { loadedFromPath?: string; logger?: Logger } = {}
  ) {}

  markRegistered(partial: Partial<RegistrationState>): void {
    Object.assign(this.registration, partial);
    for (const orchestrator of this.orchestrators.values()) {
      orchestrator.markRegistered(partial);
    }
  }

  forContext(input: unknown = {}): OmsOrchestrator {
    const agentId = this.agentIdFrom(input);
    const config = ConfigResolver.resolve({ ...this.pluginConfig, agentId });
    const key = `${config.agentId}\u0000${config.dbPath}`;
    const existing = this.orchestrators.get(key);
    if (existing) {
      return existing;
    }

    const orchestrator = new OmsOrchestrator(config, {
      loadedFromPath: this.options.loadedFromPath,
      logger: this.options.logger
    });
    orchestrator.markRegistered(this.registration);
    this.orchestrators.set(key, orchestrator);
    return orchestrator;
  }

  activeOrchestrators(): OmsOrchestrator[] {
    return Array.from(this.orchestrators.values());
  }

  private agentIdFrom(input: unknown): string {
    const record = Array.isArray(input) ? asRecord(input[0]) : asRecord(input);
    const ctx = asRecord(record.ctx ?? record.context);
    const event = asRecord(record.event);
    const agent = asRecord(record.agent);
    const ctxAgent = asRecord(ctx.agent);
    const eventAgent = asRecord(event.agent);
    const session = asRecord(record.session);
    const ctxSession = asRecord(ctx.session);
    const eventSession = asRecord(event.session);

    return (
      optionalString(
        record.agentId,
        agent.id,
        agent.name,
        ctx.agentId,
        ctxAgent.id,
        ctxAgent.name,
        event.agentId,
        eventAgent.id,
        eventAgent.name,
        parseAgentIdFromSessionKey(record.sessionKey),
        parseAgentIdFromSessionKey(record.sessionId),
        parseAgentIdFromSessionKey(session.key),
        parseAgentIdFromSessionKey(session.id),
        parseAgentIdFromSessionKey(session.sessionKey),
        parseAgentIdFromSessionKey(ctx.sessionKey),
        parseAgentIdFromSessionKey(ctx.sessionId),
        parseAgentIdFromSessionKey(ctxSession.key),
        parseAgentIdFromSessionKey(ctxSession.id),
        parseAgentIdFromSessionKey(ctxSession.sessionKey),
        parseAgentIdFromSessionKey(event.sessionKey),
        parseAgentIdFromSessionKey(event.sessionId),
        parseAgentIdFromSessionKey(eventSession.key),
        parseAgentIdFromSessionKey(eventSession.id),
        parseAgentIdFromSessionKey(eventSession.sessionKey),
        this.pluginConfig.agentId
      ) ?? DEFAULT_RUNTIME_AGENT_ID
    );
  }
}
