import { runAgent, tick } from "./agents.js";
import { llmJson, llmName } from "./llm.js";
import { botUsername, ensureWebhook, handleUpdate, hookSecret } from "./tg.js";
import { sandboxEnabled } from "./computer.js";
import { operatorAddress, walletsEnabled } from "./wallet.js";
import { econSummary } from "./econ.js";

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

async function allow(env, key, max, windowMs) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT n, reset FROM hits WHERE k=?").bind(key).first();
  if (!row || row.reset < now) {
    await env.DB.prepare("INSERT INTO hits (k,n,reset) VALUES (?,1,?) ON CONFLICT(k) DO UPDATE SET n=1, reset=excluded.reset").bind(key, now + windowMs).run();
    return true;
  }
  if (row.n >= max) return false;
  await env.DB.prepare("UPDATE hits SET n=n+1 WHERE k=?").bind(key).run();
  return true;
}

const hhmm = (ts) => new Date(ts).toISOString().slice(11, 16);

async function feed(env) {
  const now = Date.now();
  const { results: agents } = await env.DB.prepare(
    `SELECT id,name,job,kind,step,status,every_min,next_run,last_run,created,thumb_at FROM agents
     WHERE public=1 AND (status='active' OR (status='done' AND last_run>?))
     ORDER BY CASE kind WHEN 'house' THEN 0 WHEN 'user' THEN 1 ELSE 2 END, last_run DESC LIMIT 24`
  ).bind(now - 30 * 60e3).all();
  if (!agents.length) return { agents: [] };
  const ids = agents.map((a) => a.id);
  const { results: logs } = await env.DB.prepare(
    `SELECT agent_id, ts, line FROM (
       SELECT agent_id, ts, line, id, ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY id DESC) rn
       FROM logs WHERE agent_id IN (${ids.map(() => "?").join(",")})
     ) WHERE rn <= 30 ORDER BY id`
  ).bind(...ids).all();
  const byAgent = {};
  for (const l of logs) (byAgent[l.agent_id] ||= []).push(l);
  return {
    now,
    agents: agents.map((a) => {
      const log = byAgent[a.id] || [];
      const working = now - a.last_run < 120e3;
      const mins = Math.max(0, Math.round((a.next_run - now) / 60e3));
      return {
        id: a.id,
        name: a.kind === "trial" ? `${a.name} (visitor)` : a.name,
        job: a.job,
        status: a.status === "done" ? "waiting" : working ? "working" : "waiting",
        step: a.status === "done" ? "clocked out" : working ? a.step : `${a.step} · next look ${mins ? `in ${mins}m` : "any minute"}`,
        uptimeSec: Math.floor((now - a.created) / 1000),
        lastLine: log.length ? log[log.length - 1].line : "",
        log: log.map((l) => `${hhmm(l.ts)} ${l.line}`),
        thumb: a.thumb_at ? `/api/thumb/${encodeURIComponent(a.id)}?t=${a.thumb_at}` : null,
      };
    }),
  };
}

const TRIALS = {
  "price-watch": {
    job: "Watch the ETH price and ping on a 0.5% move.",
    plan: { tool: "price", args: { symbol: "ETH", threshold_pct: 0.5 }, notify_when: "ETH moves 0.5% from the reference price" },
  },
  research: {
    job: "Research what's new in AI agents today and write a brief.",
    plan: { tool: "hn", args: { query: "AI agents" }, size: "big", notify_when: "always: a 3 to 5 line brief of the most interesting new stories, with links" },
  },
};

const SAMPLE_THREAD = `From: Dana (landlord)
Subject: lease renewal + plumber

Hi! Your lease ends Jan 31. Rent goes to $2,350 if you renew for 12 months, or $2,500 month-to-month. Can you let me know by Friday? Also the plumber can come Tuesday or Thursday morning, which works for you?`;

