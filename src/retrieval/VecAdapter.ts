export interface VecAdapterStatus {
  ok: boolean;
  provider: "sqlite-vec" | "vec1" | "none";
  reason?: string;
}

export class VecAdapter {
  probe(): VecAdapterStatus {
    return {
      ok: false,
      provider: "none",
      reason: "sqlite vector extension not bundled; using brute-force canonical SQLite vectors"
    };
  }
}
