import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type JsonObject = Record<string, unknown>;

export interface CommandInvocation {
  command: string;
  args: string[];
  displayCommand: string;
}

export function parseArgs(argv = process.argv.slice(2)): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export function readJson<T = JsonObject>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function sha256Text(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function hashDirectory(path: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(path)) {
    hash.update(file.replace(/\\/gu, "/"));
    hash.update(readFileSync(file));
  }
  return `sha256:${hash.digest("hex")}`;
}

export function listFiles(path: string): string[] {
  if (!existsSync(path)) {
    return [];
  }
  const entries = readdirSync(path).flatMap((entry) => {
    const full = join(path, entry);
    return statSync(full).isDirectory() ? listFiles(full) : [full];
  });
  return entries.sort((a, b) => a.localeCompare(b));
}

export function runCommand(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; input?: string } = {}) {
  const startedAt = Date.now();
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 60000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
  return {
    command: invocation.displayCommand,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - startedAt,
    error: result.error?.message
  };
}

export function commandText(command: string, args: string[], options: { cwd?: string; timeoutMs?: number; input?: string } = {}): string {
  const invocation = resolveCommandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd ?? process.cwd(),
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs ?? 60000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    throw new Error(`command_failed:${invocation.displayCommand}:${result.stderr ?? result.error?.message ?? ""}`);
  }
  return result.stdout ?? "";
}

export function resolveCommandInvocation(command: string, args: string[]): CommandInvocation {
  const resolved = resolveCommand(command);
  const displayCommand = [resolved, ...args].join(" ");
  if (process.platform === "win32" && /\.(cmd|bat)$/iu.test(resolved)) {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", resolved, ...args],
      displayCommand
    };
  }
  return { command: resolved, args, displayCommand };
}

export function resolveCommand(command: string): string {
  if (process.platform !== "win32" || /[\\/]/u.test(command) || extname(command)) {
    return command;
  }
  const where = spawnSync("where.exe", [command], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (where.status !== 0) {
    return command;
  }
  const candidates = where.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return candidates.find((candidate) => /\.(cmd|exe)$/iu.test(candidate)) ?? candidates[0] ?? command;
}


export function assertSingleTurnMarkdown(path: string): string {
  const text = readFileSync(path, "utf8");
  const turnHeadings = text.match(/^## Turn \d+\s*$/gmu) ?? [];
  if (turnHeadings.length !== 1 || !/^## Turn 1\s*$/u.test(turnHeadings[0])) {
    throw new Error(`case_file_must_contain_exactly_one_turn:${basename(path)}`);
  }
  return text;
}

export function makeRunId(caseId: string, date = new Date()): string {
  return `${date.toISOString().replace(/[:.]/gu, "").toLowerCase()}-${caseId}`;
}

export function makeSessionKey(input: { agent: string; runId: string; caseId: string; suffix: string }): string {
  return `agent:${input.agent}:realtest:${input.runId}:${input.caseId}:${input.suffix}`.toLowerCase();
}

export function isMain(importMetaUrl: string): boolean {
  return importMetaUrl === pathToFileURL(process.argv[1] ?? "").href;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}
