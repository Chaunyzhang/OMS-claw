import { readFileSync } from "node:fs";
import type { RawWriteInput } from "../types.js";

export class RebuildImporter {
  parseMarkdown(filePath: string): RawWriteInput[] {
    const text = readFileSync(filePath, "utf8");
    const entries = text.split(/^---$/gmu).filter((part) => part.trim().length > 0);
    const parsed: RawWriteInput[] = [];
    for (let index = 0; index < entries.length - 1; index += 2) {
      const header = entries[index].trim();
      const body = entries[index + 1].trimStart();
      const fields = Object.fromEntries(
        header
          .split(/\r?\n/u)
          .map((line) => {
            const [key, ...rest] = line.split(":");
            return [key.trim(), rest.join(":").trim()];
          })
          .filter(([key]) => key.length > 0)
      );
      if (fields.session_id && (fields.role === "user" || fields.role === "assistant")) {
        parsed.push({
          sessionId: fields.session_id,
          turnId: fields.turn_id || undefined,
          role: fields.role,
          eventType: fields.event_type || "created",
          originalText: body.trimEnd(),
          createdAt: fields.timestamp,
          sourcePurpose: fields.source_purpose as RawWriteInput["sourcePurpose"]
        });
      }
    }
    return parsed;
  }
}
