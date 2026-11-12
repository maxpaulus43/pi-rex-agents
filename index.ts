import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const HERE = dirname(fileURLToPath(import.meta.url));
const REX = process.env.REX_BIN_DIR ? join(process.env.REX_BIN_DIR, "rex") : "rex";
const SHELL = "com.superlogical.terminal.shell";
const SCOUT_TOOLS = ["read", "grep", "find", "ls", "web_enable", "web_search", "fetch_content", "get_search_content", "source_check"];
const NAMES = ["ada", "bo", "cleo", "dex", "eve", "finn", "gus", "hana", "ivy", "jax", "kai", "lux", "mo", "nia", "oz", "pip", "quin", "sol", "tia", "uma", "vic", "wren", "yuri", "zed"];

export interface AgentDef {
  name: string;
  description: string;
  kind: "scout" | "worker";
  model?: string;
  thinking?: string;
  tools?: string[];
  prompt: string;
}

type Placement = "split" | "float" | "window";

interface Agent {
  name: string;
  id: string; // pi session id, also names the result file
  def: AgentDef;
  host?: string;
  cwd?: string;
  model?: string;
  thinking?: string;
  placement: Placement;
  session?: string;
  block?: string;
  alive?: boolean;
  state?: string;
  asked?: string;
}

export function parseAgentFile(text: string, fallbackName: string): AgentDef {
  const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(text);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const tools = Array.isArray(fm.tools) ? fm.tools : typeof fm.tools === "string" ? fm.tools.split(",") : [];
  const list = tools.map((t) => String(t).trim()).filter(Boolean);
  return {
    name: str(fm.name) ?? fallbackName,
    description: str(fm.description) ?? "",
    kind: fm.kind === "scout" ? "scout" : "worker",
    model: str(fm.model),
    thinking: str(fm.thinking),
    tools: list.length ? list : undefined,
    prompt: body.trim(),
  };
}

/** The command a child pane runs. Scouts get a read-only tool allowlist and no MCP tools. */
export function piCommand(a: Agent, task: string | undefined, extPath?: string): string[] {
  const intro = `You are ${a.name}, a ${a.def.kind} subagent started by a parent agent. Your final message is returned to the parent. If you cannot continue without a decision, call ask_parent.`;
  const args = ["env", `PI_REX_AGENT_ID=${a.id}`, "pi", "--session-id", a.id, "--name", a.name];
  if (a.model) args.push("--model", a.model);
  if (a.thinking) args.push("--thinking", a.thinking);
  args.push("--append-system-prompt", `${intro}\n\n${a.def.prompt}`.trim());
  const tools = a.def.tools ?? (a.def.kind === "scout" ? SCOUT_TOOLS : undefined);
  if (tools) args.push("--tools", [...tools, "ask_parent"].join(","));
  if (a.def.kind === "scout") args.push("--no-mcp");
  if (extPath) args.push("-e", extPath);
  if (task) args.push("--", task);
  return args;
}

