export type OmsMode = "off" | "auto" | "low" | "medium" | "high" | "xhigh" | "ultra";
export type RawRole = "user" | "assistant";
export type SourcePurpose =
  | "general_chat"
  | "material_corpus"
  | "formal_question"
  | "assistant_final_answer"
  | "assistant_storage_receipt"
  | "diagnostic"
  | "visible_tool_summary"
  | "system_visible_notice"
  | "debug_note"
  | "conversation"
  | "assistant_reply"
  | "system_visible"
  | "imported_timeline";
export type SourceAuthority =
  | "visible_transcript"
  | "original_user_supplied_material"
  | "assistant_visible_final"
  | "assistant_visible_summary"
  | "diagnostic_explanation"
  | "non_evidence_interaction"
  | "authoritative_material"
  | "user_visible"
  | "assistant_visible"
  | "diagnostic_only"
  | "replay_only"
  | "blocked";
export type EvidencePolicyMask =
  | "general_history"
  | "assistant_history"
  | "material_evidence"
  | "diagnostic_history"
  | "debug_only"
  | "never_evidence";
export type EvidencePolicyRequest =
  | "general_history"
  | "assistant_history"
  | "material_evidence"
  | "diagnostic_history";

export interface BuildInfo {
  packageVersion: string;
  commitSha: string;
  buildTimestamp: string;
  schemaVersion: string;
  toolSchemaHash: string;
  contextEngineId: "oms";
  loadedFromPath: string;
}

export interface OmsConfig {
  agentId: string;
  mode: OmsMode;
  dbPath: string;
  memoryRepoPath?: string;
  recentCompleteTurns: number;
  contextThreshold: number;
  summaryEnabled: boolean;
  summaryFreshRawMessages: number;
  summaryLeafChunkTokens: number;
  summaryLeafRollupMinFanout: number;
  summaryRollupMinFanout: number;
  summaryIncrementalMaxDepth: number;
  ftsEnabled: boolean;
  trigramEnabled: boolean;
  ragEnabled: boolean;
  annEnabled: boolean;
  embeddingProvider: "disabled" | "local_hash" | "openrouter";
  embeddingModel?: string;
  embeddingApiKeyEnv?: string;
  embeddingBaseUrl?: string;
  embeddingDimensions?: number;
  embeddingTimeoutMs?: number;
  graphEnabled: boolean;
  sqlFusionEnabled: boolean;
  gitExportEnabled: boolean;
  redactionEnabled: boolean;
  debug: boolean;
  manualRetrievalDisabled: boolean;
  manualRetrievalPath?: "summary" | "fts" | "trigram" | "rag" | "ann" | "graph";
}

