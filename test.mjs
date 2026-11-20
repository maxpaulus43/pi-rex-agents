import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import extension, { parseAgentFile, piCommand } from "./index.ts";

test("agent files parse, and scouts are read-only", () => {
  const scout = parseAgentFile(readFileSync(new URL("./agents/scout.md", import.meta.url), "utf8"), "x");
  assert.equal(scout.kind, "scout");
  assert.equal(scout.model, undefined);
  assert.ok(scout.tools?.length, "the built-in scout declares its allowlist");
  const worker = parseAgentFile(readFileSync(new URL("./agents/worker.md", import.meta.url), "utf8"), "x");
  assert.equal(worker.kind, "worker");
  assert.equal(worker.model, undefined);

  const custom = parseAgentFile("---\ntools: [read, bash]\n---\nhi", "fallback");
  assert.deepEqual([custom.name, custom.kind, custom.tools, custom.prompt], ["fallback", "worker", ["read", "bash"], "hi"]);

  const cmd = piCommand({ name: "ada", id: "id1", def: scout, model: scout.model, placement: "split" }, "find X", "/ext.ts");
  const tools = cmd[cmd.indexOf("--tools") + 1].split(",");
  const fallback = piCommand({ name: "ada", id: "id1", def: { ...scout, tools: undefined }, placement: "split" }, undefined);
  assert.equal(tools.join(","), fallback[fallback.indexOf("--tools") + 1]);
  for (const t of ["bash", "edit", "write", "agent_spawn"]) assert.ok(!tools.includes(t), t);
  assert.ok(tools.includes("web_search") && tools.includes("ask_parent"));
  assert.ok(cmd.includes("--no-mcp"));
  assert.deepEqual(cmd.slice(-2), ["--", "find X"]);

  const w = piCommand({ name: "bo", id: "id2", def: worker, placement: "split" }, undefined);
  assert.ok(!w.includes("--tools") && !w.includes("--no-mcp") && !w.includes("--"));
  assert.deepEqual(w.slice(0, 4), ["env", "PI_REX_AGENT_ID=id2", "pi", "--session-id"]);
});

test("parallel spawns reserve the first unused name for each definition", async () => {
  const tools = new Map();
  const pending = [];
  extension({
    on() {},
    registerTool: (tool) => tools.set(tool.name, tool),
    exec: () => new Promise((_, reject) => pending.push(reject)),
  });
  const ctx = { isProjectTrusted: () => false };
  const spawn = (agent, name) => tools.get("agent_spawn").execute("", { agent, name, host: "test", task: "test" }, undefined, undefined, ctx);
  const scout1 = assert.rejects(spawn("scout"), /launch failed/);
  const scout2 = assert.rejects(spawn("scout"), /launch failed/);
  const worker1 = assert.rejects(spawn("worker"), /launch failed/);
  const duplicates = [
    assert.rejects(spawn("scout", "scout-1"), /Name "scout-1" is taken/),
    assert.rejects(spawn("scout", "scout-2"), /Name "scout-2" is taken/),
    assert.rejects(spawn("worker", "worker-1"), /Name "worker-1" is taken/),
  ];
  for (const reject of pending.splice(0)) reject(new Error("launch failed"));
  await Promise.all([scout1, scout2, worker1, ...duplicates]);
  const retry = assert.rejects(spawn("scout", "scout-1"), /launch failed/);
  pending[0](new Error("launch failed"));
  await retry;
});
