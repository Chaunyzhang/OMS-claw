export type OmsMode = "off" | "auto" | "low" | "medium" | "high" | "xhigh";
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
  | "debug_note";
export type SourceAuthority =
  | "visible_transcript"
  | "original_user_supplied_material"
  | "assistant_visible_final"
  | "assistant_visible_summary"
  | "diagnostic_explanation"
  | "non_evidence_interaction";
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
  ftsEnabled: boolean;
  ragEnabled: boolean;
  graphEnabled: boolean;
  gitExportEnabled: boolean;
  redactionEnabled: boolean;
  debug: boolean;
  manualRetrievalDisabled: boolean;
  manualRetrievalPath?: "summary" | "fts" | "rag" | "graph";
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
  evidencePolicyMask?: EvidencePolicyMask;
  caseId?: string;
  parentMessageId?: string;
  interrupted?: boolean;
  metadata?: Record<string, unknown>;
}

export interface RawMessage {
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
      | "diagnostic_not_allowed";
  }>;
}

export interface EvidencePacket {
  packetId: string;
  status: "delivered" | "blocked" | "empty";
  reason?: string;
  selectedAuthoritativeRawCount: number;
  selectedRawCount: number;
  summaryDerivedRawCount: number;
  rawMessageIds: string[];
  sourceSummaryIds: string[];
  sourceEdgeIds: string[];
  rawExcerptHash: string;
  rawExcerpts: Array<{
    messageId: string;
    role: RawRole;
    createdAt: string;
    sourcePurpose: SourcePurpose;
    sourceAuthority: SourceAuthority;
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

export interface OmsStatus {
  ok: boolean;
  agentId: string;
  mode: OmsMode;
  dbPath: string;
  memoryRepoPath?: string;
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
    pendingJobs: number;
    failedJobs: number;
  };
  health: {
    rawWriteOk: boolean;
    ftsReady: boolean;
    summaryDagOk: boolean;
    gitExportOk: boolean;
    lastError?: string;
  };
}