async function trial(env, req, ctx) {
  const { job } = await req.json().catch(() => ({}));
  if (job !== "inbox" && !TRIALS[job]) return json({ log: ["pick one of the jobs above."] }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (!(await allow(env, `trial:${ip}`, 5, 3600e3))) {
    return json({ log: ["you've summoned 5 trial daemons this hour. they're still working. come back later."] }, 429);
  }

  if (job === "inbox") {
    const { out, provider } = await llmJson(env, "big", {
      system: `You draft email replies for a busy person. Be brief and warm. You may pick Tuesday morning for the plumber. You must NOT accept, sign or agree to any rent or lease terms: write in first person as the tenant: you're weighing the 12-month option and will confirm before Friday. Return only JSON {"summary":"what the email wants, under 90 chars","draft":"the reply, under 450 chars"}`,
      user: SAMPLE_THREAD,
      maxTokens: 300,
    });
    return json({
      provider,
      log: [
        "i can't open your inbox from a no-login trial, so here's a sample thread (not yours):",
        "  from: dana (landlord) · lease renewal + plumber",
        `read it: ${String(out.summary || "").slice(0, 120)}`,
        "drafted a reply:",
        ...String(out.draft || "").split(/\n+/).map((l) => `  ${l}`),
        "nothing sent. drafts wait for your ok.",
        `mail access is on the roadmap, not live yet. model: ${provider}`,
      ],
    });
  }

  const t = TRIALS[job];
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM agents WHERE kind='trial' AND status='active'").bind().first();
  if (n >= 15) return json({ log: ["the office is full of visitor daemons right now. try again in a few minutes."] }, 503);

  const now = Date.now();
  const id = `visitor-${crypto.randomUUID().slice(0, 4)}`;
  const a = {
    id, name: id, job: t.job, kind: "trial", owner_chat: null, plan: JSON.stringify(t.plan), every_min: 5,
    next_run: now, last_run: 0, created: now, status: "active", memory: "{}", step: "clocking in",
    runs_total: 0, runs_today: 0, day: "", run_cap: 6, public: 1, thumb_at: 0,
  };
  await env.DB.prepare(
    "INSERT INTO agents (id,name,job,kind,plan,every_min,next_run,created,run_cap,public) VALUES (?,?,?,'trial',?,5,?,?,6,1)"
  ).bind(a.id, a.name, a.job, a.plan, now, now).run();
  const r = await runAgent(env, a, { ctx });
  const tgName = await botUsername(env);
  return json({
    id,
    provider: r.provider,
    log: [
      ...r.lines,
      ...(r.report ? ["", ...r.report.split(/\n+/)] : []),
      "",
      `close this tab if you want. ${id} keeps going in the night office: 5 more runs, one every 5 min.`,
      tgName ? `want one that runs for days? t.me/${tgName}` : null,
      r.provider ? `model: ${r.provider}` : null,
    ].filter((l) => l !== null).filter((l, i, arr) => l !== "" || (i > 0 && arr[i - 1] !== "" && i < arr.length - 1)),
  });
}

async function api(req, env, ctx, url) {
  const p = url.pathname;
  if (p === "/api/feed" && req.method === "GET") return json(await feed(env));

  if (p.startsWith("/api/thumb/")) {
    const id = decodeURIComponent(p.slice("/api/thumb/".length));
    const row = await env.DB.prepare("SELECT thumb FROM agents WHERE id=? AND public=1").bind(id).first();
    if (!row?.thumb) return new Response("no thumb", { status: 404 });
    const bin = Uint8Array.from(atob(row.thumb), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=600" } });
  }

  if (p === "/api/trial" && req.method === "POST") return trial(env, req, ctx);

  if (p === "/api/tg" && req.method === "POST") {
    if (!env.TELEGRAM_BOT_TOKEN) return new Response("bot not configured", { status: 404 });
    if (req.headers.get("x-telegram-bot-api-secret-token") !== (await hookSecret(env))) return new Response("nope", { status: 401 });
    const upd = await req.json().catch(() => null);
    if (upd) ctx.waitUntil(handleUpdate(env, upd, ctx, runAgent).catch((e) => console.log("tg update failed", e.message)));
    return new Response("ok");
  }

  if (p === "/api/meta") {
    const tgName = await botUsername(env).catch(() => null);
    const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM agents WHERE status='active'").bind().first();
    return json({
      telegram: tgName ? `https://t.me/${tgName}` : null,
      model: { small: llmName(env, "small"), big: llmName(env, "big"), computer: llmName(env, "agent"), planner: llmName(env, "pro") },
      browser: Boolean(env.BROWSER),
      sandbox: sandboxEnabled(env),
      wallets: walletsEnabled(env) ? { factory: env.WALLET_FACTORY, operator: operatorAddress(env), chainId: 4663 } : null,
      burnPass: env.TOKEN_ADDRESS ? { token: env.TOKEN_ADDRESS, usdPerHour: +env.USD_PER_HOUR || 1 } : null,
      economics: await econSummary(env).catch(() => null),
      activeAgents: n,
    });
  }

  if (p === "/api/burns") {
    const { results } = await env.DB.prepare("SELECT tx, wallet, amount, sec, ts FROM burns ORDER BY ts DESC LIMIT 50").all();
    const total = results.reduce((s, b) => s + BigInt(b.amount), 0n);
    return json({ burns: results, shownTotalWei: total.toString() });
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      return api(req, env, ctx, url).catch((e) => {
        console.log("api error", url.pathname, e.message);
        return json({ error: "server error" }, 500);
      });
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      Promise.all([
        tick(env, ctx),
        ensureWebhook(env).catch((e) => console.log("webhook", e.message)),
      ])
    );
  },
};
