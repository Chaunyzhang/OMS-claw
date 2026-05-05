import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { assertSingleTurnMarkdown, ensureDir, isMain, parseArgs, resolveCommandInvocation, writeJson } from "../common.js";

class RealtestClient {
  readonly updateCounts: Record<string, number> = {};
  private readonly activeToolCalls = new Set<string>();
  private assistantText = "";
  private lastProgressAtMs = 0;
  private lastAssistantProgressAtMs = 0;

  async requestPermission(params: { options?: Array<{ optionId: string; kind?: string; name?: string }> }) {
    const option =
      params.options?.find((item) => /allow|approve|yes/iu.test(`${item.kind ?? ""} ${item.name ?? ""}`)) ??
      params.options?.[0];
    return option
      ? { outcome: { outcome: "selected", optionId: option.optionId } }
      : { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params: {
    update?: {
      sessionUpdate?: string;
      content?: { type?: string; text?: string };
      toolCallId?: string;
      status?: string;
    };
  }) {
    const kind = params.update?.sessionUpdate ?? "unknown";
    this.updateCounts[kind] = (this.updateCounts[kind] ?? 0) + 1;
    this.lastProgressAtMs = Date.now();

    if (kind === "agent_message_chunk" && params.update?.content?.type === "text") {
      this.assistantText += params.update.content.text ?? "";
      this.lastAssistantProgressAtMs = this.lastProgressAtMs;
    }
    if (kind === "tool_call" || kind === "tool_call_update") {
      const toolCallId = params.update?.toolCallId;
      if (toolCallId) {
        const status = params.update?.status;
        if (status === "completed" || status === "failed") {
          this.activeToolCalls.delete(toolCallId);
        } else {
          this.activeToolCalls.add(toolCallId);
        }
      }
    }
  }

  async writeTextFile() {
    return {};
  }

  async readTextFile() {
    return { content: "" };
  }

  async waitForTurnIdle(signal: AbortSignal, quietMs = 15000) {
    while (!signal.aborted) {
      const now = Date.now();
      if (
        this.assistantText.trim() &&
        this.activeToolCalls.size === 0 &&
        this.lastAssistantProgressAtMs > 0 &&
        now - this.lastAssistantProgressAtMs >= quietMs
      ) {
        return {
          stopReason: "end_turn",
          completionSource: "agent_message_idle_fallback",
          assistantPreview: this.assistantText.slice(0, 1000)
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("timeout");
  }
}

export async function sendOne(input: {
  caseFile: string;
  out: string;
  sessionKey: string;
  timeoutMs: number;
  resetSession?: boolean;
  tokenFile?: string;
  url?: string;
}) {
  const promptText = assertSingleTurnMarkdown(input.caseFile);
  ensureDir(input.out.replace(/[\\/][^\\/]+$/u, ""));
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const openclawArgs = ["acp", "--session", input.sessionKey, "--no-prefix-cwd", "--provenance", "meta+receipt"];
  if (input.resetSession) {
    openclawArgs.push("--reset-session");
  }
  if (input.tokenFile) {
    openclawArgs.push("--token-file", input.tokenFile);
  }
  if (input.url) {
    openclawArgs.push("--url", input.url);
  }

  const invocation = resolveCommandInvocation("openclaw", openclawArgs);
  const child = spawn(invocation.command, invocation.args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const stderrChunks: string[] = [];
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk.toString("utf8"));
  });

  const client = new RealtestClient();
  const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
  const connection = new acp.ClientSideConnection(() => client as never, stream);
  const timeout = AbortSignal.timeout(input.timeoutMs);
  let artifact: Record<string, unknown>;

  try {
    const initResult = await withAbort(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true
        },
        clientInfo: {
          name: "oms-realtest-acp-sender",
          version: "1.0.0"
        }
      }),
      timeout
    );
    const sessionResult = await withAbort(connection.newSession({ cwd: process.cwd(), mcpServers: [] }), timeout);
    const messageId = randomUUID();
    let promptResponse: Awaited<ReturnType<typeof connection.prompt>> | undefined;
    let promptRpcError: string | undefined;
    const promptSentAtMs = Date.now();
    void connection
      .prompt({
        sessionId: sessionResult.sessionId,
        messageId,
        prompt: [{ type: "text", text: promptText }]
      })
      .then(
        (result) => {
          promptResponse = result;
        },
        (error) => {
          promptRpcError = error instanceof Error ? error.message : String(error);
        }
      );
    const completion = await waitForOpenClawSessionDone({
      sessionKey: input.sessionKey,
      notBeforeMs: promptSentAtMs,
      signal: timeout
    });
    artifact = {
      ok: true,
      senderBoundary: "transport_only_no_transcript_no_judging",
      caseFile: input.caseFile,
      sessionKey: input.sessionKey,
      acpSessionId: sessionResult.sessionId,
      messageId,
      openclawCommand: invocation.displayCommand,
      stopReason: promptResponse?.stopReason ?? "end_turn",
      completionSource: completion.completionSource,
      userMessageId: promptResponse?.userMessageId ?? null,
      promptRpcState: promptResponse ? "resolved" : promptRpcError ? "rejected" : "pending_at_completion",
      promptRpcError,
      openclawSession: completion.session,
      durationMs: Date.now() - startedAtMs,
      startedAt,
      completedAt: new Date().toISOString(),
      initResult,
      updateCounts: client.updateCounts,
      stderrPreview: stderrChunks.join("").slice(0, 4000)
    };
  } catch (error) {
    artifact = {
      ok: false,
      senderBoundary: "transport_only_no_transcript_no_judging",
      caseFile: input.caseFile,
      sessionKey: input.sessionKey,
      openclawCommand: invocation.displayCommand,
      durationMs: Date.now() - startedAtMs,
      startedAt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      updateCounts: client.updateCounts,
      stderrPreview: stderrChunks.join("").slice(0, 4000)
    };
  } finally {
    await terminateChild(child);
  }

  writeJson(input.out, artifact);
  return artifact;
}

