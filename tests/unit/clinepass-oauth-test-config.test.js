/**
 * ClinePass OAuth connection test must be registered (same family as Cline).
 * Run: cd tests && npx vitest run unit/clinepass-oauth-test-config.test.js
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

describe("clinepass connection test support", () => {
  it("registers clinepass in OAUTH_TEST_CONFIG", () => {
    expect(src).toMatch(/clinepass:\s*\{\s*refreshable:\s*true\s*\}/);
  });

  it("probes clinepass with the same Cline users/me path", () => {
    expect(src).toMatch(/CLINE_FAMILY\.has\(connection\.provider\)/);
    expect(src).toMatch(/api\.cline\.bot\/api\/v1\/users\/me/);
  });

  it("includes clinepass in OAuth token refresh", () => {
    expect(src).toMatch(/CLINE_FAMILY\.has\(provider\)/);
  });
});