const lastAssistantText = (messages: any[]) => {
  const m = [...messages].reverse().find((x) => x.role === "assistant");
  if (!m) return "";
  if (m.stopReason === "error") return `Error: ${m.errorMessage ?? "unknown"}`;
  return (m.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
};

export default function (pi: ExtensionAPI) {
  const agents = new Map<string, Agent>();
  const watchers = new Map<string, ChildProcess>();
  let ui: ExtensionContext["ui"] | undefined;

  const rex = async (host: string | undefined, args: string[]) => {
    const r = await pi.exec(REX, host ? ["-S", host, ...args] : args, { timeout: 30_000 });
    if (r.code !== 0) throw new Error(`rex ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout;
  };
  const api = async (host: string | undefined, session: string, method: string, body: object) =>
    JSON.parse(await rex(host, ["api", "call", "-s", session, method, JSON.stringify({ session_id: session, ...body })]));

  const showStatus = () => {
    const live = [...agents.values()].filter((a) => a.alive);
    ui?.setStatus("rex-agents", live.length ? live.map((a) => `${a.name}:${a.state ?? "?"}`).join(" ") : undefined);
  };

  // ---- child side: this pi was spawned by a parent ----
  const childId = process.env.PI_REX_AGENT_ID;
  if (childId) {
    const resultFile = join(getAgentDir(), "rex-agents", `${childId}.md`);
    pi.on("session_start", () => rmSync(resultFile, { force: true }));
    pi.on("agent_end", (event) => {
      mkdirSync(dirname(resultFile), { recursive: true });
      writeFileSync(resultFile, lastAssistantText(event.messages));
    });
    // Close the pane once settled, unless the user aborted or this agent still waits on its own subagents.
    pi.on("agent_settled", (event, ctx) => {
      if (!event.aborted && ![...agents.values()].some((a) => a.alive) && !ctx.hasPendingMessages()) ctx.shutdown();
    });
    pi.registerTool({
      name: "ask_parent",
      label: "Ask Parent",
      description: "Ask the parent agent one short question and wait for its answer. Use only when you cannot proceed without a decision.",
      promptSnippet: "Ask the parent agent a short question and wait for the answer",
      parameters: Type.Object({ question: Type.String({ description: "One short, self-contained question" }) }),
      async execute(_id, { question }, _signal, _onUpdate, ctx) {
        // The dialog makes pi report OSC 7501 blocked/question with this title; the parent watches for it.
        const title = `Question for parent: ${question.replace(/\s+/g, " ").slice(0, 600)}`;
        const answer = await ctx.ui.editor(title, "");
        const text = answer?.trim() ? `Parent answered: ${answer.trim()}` : "No answer. Use your best judgment.";
        return { content: [{ type: "text", text }], details: {} };
      },
    });
  }

  // ---- parent side ----
  const loadDefs = (ctx: ExtensionContext) => {
    const dirs = [join(HERE, "agents"), join(getAgentDir(), "agents")];
    if (ctx.isProjectTrusted()) dirs.push(join(ctx.cwd, CONFIG_DIR_NAME, "agents"));
    const defs = new Map<string, AgentDef>();
    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        try {
          const def = parseAgentFile(readFileSync(join(dir, f), "utf8"), f.slice(0, -3));
          defs.set(def.name, def);
        } catch {}
      }
    }
    return defs;
  };

  const readResult = async (a: Agent) => {
    if (!a.host) {
      const file = join(getAgentDir(), "rex-agents", `${a.id}.md`);
      return existsSync(file) ? readFileSync(file, "utf8") : "";
    }
    // Remote: print the file as base64 in a detached (invisible) block, then capture it.
    const script = `printf '<<%s>>' "$(cat "$HOME/.pi/agent/rex-agents/${a.id}.md" 2>/dev/null | base64 | tr -d '\\n')"`;
    const { block_id } = await api(a.host, a.session!, "session.new_block", {
      flavor: SHELL,
      options: { shell: "none", command: ["sh", "-c", script], exit: { on_completion: false } },
    });
    try {
      await rex(a.host, ["wait", "-s", a.session!, block_id, "--for", "20s"]).catch(() => {});
      const out = await rex(a.host, ["capture", "-s", a.session!, "-b", block_id, "--unwrap"]);
      const b64 = out.replace(/\s/g, "").match(/<<([A-Za-z0-9+/=]*)>>/)?.[1] ?? "";
      return Buffer.from(b64, "base64").toString("utf8");
    } finally {
      await rex(a.host, ["block", "close", "-s", a.session!, block_id]).catch(() => {});
    }
  };

  const tell = (content: string) =>
    pi.sendMessage({ customType: "rex-agent", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });

  const onClosed = async (a: Agent) => {
    a.alive = false;
    a.state = "closed";
    showStatus();
    const result = await readResult(a).catch((e) => `(could not read result: ${e.message})`);
    tell(`Agent ${a.name} settled and closed its pane. Result:\n\n${result.slice(0, 50_000) || "(no result)"}`);
  };

  const onEvent = (line: string) => {
    let ev: any;
    try {
      ev = JSON.parse(line).payload?.event;
    } catch {
      return;
    }
    const blockId = ev?.payload?.block_id;
    const a = [...agents.values()].find((x) => x.block === blockId && x.alive);
    if (!a) return;
    if (ev.type === "block_closed") return void onClosed(a);
    if (ev.type !== "block_event" || ev.payload.name !== "program_status_changed") return;
    const { id, record } = ev.payload.payload ?? {};
    if (id !== "" || !record?.state) return;
    a.state = record.state;
    showStatus();
    if (record.state !== "blocked") return void (a.asked = undefined);
    const msg = record.msg ?? "";
    if (a.asked === msg) return;
    a.asked = msg;
    tell(`Agent ${a.name} is waiting for input (${record.kind ?? "question"}): ${msg}\nReply with agent_send; the text is typed into its prompt and submitted.`);
  };

  const watch = (host: string | undefined, session: string) => {
    const key = `${host ?? ""}|${session}`;
    if (watchers.has(key)) return;
    const p = spawn(REX, [...(host ? ["-S", host] : []), "events", "-s", session, "--json"], { stdio: ["ignore", "pipe", "ignore"] });
    watchers.set(key, p);
    p.on("exit", () => watchers.delete(key));
    createInterface({ input: p.stdout! }).on("line", onEvent);
  };

  const agentsSession = async (host: string | undefined) => {
    const { sessions } = JSON.parse(await rex(host, ["ls", "--json"]));
    const found = sessions.find((s: any) => s.label === "pi-agents");
    if (found) return found.session_id as string;
    return JSON.parse(await rex(host, ["api", "call", "session.create", '{"label":"pi-agents"}'])).session_id as string;
  };

  const place = async (a: Agent, session: string, command: string[]) => {
    const layout = { block: { flavor: SHELL, label: a.name, options: { command, cwd: a.cwd, interactive: true } } };
    const local = !a.host && session === process.env.REX_SESSION;
    if (a.placement === "float") {
      const k = [...agents.values()].filter((x) => x.alive && x.placement === "float").length % 5;
      return api(a.host, session, "session.new_layer", { bounds: [0.05 + 0.04 * k, 0.05 + 0.04 * k, 0.6, 0.7], layout, focus: false });
    }
    // First split goes right of the parent; later ones stack below the newest live sibling.
    const sibling = [...agents.values()].reverse().find((x) => x !== a && x.alive && x.placement === "split" && x.host === a.host && x.session === session);
    const anchor = sibling?.block ?? (local ? process.env.REX_BLOCK : undefined);
    if (a.placement === "split" && anchor) {
      const direction = sibling ? "vertical" : "horizontal";
      const r = await api(a.host, session, "session.new_split", { anchor_id: anchor, direction, side: "after", layout, focus: false }).catch(() => undefined);
      if (r) return r;
    }
    return api(a.host, session, "session.new_window", { window_label: a.name, layout, focus: false });
  };

  const launch = async (a: Agent, task: string | undefined) => {
    const session = !a.host && process.env.REX_SESSION ? process.env.REX_SESSION : await agentsSession(a.host);
    watch(a.host, session);
    a.session = session;
    const r = await place(a, session, piCommand(a, task, a.host ? undefined : join(HERE, "index.ts")));
    Object.assign(a, { block: r.block_ids[0], alive: true, state: "starting", asked: undefined });
    agents.set(a.name, a);
    const { alive, state, asked, ...saved } = a;
    pi.appendEntry("rex-agent", saved);
    showStatus();
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    for (const e of ctx.sessionManager.getEntries() as any[]) {
      if (e.type !== "custom" || e.customType !== "rex-agent") continue;
      const a: Agent = { ...e.data, alive: false };
      agents.set(a.name, a);
      // A pane that still exists is still alive (for example after /reload).
      rex(a.host, ["block", "inspect", "-s", a.session!, a.block!, "--json"]).then(
        () => {
          Object.assign(a, { alive: true, state: "unknown" });
          watch(a.host, a.session!);
          showStatus();
        },
        () => {},
      );
    }
  });
  pi.on("session_shutdown", () => {
    for (const p of watchers.values()) p.kill();
    watchers.clear();
  });

  pi.registerTool({
    name: "agent_spawn",
    label: "Spawn Agent",
    description:
      "Start a named subagent in its own Rex pane. Returns at once. The agent's final result arrives later as a message; questions it asks arrive the same way. Scouts are read-only (files and web). Workers can use every tool and spawn scouts.",
    promptSnippet: "Spawn a named scout (read-only) or worker subagent in a Rex pane",
    promptGuidelines: [
      "Use agent_spawn to delegate independent work. Results and questions from agents arrive automatically; do not poll with agent_list.",
      "Refer to subagents by name. Use agent_send to answer an agent's question or to send a follow-up; it resumes a settled agent.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "Self-contained task. The agent does not see this conversation." }),
      agent: Type.Optional(Type.String({ description: "Agent definition name, such as scout or worker. Default: worker" })),
      name: Type.Optional(Type.String({ description: "Unique short name. Default: picked automatically" })),
      placement: Type.Optional(StringEnum(["split", "float", "window"] as const, { description: "Default: split" })),
      host: Type.Optional(Type.String({ description: "Rex host label to run on another machine (see `rex hosts`)" })),
      model: Type.Optional(Type.String({ description: "provider/model override" })),
      cwd: Type.Optional(Type.String({ description: "Working directory. Default: this one (home on other hosts)" })),
    }),
    async execute(_id, p, _signal, _onUpdate, ctx) {
      const defs = loadDefs(ctx);
      const def = defs.get(p.agent ?? "worker");
      if (!def) throw new Error(`Unknown agent "${p.agent}". Available: ${[...defs.keys()].join(", ")}`);
      const name = p.name ?? NAMES.find((n) => !agents.has(n)) ?? `agent-${agents.size + 1}`;
      if (agents.has(name)) throw new Error(`Name "${name}" is taken`);
      const inherit = !p.model && !def.model && ctx.model;
      const a: Agent = {
        name,
        id: randomUUID(),
        def,
        host: p.host,
        cwd: p.cwd ?? (p.host ? undefined : ctx.cwd),
        model: p.model ?? def.model ?? (inherit ? `${ctx.model!.provider}/${ctx.model!.id}` : undefined),
        thinking: def.thinking ?? (inherit ? pi.getThinkingLevel() : undefined),
        placement: (p.placement as Placement | undefined) ?? "split",
      };
      await launch(a, p.task);
      const where = `${a.placement}${a.host ? ` on ${a.host}` : ""}`;
      return { content: [{ type: "text", text: `Spawned ${name} (${def.name}, ${def.kind}) in a ${where}.` }], details: { name } };
    },
  });

  pi.registerTool({
    name: "agent_send",
    label: "Message Agent",
    description: "Send text to a named subagent: an answer to its question, or a follow-up. A running agent gets it typed into its pane; a settled agent is resumed with it.",
    parameters: Type.Object({ name: Type.String(), message: Type.String() }),
    async execute(_id, { name, message }) {
      const a = agents.get(name);
      if (!a) throw new Error(`No agent "${name}". Known: ${[...agents.keys()].join(", ") || "none"}`);
      if (a.alive) {
        try {
          await rex(a.host, ["send", "-s", a.session!, "-b", a.block!, "--", message]);
          await rex(a.host, ["send-key", "-s", a.session!, "-b", a.block!, "enter"]);
          a.asked = undefined;
          return { content: [{ type: "text", text: `Sent to ${name}.` }], details: {} };
        } catch {
          a.alive = false;
        }
      }
      await launch(a, message);
      return { content: [{ type: "text", text: `Resumed ${name} with the message.` }], details: {} };
    },
  });

  pi.registerTool({
    name: "agent_list",
    label: "List Agents",
    description: "List subagents started from this session, and the agent definitions available to agent_spawn.",
    parameters: Type.Object({}),
    async execute(_id, _p, _signal, _onUpdate, ctx) {
      const rows = [...agents.values()].map(
        (a) => `- ${a.name}: ${a.def.name} (${a.def.kind}) ${a.alive ? a.state : "settled"}${a.host ? ` on ${a.host}` : ""}`,
      );
      const defs = [...loadDefs(ctx).values()].map((d) => `- ${d.name} (${d.kind}${d.model ? `, ${d.model}` : ""}): ${d.description}`);
      return { content: [{ type: "text", text: `Agents:\n${rows.join("\n") || "none"}\n\nDefinitions:\n${defs.join("\n")}` }], details: {} };
    },
  });
}