async function waitForOpenClawSessionDone(input: {
  sessionKey: string;
  notBeforeMs: number;
  signal: AbortSignal;
}): Promise<{ completionSource: "session_metadata_done"; session: Record<string, unknown> }> {
  const agentId = input.sessionKey.match(/^agent:([^:]+):/u)?.[1] ?? "main";
  const sessionsPath = join(homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
  while (!input.signal.aborted) {
    const entry = readSessionMetadata(sessionsPath, input.sessionKey);
    if (entry) {
      const status = typeof entry.status === "string" ? entry.status : undefined;
      const startedAt = typeof entry.startedAt === "number" ? entry.startedAt : Number(entry.startedAt ?? 0);
      if (startedAt >= input.notBeforeMs && status === "done") {
        return { completionSource: "session_metadata_done", session: entry };
      }
      if (startedAt >= input.notBeforeMs && (status === "error" || status === "failed" || entry.abortedLastRun === true)) {
        throw new Error(`OpenClaw session ended unsuccessfully: ${status ?? "aborted"}`);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("timeout");
}

function readSessionMetadata(path: string, sessionKey: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  try {
    const sessions = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    return sessions[sessionKey] ?? sessions[sessionKey.toLowerCase()];
  } catch {
    return undefined;
  }
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.once("exit", () => resolve());
      killer.once("error", () => resolve());
    });
    return;
  }
  child.kill();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new Error("timeout");
  }
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    })
  ]);
}

async function main() {
  const args = parseArgs();
  const caseFile = String(args["case-file"] ?? "");
  const out = String(args.out ?? "");
  const sessionKey = String(args["session-key"] ?? "");
  if (!caseFile || !out || !sessionKey) {
    throw new Error("--case-file, --out, and --session-key are required");
  }
  const artifact = await sendOne({
    caseFile,
    out,
    sessionKey,
    timeoutMs: Number(args["timeout-ms"] ?? 600000),
    resetSession: args["reset-session"] === true || args["reset-session"] === "true",
    tokenFile: args["token-file"] ? String(args["token-file"]) : undefined,
    url: args.url ? String(args.url) : undefined
  });
  console.log(JSON.stringify(artifact, null, 2));
  if (!artifact.ok) {
    process.exitCode = 3;
  }
}

if (isMain(import.meta.url)) {
  await main();
}
