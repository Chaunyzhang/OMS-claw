import { RawMessageStore } from "../storage/RawMessageStore.js";
import { GraphStore } from "../storage/GraphStore.js";
import type { RawMessage, SourcePurpose } from "../types.js";

const EXTRACTOR = "oms_graph_v2";
const EXTRACTOR_VERSION = "2.0.0";
const PAGE_SIZE = 5000;
const MAX_LABELS_PER_TEXT_UNIT = 8;
const MAX_PAIR_DISTANCE = 3;
const MAX_CO_OCCURRENCES_PER_TEXT_UNIT = 12;
const MAX_CHUNK_CHARS = 900;

const GRAPHABLE_SOURCE_PURPOSES = new Set<SourcePurpose>(["general_chat", "material_corpus", "formal_question", "imported_timeline"]);

const DOMAIN_PHRASES = [
  "OMS",
  "OpenClaw",
  "Paperclip",
  "ChaunyOPC",
  "lake sunrise",
  "sunrise",
  "mural",
  "project codename",
  "codename",
  "painted",
  "painting",
  "community art"
];

interface ExtractedEntity {
  label: string;
  entityType: string;
  startChar: number;
  endChar: number;
  confidence: number;
  ruleId: string;
}

interface TextUnit {
  textUnitId: string;
  text: string;
  normalizedText: string;
  startChar: number;
  endChar: number;
}

interface RelationCandidate {
  fromIndex: number;
  toIndex: number;
  relationType: string;
  directionality: "directed" | "undirected";
  ruleId: string;
  confidence: number;
  semantic: boolean;
}

export interface GraphBuildResult {
  nodes: number;
  edges: number;
  rawScanned: number;
  entitiesUpserted: number;
  relationsUpserted: number;
  occurrencesInserted: number;
}

