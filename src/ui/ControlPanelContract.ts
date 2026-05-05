import type { OmsConfig } from "../types.js";

export interface ControlPanelContract {
  modes: OmsConfig["mode"][];
  toggles: string[];
  manualPaths: string[];
}

export function controlPanelContract(): ControlPanelContract {
  return {
    modes: ["off", "auto", "low", "medium", "high", "xhigh"],
    toggles: [
      "summary",
      "fts5",
      "rag",
      "graph",
      "git_export",
      "redaction",
      "debug",
      "manual_force_retrieval",
      "manual_disable_retrieval"
    ],
    manualPaths: ["summary", "fts", "rag", "graph"]
  };
}
