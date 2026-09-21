import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decryptOsCryptV10,
  encryptOsCryptV10,
  decryptGrokBotDesktopCredentials,
  readGrokBotKeychainPassword,
  isSealedBlob,
  SEALED_PREFIX,
  CHAT_PATH_PROBE,
  KEYCHAIN_SERVICE,
  KEYCHAIN_ACCOUNT,
} from "../../open-sse/shared/grokBotAccount.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "../fixtures/grok-bot");
const META = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, "decrypt-vector.meta.json"), "utf-8"),
);

describe("grok-bot OSCrypt v10 decrypt (PR-B, no live Keychain)", () => {
  it("round-trips encrypt → decrypt with fixture password", () => {
    const password = META.password;
    const sealed = encryptOsCryptV10("hello-sandbox", password);
    expect(sealed.startsWith(SEALED_PREFIX)).toBe(true);
    expect(isSealedBlob(sealed)).toBe(true);
    expect(decryptOsCryptV10(sealed, password)).toBe("hello-sandbox");
  });

  it("decrypts sand-secrets.decryptable.json fixture without Keychain", () => {
    const secretsPath = path.join(FIXTURES, "sand-secrets.decryptable.json");
    const result = decryptGrokBotDesktopCredentials({
      secretsPath,
      password: META.password,
    });
    expect(result.ok).toBe(true);
    expect(result.accessToken).toBe(META.expected.accessToken);
    expect(result.refreshToken).toBe(META.expected.refreshToken);
    expect(result.machineId).toBe(META.expected.machineId);
    expect(result.email).toBe(META.expected.email);
    expect(result.name).toBe(META.expected.name);
    expect(result.chatPathProbe.status).toBe("blocked");
    // Must not leak password into result
    expect(JSON.stringify(result).includes(META.password)).toBe(false);
  });

  it("mocks Keychain reader instead of calling security(1)", () => {
    const secretsPath = path.join(FIXTURES, "sand-secrets.decryptable.json");
    let calls = 0;
    const result = decryptGrokBotDesktopCredentials({
      secretsPath,
      keychainReader: () => {
        calls += 1;
        return META.password;
      },
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.machineId).toBe(META.expected.machineId);
  });

  it("readGrokBotKeychainPassword uses injectable runner (no live Keychain)", () => {
    const got = readGrokBotKeychainPassword({
      runner: (cmd, args) => {
        expect(cmd).toBe("security");
        expect(args).toContain(KEYCHAIN_SERVICE);
        expect(args).toContain(KEYCHAIN_ACCOUNT);
        expect(args).toContain("-w");
        return META.password;
      },
    });
    expect(got).toBe(META.password);
  });

  it("rejects non-v10 blobs", () => {
    expect(() => decryptOsCryptV10("not-sealed", "x")).toThrow(/v10/i);
  });

  it("exports honest chat path probe status", () => {
    expect(CHAT_PATH_PROBE.status).toBe("blocked");
    expect(CHAT_PATH_PROBE.agentRunSandRejected).toBe(true);
    expect(CHAT_PATH_PROBE.preferredClientType).toBe("sand");
    expect(CHAT_PATH_PROBE.preferredClientSource).toBe("sand-desktop");
  });
});
