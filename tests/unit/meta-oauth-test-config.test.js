/**
 * Muse Code (meta) OAuth connection test must be registered.
 * Run: cd tests && npx vitest run unit/meta-oauth-test-config.test.js
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const src = readFileSync(
  join(root, "src/app/api/providers/[id]/test/testUtils.js"),
  "utf8",
);

describe("muse code (meta) connection test support", () => {
  it("registers meta in OAUTH_TEST_CONFIG", () => {
    expect(src).toMatch(/meta:\s*\{[\s\S]*?refreshable:\s*false/);
  });

  it("probes Meta models validateUrl with the Muse Code CLI user-agent", () => {
    expect(src).toMatch(/api\.meta\.ai\/v1\/models/);
    expect(src).toMatch(/muse-code\//);
  });

  it("rejects non-LLM| tokens with a re-import hint", () => {
    expect(src).toMatch(/startsWith\("LLM\|"\)/);
    expect(src).toMatch(/Re-import from Muse CLI/);
  });
});
