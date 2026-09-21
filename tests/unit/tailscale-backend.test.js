import { describe, it, expect } from "vitest";
import { probeTailscaleStatus, isTailscaleLoggedInStrict, startLogin } from "../../src/lib/tunnel/tailscale/tailscale.js";

describe("tailscale backend resolution", () => {
  it("probes a live backend without forcing the custom socket", async () => {
    const probe = await probeTailscaleStatus({ force: true });
    // On this machine Tailscale.app is logged in via default CLI (no --socket).
    expect(probe.installed).toBe(true);
    expect(["default", "system", "custom"]).toContain(probe.backend);
    if (probe.backend === "default") {
      expect(probe.socketArgs).toEqual([]);
    }
  });

  it("sees macOS Tailscale.app login via strict probe", async () => {
    const loggedIn = await isTailscaleLoggedInStrict();
    // Environment-dependent: if the App/system node is online this must be true
    // and startLogin must not time out waiting for an auth URL.
    const result = await startLogin("test-host");
    if (loggedIn) {
      expect(result.alreadyLoggedIn).toBe(true);
      expect(result.authUrl).toBeUndefined();
    } else {
      expect(result.alreadyLoggedIn || result.authUrl).toBeTruthy();
    }
  });
});
