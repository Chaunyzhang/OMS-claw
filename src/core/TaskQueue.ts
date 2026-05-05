export interface QueueJob {
  id: string;
  kind: string;
  run: () => Promise<void> | void;
}

export class TaskQueue {
  private pending = 0;
  private failed = 0;
  private readonly failures: Array<{ id: string; kind: string; reason: string }> = [];

  async enqueue(job: QueueJob): Promise<void> {
    this.pending += 1;
    try {
      await job.run();
    } catch (error) {
      this.failed += 1;
      this.failures.push({
        id: job.id,
        kind: job.kind,
        reason: error instanceof Error ? error.message : String(error)
      });
    } finally {
      this.pending -= 1;
    }
  }

  counts(): { pendingJobs: number; failedJobs: number } {
    return { pendingJobs: this.pending, failedJobs: this.failed };
  }

  recentFailures(): Array<{ id: string; kind: string; reason: string }> {
    return this.failures.slice(-20);
  }
}
