import { RawMessageStore } from "../storage/RawMessageStore.js";
import { GraphStore } from "../storage/GraphStore.js";
import type { RawMessage } from "../types.js";

const DOMAIN_PHRASES = [
  "lake sunrise",
  "sunrise",
  "mural",
  "project codename",
  "codename",
  "painted",
  "painting",
  "community art"
];

const GRAPHABLE_SOURCE_PURPOSES = new Set(["general_chat", "material_corpus", "formal_question", "imported_timeline"]);
const MAX_LABELS_PER_MESSAGE = 8;
const MAX_PAIR_DISTANCE = 3;

function shouldGraph(raw: RawMessage): boolean {
  if (!raw.retrievalAllowed || raw.role !== "user") {
    return false;
  }
  if (!GRAPHABLE_SOURCE_PURPOSES.has(raw.sourcePurpose)) {
    return false;
  }
  return !raw.normalizedText.startsWith("## oms openclaw memory") && !raw.normalizedText.includes("[oms memory policy]");
}

function extractLabels(raw: RawMessage): string[] {
  const labels = new Set<string>();
  for (const match of raw.originalText.matchAll(/\b[A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]{2,}){0,3}\b/gu)) {
    labels.add(match[0]);
  }
  const normalized = raw.normalizedText;
  for (const phrase of DOMAIN_PHRASES) {
    if (normalized.includes(phrase)) {
      labels.add(phrase);
    }
  }
  for (const match of normalized.matchAll(/\b(?:\d{4}|v\d+(?:\.\d+)*|[a-z0-9_-]+\/[a-z0-9_./-]+)\b/gu)) {
    labels.add(match[0]);
  }
  return Array.from(labels).slice(0, MAX_LABELS_PER_MESSAGE);
}

export class GraphBuilder {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly graph: GraphStore
  ) {}

  buildForAgent(agentId: string, limit = 5000): { nodes: number; edges: number } {
    let nodes = 0;
    let edges = 0;
    for (const raw of this.rawMessages.allForAgent(agentId, limit).filter((message) => shouldGraph(message))) {
      const nodeIds = extractLabels(raw).map((label) => {
        nodes += 1;
        return this.graph.upsertNode({
          agentId,
          nodeType: /^[0-9v]/u.test(label) ? "token" : "entity",
          label,
          sourceRawId: raw.messageId,
          confidence: raw.evidenceAllowed ? 0.75 : 0.45
        });
      });
      for (let left = 0; left < nodeIds.length; left += 1) {
        for (let right = left + 1; right < Math.min(nodeIds.length, left + 1 + MAX_PAIR_DISTANCE); right += 1) {
          this.graph.upsertEdge({
            agentId,
            fromNodeId: nodeIds[left],
            toNodeId: nodeIds[right],
            relation: "co_mentions",
            sourceRawId: raw.messageId,
            weight: raw.evidenceAllowed ? 1 : 0.5,
            confidence: raw.evidenceAllowed ? 0.7 : 0.4
          });
          this.graph.upsertEdge({
            agentId,
            fromNodeId: nodeIds[right],
            toNodeId: nodeIds[left],
            relation: "co_mentions",
            sourceRawId: raw.messageId,
            weight: raw.evidenceAllowed ? 1 : 0.5,
            confidence: raw.evidenceAllowed ? 0.7 : 0.4
          });
          edges += 2;
        }
      }
    }
    return { nodes, edges };
  }
}
