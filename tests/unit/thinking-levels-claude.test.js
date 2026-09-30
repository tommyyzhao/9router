import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";

describe("Claude adaptive thinking levels", () => {
  it("xhigh-capable models expose xhigh; none only when disable is possible", () => {
    expect(getThinkingLevels("claude", "claude-opus-5-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("claude", "claude-fable-5-1")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("claude", "claude-sonnet-5-5")).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
    expect(getThinkingLevels("claude", "claude-opus-4-7")).toContain("xhigh");
    expect(getThinkingLevels("kiro", "claude-sonnet-5")).toContain("xhigh");
  });

  it("Claude 4.6 keeps low..max without xhigh", () => {
    for (const id of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4.6", "claude-sonnet-4.6"]) {
      expect(getThinkingLevels("claude", id)).toEqual(["none", "low", "medium", "high", "max"]);
    }
  });

  it("Opus 5.5 / Sonnet 5.5 resolve to 1M adaptive caps", () => {
    const base = { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 };
    expect(getCapabilitiesForModel("claude", "claude-opus-5-5")).toMatchObject({ ...base, thinkingCanDisable: false });
    expect(getCapabilitiesForModel("tokenharbor", "claude-opus-5.5")).toMatchObject({ ...base, thinkingCanDisable: false });
    expect(getCapabilitiesForModel("claude", "claude-sonnet-5-5")).toMatchObject({ ...base, thinkingDisableMode: "between_tools" });
  });
});