export interface RawWriteInput {
  agentId?: string;
  sessionId: string;
  turnId?: string;
  turnIndex?: number;
  role: RawRole;
  eventType?: string;
  originalText: string;
  createdAt?: string;
  sequence?: number;
  sourceScope?: string;
  sourcePurpose?: SourcePurpose;
  sourceAuthority?: SourceAuthority;
  retrievalAllowed?: boolean;
  evidenceAllowed?: boolean;
  evidencePolicyMask?: EvidencePolicyMask;
  caseId?: string;
  parentMessageId?: string;
  interrupted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RawMessage {
  rawId?: string;
  messageId: string;
  agentId: string;
  sessionId: string;
  turnId?: string;
  role: RawRole;
  eventType: string;
  createdAt: string;
  sequence: number;
  originalText: string;
  normalizedText: string;
  tokenCount: number;
  originalHash: string;
  visibleToUser: boolean;
  interrupted: boolean;
  sourceScope: string;
  sourcePurpose: SourcePurpose;
  sourceAuthority: SourceAuthority;
  retrievalAllowed: boolean;
  evidenceAllowed: boolean;
  evidencePolicyMask: EvidencePolicyMask;
  caseId?: string;
  parentMessageId?: string;
  metadata: Record<string, unknown>;
  turnIndex?: number;
}

export interface RawWriteReceipt {
  ok: boolean;
  agentId?: string;
  sessionId?: string;
  turnId?: string;
  messageId: string;
  originalHash: string;
  sequence: number;
  sourcePurpose: SourcePurpose;
  sourceAuthority: SourceAuthority;
  retrievalAllowed: boolean;
  evidenceAllowed: boolean;
  reason?: string;
}

export interface SummaryRecord {
  summaryId: string;
  agentId: string;
  sessionId?: string;
  level: number;
  nodeKind: "leaf" | "rollup" | "lifetime";
  createdAt: string;
  status: "active" | "inactive";
  summaryText: string;
  tokenCount: number;
  sourceHash: string;
  sourceMessageCount: number;
  metadata: Record<string, unknown>;
}

export interface SummarySearchHit {
  hitKind: "summary_navigation";
  summaryId: string;
  level: number;
  score: number;
  summaryPreview: string;
  evidenceRequired: true;
  nextTool: "oms_expand_evidence";
  sourceSummaryId: string;
  sourceEdgeCount: number;
  rawCandidateCount: number;
  authoritativeMaterialRawCount: number;
  traceHealth: "ok" | "broken" | "unknown";
  summaryTextIsNotEvidence: true;
}

export interface AuthorityReport {
  ok: boolean;
  expectedPolicy: string;
  totalRawCount: number;
  authoritativeRawCount: number;
  blockedRawCount: number;
  blockedReasons: Array<{
    messageId: string;
    reason:
      | "retrieval_not_allowed"
        | "wrong_source_purpose"
        | "wrong_source_authority"
        | "wrong_case_id"
        | "assistant_storage_receipt"
      | "formal_question"
      | "diagnostic_not_allowed"
      | "secret_detected";
  }>;
}

export interface EvidencePacket {
  packetId: string;
  queryId?: string;
  fusionRunId?: string;
  status: "delivered" | "blocked" | "empty";
  reason?: string;
  selectedAuthoritativeRawCount: number;
  selectedRawCount: number;
  summaryDerivedRawCount: number;
  rawMessageIds: string[];
  sourceSummaryIds: string[];
  sourceEdgeIds: string[];
  sourceRoutes?: string[];
  rawExcerptHash: string;
  rawExcerpts: Array<{
    messageId: string;
    sessionId: string;
    role: RawRole;
    createdAt: string;
    sequence: number;
    sourcePurpose: SourcePurpose;
    sourceAuthority: SourceAuthority;
    evidenceAllowed?: boolean;
    turnIndex: number;
    originalText: string;
  }>;
  authorityReport: AuthorityReport;
  deliveryReceipt: {
    deliveredToOpenClaw: boolean;
    deliveredAt: string;
    build: BuildInfo;
  };
  answerInstruction: string;
}

export type LaneName = "fts_bm25" | "trigram" | "summary_dag" | "ann_vector" | "graph_cte" | "timeline";
export type LaneStatus = "ok" | "ready" | "warming" | "degraded" | "blocked" | "failed" | "unknown";
export type TargetKind = "raw" | "summary" | "embedding_chunk" | "graph_node" | "graph_edge";

export interface CandidateLaneHit {
  targetKind: TargetKind;
  targetId: string;
  rawIdHint?: string;
  summaryIdHint?: string;
  graphPath?: unknown;
  rank: number;
  score: number;
  reason: Record<string, unknown>;
}

export interface CandidateLaneResult {
  lane: LaneName;
  status: "ok" | "degraded" | "blocked" | "failed";
  candidates: CandidateLaneHit[];
  timingsMs: Record<string, number>;
  error?: string;
}

export interface FusionCandidate {
  rawId: string;
  fusedRank: number;
  fusedScore: number;
  laneVotes: Array<{ lane: string; rank: number; weight: number }>;
  reason?: Record<string, unknown>;
}

export interface OmsRetrieveResult {
  ok: boolean;
  queryId: string;
  mode: OmsMode;
  lanesUsed: LaneName[];
  lanesDegraded: Array<{ lane: LaneName; status: string; error?: string }>;
  candidateCount: number;
  packet: EvidencePacket | null;
  details: {
    fusionRunId?: string;
    timingsMs: Record<string, number>;
    fusedCandidates?: FusionCandidate[];
  };
  reason?: string;
  answerPolicy: "ready_for_openclaw" | "candidate_only" | "must_not_answer_from_candidates";
}

export interface OmsStatus {
  ok: boolean;
  agentId: string;
  mode: OmsMode;
  build: BuildInfo;
  openclaw: {
    contextEngineRegistered: boolean;
    memorySlotRegistered: boolean;
    toolsRegistered: boolean;
    activeContextEngineId?: string;
    activeMemorySlotId?: string;
  };
  counts: {
    rawMessages: number;
    summaries: number;
    sourceEdges: number;
    retrievalRuns: number;
    evidencePackets: number;
    embeddingChunks: number;
    graphNodes: number;
    graphEdges: number;
    pendingJobs: number;
    failedJobs: number;
  };
  health: {
    rawWriteOk: boolean;
    ftsReady: boolean;
    trigramReady: boolean;
    summaryDagOk: boolean;
    annVectorOk: boolean;
    graphCteOk: boolean;
    sqlFusionOk: boolean;
    gitExportOk: boolean;
    lastError?: string;
  };
  features?: Record<string, LaneStatus | "ready" | "degraded" | "blocked" | "failed" | "unknown">;
}
