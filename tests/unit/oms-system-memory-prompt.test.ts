import { describe, expect, it } from "vitest";
import { buildOmsPromptSection } from "../../src/adapter/PluginRegistration.js";
import { createDefaultConfig } from "../../src/core/ConfigResolver.js";
import { OmsOrchestrator } from "../../src/core/OmsOrchestrator.js";

describe("OMS system memory prompt", () => {
  it("injects the memory contract even when availableTools is absent", () => {
    const lines = buildOmsPromptSection();
    const prompt = lines.join("\n");

    expect(prompt).toContain("## OMS Memory Recall");
    expect(prompt).toContain("system-level long-term memory");
    expect(prompt).toContain("part of your own memory");
    expect(prompt).toContain("OMS tools are unavailable in this session");
  });

  it("does not show the unavailable-tools diagnostic when OMS tools are visible", () => {
    const lines = buildOmsPromptSection({ availableTools: ["oms_search"] });
    const prompt = lines.join("\n");

    expect(prompt).toContain("## OMS Memory Recall");
    expect(prompt).toContain("Before answering prior-conversation facts");
    expect(prompt).not.toContain("OMS tools are unavailable in this session");
  });

  it("adds system-level memory framing to before_prompt_build context", () => {
    const oms = new OmsOrchestrator(createDefaultConfig({ agentId: "agent", dbPath: ":memory:" }));
    try {
      const assembled = oms.assemble({ sessionId: "s1" });

      expect(assembled.systemPromptAddition).toContain("## OMS OpenClaw Memory");
      expect(assembled.systemPromptAddition).toContain("system-level long-term memory");
      expect(assembled.systemPromptAddition).toContain("part of your own memory");
      expect(assembled.systemPromptAddition).toContain("OMS tools are unavailable in this session");
    } finally {
      oms.connection.close();
    }
  });
});
