import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";
import { TimelineExporter } from "../../src/git/TimelineExporter.js";
import { RawWriter } from "../../src/ingest/RawWriter.js";
import { EventStore } from "../../src/storage/EventStore.js";
import { RawMessageStore } from "../../src/storage/RawMessageStore.js";
import { SQLiteConnection } from "../../src/storage/SQLiteConnection.js";

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

function createSourceGitMd(root: string) {
  const connection = new SQLiteConnection(":memory:");
  const rawMessages = new RawMessageStore(connection.db);
  const events = new EventStore(connection.db);
  const writer = new RawWriter(rawMessages, events, "小白");
  const receipt = writer.write({
    sessionId: "source-session",
    turnId: "source-turn-1",
    turnIndex: 1,
    role: "user",
    createdAt: "2026-05-09T01:02:03.000Z",
    originalText: "Imported memory from Xiao Bai."
  });
  const raw = rawMessages.byId(receipt.messageId);
  if (!raw) {
    throw new Error("source_raw_missing");
  }
  const sourceAgentRoot = join(root, "xiao-bai");
  const sourceRepoPath = join(sourceAgentRoot, "gitmd");
  const exportResult = new TimelineExporter(events).export({ agentId: "小白", memoryRepoPath: sourceRepoPath, messages: [raw] });
  if (!exportResult.ok) {
    throw new Error(String(exportResult.reason));
  }
  connection.close();
  return { sourceAgentRoot, sourceRepoPath };
}

function createTarget(root: string) {
  return new OmsOrchestrator(
    createDefaultConfig({
      dbPath: ":memory:",
      baseDir: root,
      openclawConfigPath: join(root, "missing-openclaw.json"),
      agentId: "main",
      memoryRepoPath: join(root, "main", "gitmd")
    })
  );
}

describe("gitmd import", () => {
  it("previews a source GitMD brainpack without writing target raw", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-git-import-"));
    const { sourceRepoPath } = createSourceGitMd(dir);
    const target = createTarget(dir);

    try {
      const result = target.gitImportTool({ sourceRepoPath, mode: "preview" }) as {
        ok: boolean;
        mode: string;
        sourceAgentId: string;
        importable: number;
      };

      expect(result.ok).toBe(true);
      expect(result.mode).toBe("preview");
      expect(result.sourceAgentId).toBe("小白");
      expect(result.importable).toBe(1);
      expect(target.rawMessages.countForAgent("main")).toBe(0);
    } finally {
      target.connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("imports GitMD raw into the target agent with provenance and target GitMD mirroring", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-git-import-"));
    const { sourceAgentRoot } = createSourceGitMd(dir);
    const target = createTarget(dir);

    try {
      const result = target.gitImportTool({ sourceRepoPath: sourceAgentRoot, mode: "import" }) as {
        ok: boolean;
        imported: number;
        sourceAgentId: string;
      };
      const imported = target.rawMessages.allForAgent("main", 10);
      const markdownFiles = listFiles(join(dir, "main", "gitmd", "raw")).filter((path) => path.endsWith(".md"));

      expect(result.ok).toBe(true);
      expect(result.imported).toBe(1);
      expect(result.sourceAgentId).toBe("小白");
      expect(imported).toHaveLength(1);
      expect(imported[0].sourcePurpose).toBe("imported_timeline");
      expect(imported[0].metadata.import).toMatchObject({
        sourceAgentId: "小白",
        sourceSessionId: "source-session"
      });
      expect(markdownFiles).toHaveLength(1);
      expect(existsSync(markdownFiles[0])).toBe(true);
    } finally {
      target.connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips duplicate source messages by default and can record references", () => {
    const dir = mkdtempSync(join(tmpdir(), "oms-git-import-"));
    const { sourceRepoPath } = createSourceGitMd(dir);
    const target = createTarget(dir);

    try {
      const first = target.gitImportTool({ sourceRepoPath, mode: "import" }) as { imported: number };
      const second = target.gitImportTool({ sourceRepoPath, mode: "import" }) as { imported: number; skipped: number };
      const reference = target.gitImportTool({ sourceRepoPath, mode: "import", duplicatePolicy: "import_as_reference" }) as {
        imported: number;
        referenced: number;
      };
      const events = target.events.recent(20);

      expect(first.imported).toBe(1);
      expect(second.imported).toBe(0);
      expect(second.skipped).toBe(1);
      expect(reference.imported).toBe(0);
      expect(reference.referenced).toBe(1);
      expect(events.some((event) => event.eventType === "gitmd_import_reference")).toBe(true);
      expect(target.rawMessages.countForAgent("main")).toBe(1);
    } finally {
      target.connection.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
