// Minimal unit checks for toolDeduper 9router-web rules + JSONC parse (no test runner required).
import assert from "assert";
import { dedupeTools } from "../open-sse/utils/toolDeduper.js";

// paired: search tool strips only WebSearch
{
  const { tools, stripped } = dedupeTools([
    { name: "mcp__9router-web__web_search" },
    { name: "WebSearch" },
    { name: "WebFetch" },
    { name: "Bash" },
  ]);
  assert.deepStrictEqual(stripped, ["WebSearch"]);
  assert.ok(tools.some((t) => t.name === "WebFetch"));
  assert.ok(tools.some((t) => t.name === "mcp__9router-web__web_search"));
}

// both MCP tools → both built-ins gone
{
  const { stripped } = dedupeTools([
    { name: "mcp__9router-web__web_search" },
    { name: "mcp__9router-web__web_fetch" },
    { name: "WebSearch" },
    { name: "WebFetch" },
  ]);
  assert.deepStrictEqual(stripped.sort(), ["WebFetch", "WebSearch"]);
}

// no MCP → no strip
{
  const { stripped } = dedupeTools([{ name: "WebSearch" }, { name: "Bash" }]);
  assert.deepStrictEqual(stripped, []);
}

console.log("toolDeduper 9router-web tests OK");
