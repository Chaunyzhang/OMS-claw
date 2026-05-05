import type { OmsMode } from "../types.js";

const HIGH_INTENT_PATTERNS = [
  /你确定吗/u,
  /之前不是这样吗/u,
  /我以前说过什么/u,
  /旧版本/u,
  /最终版/u,
  /纠正/u,
  /为什么变了/u,
  /上次答错/u,
  /引用原文/u,
  /按原话/u,
  /\b(trace|source|evidence)\b/iu,
  /\bformal\b/iu
];

export class ModeResolver {
  static resolveForQuery(configuredMode: OmsMode, query: string): OmsMode {
    if (configuredMode !== "auto") {
      return configuredMode;
    }
    return HIGH_INTENT_PATTERNS.some((pattern) => pattern.test(query)) ? "high" : "medium";
  }

  static enabled(mode: OmsMode): boolean {
    return mode !== "off";
  }
}
