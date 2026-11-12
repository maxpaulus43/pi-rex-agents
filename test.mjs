import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseAgentFile, piCommand } from "./index.ts";

test("agent files parse, and scouts are read-only", () => {
  const scout = parseAgentFile(readFileSync(new URL("./agents/scout.md", import.meta.url), "utf8"), "x");
  assert.equal(scout.kind, "scout");
  assert.equal(scout.model, "claude-code/claude-sonnet-5-5");
  const worker = parseAgentFile(readFileSync(new URL("./agents/worker.md", import.meta.url), "utf8"), "x");
  assert.equal(worker.kind, "worker");
  assert.equal(worker.model, undefined);

  const custom = parseAgentFile("---\ntools: [read, bash]\n---\nhi", "fallback");
  assert.deepEqual([custom.name, custom.kind, custom.tools, custom.prompt], ["fallback", "worker", ["read", "bash"], "hi"]);

  const cmd = piCommand({ name: "ada", id: "id1", def: scout, model: scout.model, placement: "split" }, "find X", "/ext.ts");
  const tools = cmd[cmd.indexOf("--tools") + 1].split(",");
  for (const t of ["bash", "edit", "write", "agent_spawn"]) assert.ok(!tools.includes(t), t);
  assert.ok(tools.includes("web_search") && tools.includes("ask_parent"));
  assert.ok(cmd.includes("--no-mcp"));
  assert.deepEqual(cmd.slice(-2), ["--", "find X"]);

  const w = piCommand({ name: "bo", id: "id2", def: worker, placement: "split" }, undefined);
  assert.ok(!w.includes("--tools") && !w.includes("--no-mcp") && !w.includes("--"));
  assert.deepEqual(w.slice(0, 4), ["env", "PI_REX_AGENT_ID=id2", "pi", "--session-id"]);
});
