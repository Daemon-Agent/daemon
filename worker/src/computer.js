import { Sandbox } from "e2b";
import { llmJson, llmText, parseJson } from "./llm.js";
import { browseText } from "./tools.js";

export const sandboxEnabled = (env) => Boolean(env.E2B_API_KEY);

const MAX_STEPS = 10;
const WORK = "/home/user/work";

async function open(env, mem) {
  const opts = { apiKey: env.E2B_API_KEY, timeoutMs: 6 * 60e3 };
  if (mem.sandboxId) {
    try {
      return { sbx: await Sandbox.connect(mem.sandboxId, opts), fresh: false };
    } catch {
      delete mem.sandboxId;
    }
  }
  const sbx = await Sandbox.create({ ...opts, lifecycle: { onTimeout: "pause" }, metadata: { app: "daemon" } });
  mem.sandboxId = sbx.sandboxId;
  await sbx.commands.run(`mkdir -p ${WORK}`, { timeoutMs: 15000 });
  return { sbx, fresh: true };
}

async function sh(sbx, cmd, timeoutMs = 60000) {
  try {
    const r = await sbx.commands.run(cmd, { cwd: WORK, timeoutMs });
    return { code: r.exitCode, out: `${r.stdout || ""}${r.stderr ? `\n[stderr] ${r.stderr}` : ""}` };
  } catch (e) {
    if (e && typeof e.exitCode === "number") return { code: e.exitCode, out: `${e.stdout || ""}\n[stderr] ${e.stderr || e.message}` };
    return { code: -1, out: `[error] ${e?.message || e}` };
  }
}

function parseAction(raw) {
  if (raw && typeof raw === "object") return raw;
  const txt = String(raw || "");
  const fences = [...txt.matchAll(/```([a-z]*)[^\n]*\n([\s\S]*?)```/gi)];
  const jsonFence = fences.find((f) => f[1].toLowerCase() === "json" || f[2].trim().startsWith('{"'));
  const body = fences.find((f) => f !== jsonFence);
  let head = jsonFence ? jsonFence[2] : (fences.length ? txt.slice(0, fences[0].index) : txt);
  const a = head.indexOf("{");
  if (a < 0) throw new Error("reply had no JSON action");
  head = head.slice(a);
  let out = null;
  for (let b = head.lastIndexOf("}"); b > 0 && !out; b = head.lastIndexOf("}", b - 1)) {
    try { out = JSON.parse(head.slice(0, b + 1)); } catch {}
  }
  if (!out) out = parseJson(head);
  out.args = out.args || {};
  if (body) {
    if (out.action === "python" && !out.args.code) out.args.code = body[2];
    if (out.action === "write" && !out.args.content) out.args.content = body[2];
    if (out.action === "sh" && !out.args.cmd) out.args.cmd = body[2].trim();
  }
  return out;
}

const tail = (s, n = 2500) => (s.length > n ? `...${s.slice(-n)}` : s);
const nonEmpty = (s) => String(s || "").split("\n").map((l) => l.trim()).filter(Boolean);
const first = (r) => {
  const l = nonEmpty(r.out);
  return (r.code === 0 ? l[0] : l.at(-1))?.slice(0, 100) || "(no output)";
};

function system(a, payRule) {
  return `You are "${a.name}", an always-on agent on DAEMON with your own Linux computer (Debian, python3, pip, curl, node). Your files in ${WORK} persist between runs.
Your job: ${a.job}
${a.plan.args?.goal ? `Concrete goal: ${a.plan.args.goal}\n` : ""}${a.plan.notify_when ? `Your owner wants a ping when: ${a.plan.notify_when}\n` : ""}${payRule ? `Payment rule: ${payRule}\n` : ""}You wake up on a schedule. Do one useful pass on the job, then finish.
How to work: files lists what is already in ${WORK}. Python scripts use the standard library only (urllib.request, json), no pip. Treat missing fields in API data as normal (use .get). steps_so_far shows what you already ran and what it returned, never repeat a command you already ran. Prefer JSON APIs over scraping HTML. On the first run, write one reusable script (for example run.py) that does the whole pass. Writing a .py, .sh or .js file runs it right away and shows you the output. If it fails, write a fixed version once, using the error. On later runs, if the script exists, run it with sh and read its output. Finish with done well before the action limit.
Each reply is ONE action: a single-line JSON object, nothing else. For python and write, do NOT put the code or file content inside the JSON: put it in one fenced block right after the JSON line.
{"thought":"short","action":"sh","args":{"cmd":"..."}}
{"thought":"short","action":"python"}
\`\`\`python
print("code goes here")
\`\`\`
{"thought":"short","action":"write","args":{"path":"relative/path"}}
\`\`\`
file content goes here
\`\`\`
{"thought":"short","action":"browse","args":{"url":"https://..."}}  (real headless browser, returns page text and links)
${payRule ? `{"thought":"short","action":"request_payment","args":{"to":"0x...","amount_eth":0.001,"reason":"..."}}  (waits for owner approval, never instant)\n` : ""}{"thought":"short","action":"done","args":{"log":["1 to 3 concrete lines about what you found"],"notes":"memory for next run, under 500 chars, mention useful files","notify":false,"report":"if notify: 1 to 5 short lines for your owner with links"}}
Rules: never invent facts, only report what your commands and pages returned. No logins, no posting, no messaging anyone. Max ${MAX_STEPS} actions per run. Lowercase dry terminal voice.`;
}

