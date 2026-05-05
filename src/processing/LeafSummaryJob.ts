import { SummaryDagBuilder } from "./SummaryDagBuilder.js";

export class LeafSummaryJob {
  constructor(private readonly builder: SummaryDagBuilder) {}

  run(input: { agentId: string; sessionId: string; turnId: string }) {
    return this.builder.buildLeafForTurn(input);
  }
}