function canonical(label: string): string {
  return label.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function normalizeText(text: string): string {
  return canonical(text);
}

function shouldGraph(raw: RawMessage): boolean {
  if (!raw.retrievalAllowed || raw.role !== "user" || raw.interrupted) {
    return false;
  }
  if (!GRAPHABLE_SOURCE_PURPOSES.has(raw.sourcePurpose)) {
    return false;
  }
  return !raw.normalizedText.startsWith("## oms openclaw memory") && !raw.normalizedText.includes("[oms memory policy]");
}

function entityType(label: string): string {
  if (/^(?:\d{4}|v\d+(?:\.\d+)*)$/iu.test(label)) {
    return "token";
  }
  if (/[/\\]/u.test(label)) {
    return "path";
  }
  if (/^(?:oms|openclaw|paperclip|chaunyopc)$/iu.test(label)) {
    return "system";
  }
  return "entity";
}

function sourceWeight(sourcePurpose: SourcePurpose): number {
  return (
    {
      material_corpus: 1,
      imported_timeline: 0.9,
      formal_question: 0.7,
      general_chat: 0.5,
      assistant_final_answer: 0,
      assistant_storage_receipt: 0,
      diagnostic: 0,
      visible_tool_summary: 0,
      system_visible_notice: 0,
      debug_note: 0,
      conversation: 0,
      assistant_reply: 0,
      system_visible: 0
    } satisfies Record<SourcePurpose, number>
  )[sourcePurpose];
}

function addEntity(entities: Map<string, ExtractedEntity>, entity: ExtractedEntity): void {
  const key = `${entity.entityType}:${canonical(entity.label)}`;
  const existing = entities.get(key);
  if (!existing || entity.confidence > existing.confidence) {
    entities.set(key, entity);
  }
}

function textUnitsFor(raw: RawMessage): TextUnit[] {
  if (!["material_corpus", "imported_timeline"].includes(raw.sourcePurpose) || raw.originalText.length <= MAX_CHUNK_CHARS) {
    return [
      {
        textUnitId: raw.messageId,
        text: raw.originalText,
        normalizedText: raw.normalizedText,
        startChar: 0,
        endChar: raw.originalText.length
      }
    ];
  }

  const units: TextUnit[] = [];
  let start = 0;
  while (start < raw.originalText.length) {
    let end = Math.min(raw.originalText.length, start + MAX_CHUNK_CHARS);
    if (end < raw.originalText.length) {
      const lastWhitespace = raw.originalText.lastIndexOf(" ", end);
      if (lastWhitespace > start + Math.floor(MAX_CHUNK_CHARS * 0.6)) {
        end = lastWhitespace;
      }
    }
    const text = raw.originalText.slice(start, end).trim();
    if (text.length > 0) {
      units.push({
        textUnitId: `${raw.messageId}:tu:${units.length}`,
        text,
        normalizedText: normalizeText(text),
        startChar: start,
        endChar: end
      });
    }
    start = Math.max(end + 1, start + 1);
  }
  return units;
}

function extractEntities(unit: TextUnit): ExtractedEntity[] {
  const entities = new Map<string, ExtractedEntity>();
  for (const match of unit.text.matchAll(/\b[A-Z][a-zA-Z0-9_-]{2,}(?:\s+[A-Z][a-zA-Z0-9_-]{2,}){0,3}\b/gu)) {
    const label = match[0];
    addEntity(entities, {
      label,
      entityType: entityType(label),
      startChar: unit.startChar + match.index,
      endChar: unit.startChar + match.index + label.length,
      confidence: 0.7,
      ruleId: "proper_noun"
    });
  }
  for (const phrase of DOMAIN_PHRASES) {
    const index = unit.normalizedText.indexOf(phrase.toLowerCase());
    if (index >= 0) {
      addEntity(entities, {
        label: phrase,
        entityType: entityType(phrase),
        startChar: unit.startChar + index,
        endChar: unit.startChar + index + phrase.length,
        confidence: 0.85,
        ruleId: "domain_phrase"
      });
    }
  }
  for (const match of unit.normalizedText.matchAll(/\b(?:\d{4}|v\d+(?:\.\d+)*|[a-z0-9_-]+\/[a-z0-9_./-]+)\b/gu)) {
    const label = match[0];
    addEntity(entities, {
      label,
      entityType: entityType(label),
      startChar: unit.startChar + match.index,
      endChar: unit.startChar + match.index + label.length,
      confidence: 0.65,
      ruleId: "token_or_path"
    });
  }
  return Array.from(entities.values())
    .sort((left, right) => left.startChar - right.startChar || right.confidence - left.confidence)
    .slice(0, MAX_LABELS_PER_TEXT_UNIT);
}

function semanticRelationType(between: string): string | undefined {
  if (/\bdepends\s+on\b/u.test(between)) {
    return "DEPENDS_ON";
  }
  if (/\bconfigur(?:es|ed|ing|e)\b/u.test(between)) {
    return "CONFIGURES";
  }
  if (/\buses?\b/u.test(between)) {
    return "USES";
  }
  if (/\b(?:is|are|as)\s+part\s+of\b/u.test(between)) {
    return "PART_OF";
  }
  if (/\bconnect(?:s|ed|ing)?\b/u.test(between)) {
    return "CONNECTS_TO";
  }
  if (/\bstor(?:es|ed|ing)?\s+(?:at|in)\b/u.test(between) || /\blives?\s+(?:at|in)\b/u.test(between)) {
    return "STORED_AT";
  }
  return undefined;
}

function semanticRelations(unit: TextUnit, entities: ExtractedEntity[]): RelationCandidate[] {
  const relations: RelationCandidate[] = [];
  for (let left = 0; left < entities.length; left += 1) {
    for (let right = 0; right < entities.length; right += 1) {
      if (left === right || entities[left].startChar >= entities[right].startChar) {
        continue;
      }
      const localStart = Math.max(0, entities[left].endChar - unit.startChar);
      const localEnd = Math.max(localStart, entities[right].startChar - unit.startChar);
      const between = normalizeText(unit.text.slice(localStart, localEnd));
      if (between.length > 140) {
        continue;
      }
      const relationType = semanticRelationType(between);
      if (!relationType) {
        continue;
      }
      relations.push({
        fromIndex: left,
        toIndex: right,
        relationType,
        directionality: "directed",
        ruleId: `semantic_${relationType.toLowerCase()}`,
        confidence: 0.75,
        semantic: true
      });
    }
  }
  return relations;
}

export class GraphBuilder {
  constructor(
    private readonly rawMessages: RawMessageStore,
    private readonly graph: GraphStore
  ) {}

  buildForAgent(agentId: string, pageSize = PAGE_SIZE): GraphBuildResult {
    const startedAt = new Date().toISOString();
    return this.buildFromWatermark(agentId, 0, pageSize, startedAt, "full");
  }

  buildIncremental(agentId: string, pageSize = PAGE_SIZE): GraphBuildResult {
    const startedAt = new Date().toISOString();
    const watermark = this.graph.latestHighWatermark(agentId, EXTRACTOR_VERSION);
    return this.buildFromWatermark(agentId, watermark, pageSize, startedAt, "incremental");
  }

  rebuildAgent(agentId: string, pageSize = PAGE_SIZE): GraphBuildResult {
    this.graph.clearV2ForAgent(agentId);
    return this.buildForAgent(agentId, pageSize);
  }

  private buildFromWatermark(
    agentId: string,
    afterSequence: number,
    pageSize: number,
    startedAt: string,
    mode: "full" | "incremental"
  ): GraphBuildResult {
    let rawScanned = 0;
    let entitiesUpserted = 0;
    let relationsUpserted = 0;
    let occurrencesInserted = 0;
    let highWatermark = afterSequence;
    try {
      for (;;) {
        const raws = this.rawMessages.allForAgentAfterSequence(agentId, highWatermark, pageSize);
        if (raws.length === 0) {
          break;
        }
        for (const raw of raws) {
          highWatermark = Math.max(highWatermark, raw.sequence);
          if (!shouldGraph(raw)) {
            continue;
          }
          rawScanned += 1;
          const result = this.buildRaw(agentId, raw);
          entitiesUpserted += result.entitiesUpserted;
          relationsUpserted += result.relationsUpserted;
          occurrencesInserted += result.occurrencesInserted;
        }
      }
      this.graph.recordBuildRun({
        agentId,
        extractorVersion: EXTRACTOR_VERSION,
        startedAt,
        finishedAt: new Date().toISOString(),
        highWatermarkSequence: highWatermark,
        rawScanned,
        entitiesUpserted,
        relationsUpserted,
        occurrencesInserted,
        status: "succeeded",
        metadata: { mode }
      });
      return {
        nodes: entitiesUpserted,
        edges: relationsUpserted,
        rawScanned,
        entitiesUpserted,
        relationsUpserted,
        occurrencesInserted
      };
    } catch (error) {
      this.graph.recordBuildRun({
        agentId,
        extractorVersion: EXTRACTOR_VERSION,
        startedAt,
        finishedAt: new Date().toISOString(),
        highWatermarkSequence: highWatermark,
        rawScanned,
        entitiesUpserted,
        relationsUpserted,
        occurrencesInserted,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        metadata: { mode }
      });
      throw error;
    }
  }

  private buildRaw(agentId: string, raw: RawMessage): Omit<GraphBuildResult, "nodes" | "edges" | "rawScanned"> {
    let entitiesUpserted = 0;
    let relationsUpserted = 0;
    let occurrencesInserted = 0;

    for (const unit of textUnitsFor(raw)) {
      const extracted = extractEntities(unit);
      const entityIds = extracted.map((entity) => {
        const entityId = this.graph.upsertEntity({
          agentId,
          entityType: entity.entityType,
          label: entity.label,
          confidence: entity.confidence,
          observedAt: raw.createdAt,
          metadata: { extractor: EXTRACTOR, ruleId: entity.ruleId }
        });
        this.graph.insertMention({
          agentId,
          entityId,
          rawId: raw.messageId,
          turnId: raw.turnId,
          textUnitId: unit.textUnitId,
          extractor: EXTRACTOR,
          extractorVersion: EXTRACTOR_VERSION,
          startChar: entity.startChar,
          endChar: entity.endChar,
          mentionText: entity.label,
          confidence: entity.confidence,
          observedAt: raw.createdAt,
          metadata: { sourcePurpose: raw.sourcePurpose, ruleId: entity.ruleId }
        });
        return entityId;
      });
      entitiesUpserted += extracted.length;

      const semantic = semanticRelations(unit, extracted);
      const semanticPairs = new Set<string>();
      for (const relation of semantic) {
        const inserted = this.writeRelation(agentId, raw, unit, extracted, entityIds, relation);
        const pairKey = [entityIds[relation.fromIndex], entityIds[relation.toIndex]].sort().join(":");
        semanticPairs.add(pairKey);
        relationsUpserted += inserted ? 1 : 0;
        occurrencesInserted += inserted ? 1 : 0;
      }

      let coOccurrences = 0;
      for (let left = 0; left < entityIds.length && coOccurrences < MAX_CO_OCCURRENCES_PER_TEXT_UNIT; left += 1) {
        for (
          let right = left + 1;
          right < Math.min(entityIds.length, left + 1 + MAX_PAIR_DISTANCE) && coOccurrences < MAX_CO_OCCURRENCES_PER_TEXT_UNIT;
          right += 1
        ) {
          if (entityIds[left] === entityIds[right]) {
            continue;
          }
          const pairKey = [entityIds[left], entityIds[right]].sort().join(":");
          if (semanticPairs.has(pairKey)) {
            continue;
          }
          const confidence = Math.min(0.6, 0.35 + sourceWeight(raw.sourcePurpose) * 0.25);
          const inserted = this.writeRelation(agentId, raw, unit, extracted, entityIds, {
            fromIndex: left,
            toIndex: right,
            relationType: "CO_OCCURS_WITH",
            directionality: "undirected",
            ruleId: "co_window_v2",
            confidence,
            semantic: false
          });
          coOccurrences += 1;
          relationsUpserted += inserted ? 1 : 0;
          occurrencesInserted += inserted ? 1 : 0;
        }
      }
    }
    return {
      entitiesUpserted,
      relationsUpserted,
      occurrencesInserted
    };
  }

  private writeRelation(
    agentId: string,
    raw: RawMessage,
    unit: TextUnit,
    extracted: ExtractedEntity[],
    entityIds: string[],
    relation: RelationCandidate
  ): boolean {
    const relationId = this.graph.upsertRelation({
      agentId,
      fromEntityId: entityIds[relation.fromIndex],
      toEntityId: entityIds[relation.toIndex],
      relationType: relation.relationType,
      directionality: relation.directionality,
      confidence: relation.confidence,
      observedAt: raw.createdAt,
      metadata: { extractor: EXTRACTOR, fallback: !relation.semantic }
    });
    return this.graph.insertRelationOccurrence({
      agentId,
      relationId,
      rawId: raw.messageId,
      turnId: raw.turnId,
      textUnitId: unit.textUnitId,
      extractor: EXTRACTOR,
      extractorVersion: EXTRACTOR_VERSION,
      ruleId: relation.ruleId,
      evidenceText: unit.text,
      startChar: extracted[relation.fromIndex].startChar,
      endChar: extracted[relation.toIndex].endChar,
      strength: sourceWeight(raw.sourcePurpose),
      confidence: relation.confidence,
      observedAt: raw.createdAt,
      metadata: {
        sourcePurpose: raw.sourcePurpose,
        semantic: relation.semantic,
        labels: [extracted[relation.fromIndex].label, extracted[relation.toIndex].label]
      }
    });
  }
}
