import { SummaryDagBuilder } from "./SummaryDagBuilder.js";

export class RollupSummaryJob {
  constructor(private readonly builder: SummaryDagBuilder) {}

  run(input: { agentId: string; sessionId?: string; childSummaryIds: string[] }) {
    return this.builder.buildRollup(input);
  }
}
