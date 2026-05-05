export class GitRunner {
  status(): { ok: boolean; reason: string } {
    return { ok: true, reason: "git timeline export writes portable markdown; git commit is intentionally caller-owned" };
  }
}
