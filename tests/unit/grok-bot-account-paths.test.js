import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sandSecretsPathCandidates,
  desktopStatusPathCandidates,
  userDataRoots,
  isSealedBlob,
  parseCursorAccountsScope,
  parseSandSecretsSchema,
  readDesktopStatus,
  discoverGrokBotDesktop,
  SEALED_PREFIX,
  ENCRYPTION,
  KEYCHAIN_SERVICE,
} from "../../open-sse/shared/grokBotAccount.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../fixtures/grok-bot");

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8"));
}

describe("grok-bot Desktop discover (PR-A)", () => {
  it("lists Grok Bot user-data roots with sand-secrets + desktop-status candidates", () => {
    const roots = userDataRoots();
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.some((r) => r.includes("Grok Bot"))).toBe(true);

    const secrets = sandSecretsPathCandidates();
    expect(secrets.every((p) => p.endsWith("sand-secrets.json"))).toBe(true);
    expect(secrets[0]).toContain("Grok Bot");

    const status = desktopStatusPathCandidates();
    expect(status.every((p) => p.endsWith("desktop-status.json"))).toBe(true);
  });

  it("recognizes electron-safeStorage-v10 sealed blobs (djEw prefix)", () => {
    expect(SEALED_PREFIX).toBe("djEw");
    expect(isSealedBlob("djEwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=")).toBe(true);
    expect(isSealedBlob("djEw")).toBe(false);
    expect(isSealedBlob("plaintext-token")).toBe(false);
    expect(isSealedBlob(null)).toBe(false);
    expect(isSealedBlob(12)).toBe(false);
  });

  it("parses cursor-accounts scope from fixture without exposing sealed values", () => {
    const data = loadFixture("sand-secrets.signed-in.json");
    const scope = parseCursorAccountsScope(data["cursor-accounts"]);
    expect(scope.ok).toBe(true);
    expect(scope.accountCount).toBe(1);
    expect(scope.accountIds).toEqual(["acct-fixture-001"]);
    expect(scope.active).toBe("acct-fixture-001");
    expect(scope.sealedFieldCount).toBe(3);
    // Ensure the return value has no blob strings
    const dumped = JSON.stringify(scope);
    expect(dumped.includes(SEALED_PREFIX)).toBe(false);
  });

  it("reports accountScopePresent=false for empty accounts object", () => {
    const data = loadFixture("sand-secrets.empty-accounts.json");
    const schema = parseSandSecretsSchema(data);
    expect(schema.ok).toBe(true);
    expect(schema.accountScopePresent).toBe(false);
    expect(schema.accountCount).toBe(0);
    expect(schema.sealedTopLevelCount).toBe(2);
    expect(schema.hasSealedMaterial).toBe(true);
  });

  it("schema parse never returns ciphertext fields", () => {
    const data = loadFixture("sand-secrets.signed-in.json");
    const schema = parseSandSecretsSchema(data);
    expect(schema.accountScopePresent).toBe(true);
    expect(schema.accountCount).toBe(1);
    expect(schema.activeAccountPresent).toBe(true);
    expect(schema.sealedAccountFieldCount).toBe(3);
    expect(schema.hasSealedMaterial).toBe(true);
    const dumped = JSON.stringify(schema);
    expect(dumped.includes("djEw")).toBe(false);
    expect(dumped).not.toMatch(/cursor-access-token|cursor-refresh-token/);
  });

  describe("discoverGrokBotDesktop with temp profile", () => {
    let tmpRoot;
    let prevHome;
    let prevPlatform;

    beforeEach(() => {
      tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "9r-grok-bot-"));
      prevHome = process.env.HOME;
      prevPlatform = process.platform;
      // Force darwin-style path under our temp HOME.
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      process.env.HOME = tmpRoot;
      const appSupport = path.join(tmpRoot, "Library", "Application Support", "Grok Bot");
      fs.mkdirSync(appSupport, { recursive: true });
      fs.copyFileSync(
        path.join(FIXTURES, "sand-secrets.signed-in.json"),
        path.join(appSupport, "sand-secrets.json"),
      );
      fs.copyFileSync(
        path.join(FIXTURES, "desktop-status.signed-in.json"),
        path.join(appSupport, "desktop-status.json"),
      );
    });

    afterEach(() => {
      process.env.HOME = prevHome;
      Object.defineProperty(process, "platform", { value: prevPlatform, configurable: true });
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("discovers signed-in Desktop profile with expected public shape", () => {
      const result = discoverGrokBotDesktop();
      expect(result.found).toBe(true);
      expect(result.path).toContain("sand-secrets.json");
      expect(result.signedIn).toBe(true);
      expect(result.accountScopePresent).toBe(true);
      expect(result.sealed).toBe(true);
      expect(result.encryption).toBe(ENCRYPTION);
      expect(result.keychainService).toBe(KEYCHAIN_SERVICE);
      expect(result.accountCount).toBe(1);
      expect(result.appVersion).toBe("0.57.1");
      expect(result.hasSealedMaterial).toBe(true);

      const dumped = JSON.stringify(result);
      expect(dumped.includes("djEw")).toBe(false);
      expect(dumped).not.toMatch(/cursor-access-token|eyJ/);
    });

    it("reports signedIn=false when desktop-status says so", () => {
      const appSupport = path.join(tmpRoot, "Library", "Application Support", "Grok Bot");
      fs.copyFileSync(
        path.join(FIXTURES, "desktop-status.signed-out.json"),
        path.join(appSupport, "desktop-status.json"),
      );
      const result = discoverGrokBotDesktop();
      expect(result.found).toBe(true);
      expect(result.signedIn).toBe(false);
      expect(result.accountScopePresent).toBe(true);
    });

    it("returns found=false when sand-secrets is missing", () => {
      const appSupport = path.join(tmpRoot, "Library", "Application Support", "Grok Bot");
      fs.unlinkSync(path.join(appSupport, "sand-secrets.json"));
      const result = discoverGrokBotDesktop();
      expect(result.found).toBe(false);
      expect(result.accountScopePresent).toBe(false);
      expect(result.error).toMatch(/sand-secrets\.json not found/);
      expect(result.encryption).toBe(ENCRYPTION);
      expect(result.keychainService).toBe(KEYCHAIN_SERVICE);
    });
  });

  it("readDesktopStatus returns nulls when absent", () => {
    const status = readDesktopStatus("/nonexistent/desktop-status.json");
    // explicit path that does not exist → firstExisting-style callers use find;
    // readDesktopStatus with explicit missing path still tries to read and fails softly.
    expect(status.signedIn).toBeNull();
  });
});
