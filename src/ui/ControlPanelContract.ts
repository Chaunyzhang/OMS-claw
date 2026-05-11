import type { OmsConfig } from "../types.js";

export interface InspectionPanelContract {
  id: "overview" | "query_trace" | "packet_trace" | "graph_health" | "logs";
  title: string;
  description: string;
  toolNames: string[];
}

export interface ControlPanelContract {
  modes: OmsConfig["mode"][];
  toggles: string[];
  manualPaths: string[];
  inspection: {
    schemaVersion: "oms-ui-contract-v1";
    panels: InspectionPanelContract[];
  };
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
    manualPaths: ["summary", "fts", "rag", "graph"],
    inspection: {
      schemaVersion: "oms-ui-contract-v1",
      panels: [
        {
          id: "overview",
          title: "Overview",
          description: "Top-level OMS status, counts, feature health, and last error.",
          toolNames: ["oms_status"]
        },
        {
          id: "query_trace",
          title: "Query Trace",
          description: "Lane selection, degradation reasons, fusion readiness, and packet delivery outcome for a query.",
          toolNames: ["oms_why", "oms_search"]
        },
        {
          id: "packet_trace",
          title: "Packet Trace",
          description: "Trace a packet, summary, or raw message back through OMS lineage.",
          toolNames: ["oms_trace"]
        },
        {
          id: "graph_health",
          title: "Graph Health",
          description: "Graph counts, noisy entities, relation ratios, and latest graph build summary.",
          toolNames: ["oms_inspect_graph"]
        },
        {
          id: "logs",
          title: "Logs",
          description: "Recent OMS logs and events intended for local debugging surfaces.",
          toolNames: ["oms_inspect_logs"]
        }
      ]
    }
  };
}
