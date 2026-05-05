import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildInfo } from "../generated/build-info.js";
import type { BuildInfo } from "../types.js";

export class RuntimeAttestation {
  constructor(private readonly loadedFromPath = buildInfo.loadedFromPath) {}

  current(): BuildInfo {
    return {
      ...buildInfo,
      loadedFromPath: this.loadedFromPath
    };
  }

  verifyDistBuildInfo(root = process.cwd()): { ok: boolean; build: BuildInfo; reason?: string } {
    const distPath = resolve(root, "dist", "build-info.json");
    if (!existsSync(distPath)) {
      return { ok: false, build: this.current(), reason: "build_info_json_missing" };
    }
    const parsed = JSON.parse(readFileSync(distPath, "utf8")) as BuildInfo;
    const current = this.current();
    const ok =
      parsed.commitSha === current.commitSha &&
      parsed.schemaVersion === current.schemaVersion &&
      parsed.toolSchemaHash === current.toolSchemaHash &&
      parsed.contextEngineId === current.contextEngineId &&
      parsed.buildTimestamp === current.buildTimestamp;
    return { ok, build: parsed, reason: ok ? undefined : "build_info_mismatch" };
  }
}
