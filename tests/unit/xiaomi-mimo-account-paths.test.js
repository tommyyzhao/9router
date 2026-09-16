import { describe, it, expect } from "vitest";
import {
  desktopCookiePathCandidates,
  getMimoAccountBase,
  normalizeMimoRegion,
  readDesktopRegion,
  __test__ as mimoTest,
} from "../../open-sse/shared/mimoAccount.js";

describe("xiaomi-mimo Desktop harness paths + region", () => {
  it("prefers the current Xiaomi MiMo AI cookie path over legacy Network/ layout", () => {
    const paths = desktopCookiePathCandidates();
    expect(paths.length).toBeGreaterThan(1);

    const ai = paths.filter((p) => p.includes("Xiaomi MiMo AI") && p.endsWith(`${"Partitions"}/xiaomi-account/Cookies`));
    expect(ai.length).toBeGreaterThanOrEqual(1);
    // Current layout must appear before the obsolete Network/ variant of the same root.
    const aiNet = paths.findIndex((p) => p.includes("Xiaomi MiMo AI") && p.includes("Network"));
    const aiPlain = paths.findIndex((p) => p.includes("Xiaomi MiMo AI") && !p.includes("Network"));
    expect(aiPlain).toBeGreaterThanOrEqual(0);
    if (aiNet >= 0) expect(aiPlain).toBeLessThan(aiNet);
  });

  it("normalizes Desktop region tokens", () => {
    expect(normalizeMimoRegion("SGP")).toBe("sgp");
    expect(normalizeMimoRegion("cn")).toBe("cn");
    expect(normalizeMimoRegion("EU")).toBe("sgp");
    expect(normalizeMimoRegion("BY")).toBe("ru");
    expect(normalizeMimoRegion("nope")).toBeNull();
    expect(normalizeMimoRegion(null)).toBeNull();
  });

  it("resolves account base from connection override first", () => {
    expect(getMimoAccountBase({ mimoRegion: "cn" })).toBe("https://mimo-server-cn.xiaomimimo.com/api");
    expect(getMimoAccountBase({ mimoRegion: "ru" })).toBe("https://mimo-server-ru.xiaomimimo.com/api");
    expect(getMimoAccountBase({ mimoRegion: "in" })).toBe("https://mimo-server-in.xiaomimimo.com/api");
    expect(getMimoAccountBase({ mimoRegion: "sgp" })).toBe("https://mimo-server-sgp.xiaomimimo.com/api");
  });

  it("falls back to sgp when no region is available", () => {
    // Force default path without reading Desktop cache by passing an unknown region
    // and stubbing is not needed — unknown region falls through to sgp host.
    expect(getMimoAccountBase({ mimoRegion: "xx-nope" })).toBe("https://mimo-server-sgp.xiaomimimo.com/api");
    expect(getMimoAccountBase(null)).toMatch(/^https:\/\/mimo-server-(sgp|cn|ru|in)\.xiaomimimo\.com\/api$/);
  });

  it("exposes host map for Desktop overseas regions", () => {
    expect(mimoTest.ACCOUNT_HOSTS.sgp).toBe("mimo-server-sgp.xiaomimimo.com");
    expect(mimoTest.ACCOUNT_HOSTS.cn).toBe("mimo-server-cn.xiaomimimo.com");
    expect(mimoTest.DEFAULT_REGION).toBe("sgp");
  });

  it("can read Desktop region when present (optional live host check)", () => {
    const r = readDesktopRegion();
    // On machines without Desktop this is null; with Desktop it is a known region.
    if (r !== null) {
      expect(["sgp", "cn", "ru", "in"]).toContain(r);
    }
  });
});