export async function runComputer(env, a, mem, { budgetSec = 180, payRule = "", model = "agent" } = {}) {
  const t0 = Date.now();
  const lines = [];
  const steps = [];
  let final = null;
  let payment = null;
  let lastSig = "";
  const { sbx, fresh } = await open(env, mem);
  lines.push(fresh ? "booted a fresh computer." : "woke its computer up. files still there.");
  try {
    const files = (await sh(sbx, "ls -la --time-style=+%m-%d_%H:%M | tail -n +2 | head -30", 15000)).out.trim() || "(empty)";
    for (let i = 0; i < MAX_STEPS && !final; i++) {
      if ((Date.now() - t0) / 1000 > budgetSec) {
        lines.push("out of computer time for this run.");
        break;
      }
      const { text, provider } = await llmText(env, model, {
        system: system(a, payRule),
        user: JSON.stringify({ time_utc: new Date().toISOString(), notes: mem.notes || "(empty: first run)", files, steps_so_far: steps.slice(-8) }),
        maxTokens: 1200,
      });
      mem.model = provider;
      let out;
      try {
        out = parseAction(text);
      } catch (e) {
        steps.push({ action: "invalid", result: `[error] your reply was not a valid action (${e.message.slice(0, 80)}). reply with one JSON line, code in a fenced block after it.` });
        continue;
      }
      const act = String(out.action || "");
      const args = out.args || {};
      const sig = JSON.stringify([act, args]);
      if (act !== "done" && sig === lastSig) {
        steps.push({ action: act, result: "[error] identical to your previous action, skipped. do the next thing: run it, read the output, or finish with done." });
        continue;
      }
      lastSig = sig;
      let result;
      if (act === "done") {
        final = args;
        break;
      } else if (act === "sh") {
        const r = await sh(sbx, String(args.cmd || "true"));
        result = `exit ${r.code}\n${tail(r.out)}`;
        lines.push(`$ ${String(args.cmd).slice(0, 100)}`, `  ${first(r)}`);
      } else if (act === "python") {
        await sbx.files.write(`${WORK}/.step.py`, String(args.code || ""));
        const r = await sh(sbx, "python3 .step.py", 90000);
        result = `exit ${r.code}\n${tail(r.out)}`;
        lines.push(`$ python3 (${String(args.code || "").split("\n").length} lines)`, `  ${first(r)}`);
      } else if (act === "write") {
        const path = String(args.path || "note.txt").replace(/^\/+/, "").replace(/\.\.+/g, ".");
        await sbx.files.write(`${WORK}/${path}`, String(args.content || ""));
        const n = String(args.content || "").split("\n").length;
        lines.push(`wrote ${path} (${n} lines)`);
        const run = { py: "python3", sh: "bash", js: "node" }[path.split(".").pop()];
        if (run) {
          const r = await sh(sbx, `${run} ${path}`, 90000);
          result = `wrote ${path} and ran it: exit ${r.code}\n${tail(r.out)}`;
          lines.push(`$ ${run} ${path}`, `  ${first(r)}`);
        } else {
          result = `wrote ${path} (${n} lines)`;
        }
      } else if (act === "browse") {
        try {
          const p = await browseText(env, String(args.url));
          result = JSON.stringify(p).slice(0, 4000);
          lines.push(`opened ${new URL(p.url).host} in its browser: "${String(p.title).slice(0, 60)}"`);
        } catch (e) {
          result = `[error] ${e.message}`;
          lines.push(`browser couldn't open ${String(args.url).slice(0, 60)}`);
        }
      } else if (act === "request_payment" && payRule && !payment) {
        payment = { to: args.to, amount_eth: args.amount_eth, reason: String(args.reason || "").slice(0, 160) };
        result = "queued for owner approval in telegram. continue or finish.";
      } else {
        result = `[error] unknown action "${act}"`;
      }
      const brief = act === "write" ? { path: args.path, content: String(args.content || "").slice(0, 1200) } : act === "python" ? { code: String(args.code || "").slice(0, 600) } : args;
      steps.push({ action: act, args: brief, result });
    }
    if (!final) {
      final = await llmJson(env, "big", {
        system: `This agent run hit its action limit before finishing. Write its log. Use only facts from the LATEST step results (later steps override earlier ones): name files, counts, titles or errors you actually see. Never describe the actions themselves ("ran a command", "listed a file"). Short lowercase terminal voice. Return only JSON {"log":["1 to 2 lines, under 110 chars each"],"notes":"under 500 chars: what works, what failed, what to do next run, file names","notify":false,"report":""}`,
        user: JSON.stringify({ job: a.job, previous_notes: mem.notes || "", steps }),
        maxTokens: 400,
      }).then((r) => r.out).catch(() => ({ log: [`ran ${steps.length} steps, no summary this time.`], notes: mem.notes || "" }));
    }
  } finally {
    await sbx.pause().catch(() => sbx.kill().catch(() => {}));
  }
  return { lines, final, payment, seconds: Math.ceil((Date.now() - t0) / 1000) };
}
