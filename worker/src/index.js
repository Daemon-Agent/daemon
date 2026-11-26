import { runAgent, tick } from "./agents.js";
import { llmName } from "./llm.js";
import { botUsername, describe, ensureWebhook, every, handleUpdate, hookSecret, insertAgent, newAgent, planJob } from "./tg.js";
import { claimCode, converse, daemonsOf, saveTurns, session } from "./chat.js";
import { useRpc } from "./onchain.js";
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

const SID = /^[a-f0-9]{24}$/;
const MAX_TRIALS = 25;

async function tgLink(env, code) {
  const name = await botUsername(env).catch(() => null);
  return name ? `https://t.me/${name}${code ? `?start=${code}` : ""}` : null;
}

async function trialView(env, id) {
  if (!id) return null;
  const a = await env.DB.prepare("SELECT id,job,step,status,every_min,run_cap,runs_total FROM agents WHERE id=?").bind(id).first();
  if (!a) return null;
  const { results } = await env.DB.prepare("SELECT ts,line FROM logs WHERE agent_id=? ORDER BY id DESC LIMIT 14").bind(id).all();
  return { id: a.id, job: a.job, step: a.step, status: a.status, every_min: a.every_min, runsLeft: Math.max(0, a.run_cap - a.runs_total), log: results.reverse().map((l) => `${hhmm(l.ts)} ${l.line}`) };
}

function offerView(o) {
  return o ? { key: o.key, what: describe(o.plan), cadence: o.plan.deep ? "one-time, about 10 minutes, then report.md" : every(o.plan.every_min), telegramOnly: o.plan.tool === "computer" } : null;
}

async function chatGet(env, url) {
  const sid = url.searchParams.get("sid") || "";
  if (!SID.test(sid)) return json({ error: "bad session" }, 400);
  const s = await env.DB.prepare("SELECT * FROM chats WHERE sid=?").bind(sid).first();
  if (!s) return json({ turns: [], agent: null, offer: null });
  return json({
    turns: JSON.parse(s.turns || "[]"),
    agent: await trialView(env, s.agent_id),
    offer: offerView(s.offer ? JSON.parse(s.offer) : null),
    telegram: s.claim ? await tgLink(env, s.claim) : null,
  });
}

async function chatPost(env, req) {
  const { sid, text } = await req.json().catch(() => ({}));
  if (!SID.test(String(sid || ""))) return json({ error: "bad session" }, 400);
  const msg = String(text || "").trim().slice(0, 500);
  if (!msg) return json({ error: "empty message" }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (!(await allow(env, `chat:${sid}`, 40, 86400e3)) || !(await allow(env, `chatip:${ip}`, 80, 86400e3))) {
    return json({ say: "that's today's limit for web chat. telegram has more room, and your daemon keeps working either way.", telegram: await tgLink(env) }, 429);
  }
  const s = await session(env, sid);
  const daemons = s.agent_id ? await daemonsOf(env, "id=?", s.agent_id) : [];
  const r = await converse(env, { turns: s.turns, text: msg, daemons });
  let offer = null;
  if (r.offer) {
    const p = await planJob(env, r.offer);
    if (p.plan) offer = { key: crypto.randomUUID().slice(0, 8), plan: p.plan, ask: r.offer };
  }
  const turns = [...s.turns, { role: "user", text: msg }, { role: "daemon", text: r.say }];
  await saveTurns(env, sid, turns, { offer: offer ? JSON.stringify(offer) : null });
  return json({ say: r.say, offer: offerView(offer), looked: r.tools });
}

async function chatStart(env, req, ctx) {
  const { sid, key } = await req.json().catch(() => ({}));
  if (!SID.test(String(sid || ""))) return json({ error: "bad session" }, 400);
  const s = await session(env, sid);
  if (!s.offer || s.offer.key !== key) return json({ error: "that offer expired. ask again." }, 409);
  const { plan, ask } = s.offer;
  const code = claimCode();
  if (plan.tool === "computer") {
    await saveTurns(env, sid, s.turns, { claim: code });
    return json({ say: "this one works on its own linux computer, and computer minutes belong to a telegram owner. open telegram and it starts there.", telegram: await tgLink(env, code) });
  }
  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  if (!(await allow(env, `start:${ip}`, 6, 3600e3))) return json({ error: "you've started 6 daemons this hour. the last ones are still working." }, 429);
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM agents WHERE kind='trial' AND status='active'").bind().first();
  if (n >= MAX_TRIALS) return json({ error: "the office is full of visitor daemons right now. try again in a few minutes, or start it in telegram.", telegram: await tgLink(env) }, 503);
  if (s.agent_id) await env.DB.prepare("UPDATE agents SET status='done', step='replaced by a new job' WHERE id=? AND kind='trial'").bind(s.agent_id).run();
  const a = newAgent(plan, ask, { kind: "trial", isPublic: 1, runCap: 12 });
  await insertAgent(env, a);
  const r = await runAgent(env, a, { ctx });
  const say = `${a.id} is on the job. ${describe(plan)} checks ${every(plan.every_min)}, 11 more looks here. move it to telegram to keep it running and get the pings.`;
  await saveTurns(env, sid, [...s.turns, { role: "daemon", text: say }], { agent_id: a.id, claim: code, offer: null });
  return json({ say, agent: await trialView(env, a.id), firstLook: r.lines, telegram: await tgLink(env, code) });
}

async function gallery(env) {
  const { results } = await env.DB.prepare(
    `SELECT f.id, f.name, f.mime, f.size, f.ts, a.id agent, a.job FROM files f JOIN agents a ON a.id=f.agent_id
     WHERE a.public=1 ORDER BY f.ts DESC LIMIT 24`
  ).all();
  return { files: results.map((f) => ({ ...f, url: `/api/file/${f.id}/${encodeURIComponent(f.name)}` })) };
}

async function fileGet(env, id) {
  const f = await env.DB.prepare("SELECT f.name, f.mime, f.body FROM files f JOIN agents a ON a.id=f.agent_id WHERE f.id=? AND a.public=1").bind(id).first();
  if (!f) return new Response("not found", { status: 404 });
  const bin = Uint8Array.from(atob(f.body), (c) => c.charCodeAt(0));
  const inline = /^image\/|^text\//.test(f.mime);
  return new Response(bin, {
    headers: {
      "content-type": f.mime.startsWith("text/") ? `${f.mime === "text/html" ? "text/plain" : f.mime}; charset=utf-8` : f.mime,
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${f.name.replace(/[^\w.\-]/g, "_")}"`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
      "cache-control": "public, max-age=3600",
    },
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

  if (p === "/api/chat" && req.method === "GET") return chatGet(env, url);
  if (p === "/api/chat" && req.method === "POST") return chatPost(env, req);
  if (p === "/api/chat/start" && req.method === "POST") return chatStart(env, req, ctx);
  if (p === "/api/files" && req.method === "GET") return json(await gallery(env));
  if (p.startsWith("/api/file/")) return fileGet(env, p.split("/")[3] || "");

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
    useRpc(env);
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
    useRpc(env);
    ctx.waitUntil(
      Promise.all([
        tick(env, ctx),
        ensureWebhook(env).catch((e) => console.log("webhook", e.message)),
      ])
    );
  },
};
