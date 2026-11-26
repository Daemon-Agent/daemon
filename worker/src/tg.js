import { sha } from "./tools.js";
import { llmJson } from "./llm.js";
import { balance } from "./credits.js";
import { sandboxEnabled } from "./computer.js";
import { createWallet, EXPLORER, fmtEth, operatorGas, parseEther, pay, validAddress, walletState, walletsEnabled } from "./wallet.js";
import { classify } from "./onchain.js";
import { converse, daemonsOf, saveTurns, session } from "./chat.js";

const MAX_AGENTS_PER_CHAT = 3;
const MAX_WALLETS_PER_CHAT = 3;
const HOUR = 3600e3;

async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
  return j.result;
}

export async function tgSend(env, chat, text, extra = {}) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  await tg(env, "sendMessage", { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true, ...extra });
  return true;
}

export async function tgFile(env, chat, f, caption = "") {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const photo = f.mime === "image/png" || f.mime === "image/jpeg";
  const form = new FormData();
  form.append("chat_id", chat);
  if (caption) form.append("caption", caption.slice(0, 1000));
  form.append(photo ? "photo" : "document", new Blob([f.bytes], { type: f.mime }), f.name);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${photo ? "sendPhoto" : "sendDocument"}`, { method: "POST", body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram file: ${j.description || r.status}`);
  return true;
}

export const hookSecret = async (env) => (await sha(`daemon-hook:${env.TELEGRAM_BOT_TOKEN}`)).slice(0, 48);

async function meta(env, k, v) {
  if (v === undefined) return (await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first())?.v ?? null;
  await env.DB.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, v).run();
}

export async function botUsername(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  return meta(env, "tg_username");
}

export async function ensureWebhook(env) {
  if (!env.TELEGRAM_BOT_TOKEN) return null;
  const secret = await hookSecret(env);
  const url = `${env.PUBLIC_ORIGIN}/api/tg`;
  const mark = await sha(`${secret}|${url}|v3`);
  if ((await meta(env, "tg_hook")) === mark) return "ok";
  const me = await tg(env, "getMe", {});
  await meta(env, "tg_username", me.username);
  await tg(env, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
  await tg(env, "setMyCommands", {
    commands: [
      { command: "help", description: "what i can do" },
      { command: "summon", description: "start a daemon directly: /summon <job>" },
      { command: "list", description: "your daemons" },
      { command: "log", description: "read a daemon's log: /log <name>" },
      { command: "kill", description: "stop a daemon: /kill <name>" },
      { command: "wallet", description: "give a daemon a capped wallet you own" },
      { command: "credits", description: "night-shift minutes left" },
      { command: "public", description: "show or hide a daemon in the night office" },
    ],
  });
  await meta(env, "tg_hook", mark);
  return "set";
}

const PLANNER = `You turn a person's request into a plan for an always-on DAEMON agent. Pick exactly one tool:
- price {"symbol":"ETH","threshold_pct":1}: watch a crypto price (Coinbase + Kraken) and notice moves.
- hn {"query":"..."}: watch Hacker News for new stories matching a query.
- arxiv {"category":"cs.AI"}: watch new arXiv papers in a category such as cs.AI, cs.MA, cs.CL, cs.CR, q-fin.TR.
- watch_url {"url":"https://..."}: re-read one public web page and notice when it changes.
- rhchain {}: Robinhood Chain blocks and gas.
- wallet {"address":"0x..."}: watch one wallet on Robinhood Chain: Pons buys and sells, token transfers in and out.
- token {"address":"0x...","holders_pct":15,"move_pct":30}: watch one Pons token on Robinhood Chain: dev wallet selling, holder count swings, market cap moves, graduation.
- pons_launches {"min_dev_eth":0.1,"hold_min":10}: watch new Pons launches on Robinhood Chain; report those whose creator bought at least min_dev_eth at launch and has not sold after hold_min minutes.
- computer {"goal":"..."}: the agent's own Linux computer with python, files and a real browser. Use for anything the simple tools can't do: several pages, scraping, comparing, tables, digests, calculations, keeping files over time. It can hand over files (report.md, .csv, chart.png).
For a one-time research or analysis request ("research", "compare", "make me a report", "find all", no ongoing watching), use computer with "deep":true: it works for about 10 minutes in a few passes and delivers report.md (plus csv or chart) once, then stops.
Optional "pay": only if the person explicitly asks the agent to pay someone when something happens: {"to":"0x...","amount_eth":0.001,"when":"condition"}. Payments always wait for the owner's tap.
If the request needs logins, email, posting, messaging other people, private data, trading, or a chain other than Robinhood Chain for wallet/token/launch watching (Solana, Base, Ethereum mainnet tokens), set supported to false and say briefly what is missing.
every_min: how often it checks. Defaults: price 5, hn 30, arxiv 360, watch_url 60, rhchain 30, wallet 10, token 15, pons_launches 10, computer 60. Use the person's timing if they give one ("every morning" = 1440).
Return only JSON: {"supported":true,"reason":"","name":"kebab-case, max 16 chars","job":"one short lowercase sentence restating the job","tool":"price|hn|arxiv|watch_url|rhchain|wallet|token|pons_launches|computer","args":{},"deep":false,"every_min":5,"notify_when":"when to ping the owner, lowercase, under 120 chars","pay":null}`;

const DEFAULT_EVERY = { price: 5, hn: 30, arxiv: 360, watch_url: 60, rhchain: 30, wallet: 10, token: 15, pons_launches: 10, computer: 60 };
const DEEP_PASSES = 3;

function every(min) {
  if (min % 1440 === 0) return min === 1440 ? "once a day" : `every ${min / 1440} days`;
  if (min % 60 === 0) return min === 60 ? "every hour" : `every ${min / 60} hours`;
  return `every ${min} min`;
}

function describe(plan) {
  const a = plan.args;
  if (plan.tool === "price") return `watching ${a.symbol} on coinbase and kraken. pings you on a ${a.threshold_pct}% move either way.`;
  if (plan.tool === "hn") return `watching hacker news for "${a.query}".`;
  if (plan.tool === "arxiv") return `reading new arxiv papers in ${a.category}.`;
  if (plan.tool === "watch_url") return `re-reading ${new URL(a.url).host}${new URL(a.url).pathname.replace(/\/$/, "")}. pings you when it changes.`;
  if (plan.tool === "rhchain") return "watching robinhood chain blocks and gas.";
  if (plan.tool === "wallet") return `watching wallet ${short(a.address)} on robinhood chain: pons trades and token transfers.`;
  if (plan.tool === "token") return `watching token ${short(a.address)} on robinhood chain: dev wallet, holders (±${a.holders_pct}%), market cap (±${a.move_pct}%), graduation.`;
  if (plan.tool === "pons_launches") return `watching new pons launches${a.min_dev_eth ? ` with a dev buy of ${a.min_dev_eth}+ ETH` : ""}${a.hold_min ? `, reported once the dev still holds after ${a.hold_min}m` : ""}.`;
  if (plan.deep) return `one-time research on its own linux computer, about 10 minutes, then a report: ${a.goal}`;
  return `works on its own linux computer: ${a.goal}`;
}

const evmArg = (raw) => {
  const c = classify(raw);
  return c.kind === "evm" ? c.address : null;
};

function validPlan(p) {
  const tool = p.tool;
  const a = p.args || {};
  let args;
  if (tool === "price") {
    const symbol = String(a.symbol || "").toUpperCase();
    if (!/^[A-Z0-9]{2,10}$/.test(symbol)) return null;
    args = { symbol, threshold_pct: Math.min(50, Math.max(0.2, +a.threshold_pct || 1)) };
  } else if (tool === "hn") {
    const query = String(a.query || "").trim().slice(0, 80);
    if (!query) return null;
    args = { query };
  } else if (tool === "arxiv") {
    const category = String(a.category || "");
    if (!/^[a-z\-]+\.[A-Za-z\-]+$/.test(category)) return null;
    args = { category };
  } else if (tool === "watch_url") {
    try {
      const u = new URL(String(a.url));
      if (!/^https?:$/.test(u.protocol)) return null;
      args = { url: u.href };
    } catch {
      return null;
    }
  } else if (tool === "rhchain") {
    args = {};
  } else if (tool === "wallet") {
    const address = evmArg(a.address);
    if (!address) return null;
    args = { address };
  } else if (tool === "token") {
    const address = evmArg(a.address);
    if (!address) return null;
    args = { address, holders_pct: Math.min(100, Math.max(5, +a.holders_pct || 15)), move_pct: Math.min(500, Math.max(5, +a.move_pct || 30)) };
  } else if (tool === "pons_launches") {
    args = { min_dev_eth: Math.min(5, Math.max(0, +a.min_dev_eth || 0)), hold_min: Math.min(120, Math.max(0, a.hold_min === undefined ? 10 : Math.round(+a.hold_min) || 0)) };
  } else if (tool === "computer") {
    const goal = String(a.goal || p.job || "").trim().slice(0, 400);
    if (!goal) return null;
    args = { goal };
  } else return null;
  const deep = tool === "computer" && p.deep === true;
  const min = tool === "price" ? 5 : tool === "computer" ? 60 : ["wallet", "token", "pons_launches"].includes(tool) ? 5 : 15;
  const every = deep ? 5 : Math.min(1440, Math.max(min, Math.round(+p.every_min || DEFAULT_EVERY[tool])));
  const name = (String(p.name || tool).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || tool).slice(0, 16);
  let pay = null;
  if (p.pay && typeof p.pay === "object") {
    const to = validAddress(p.pay.to);
    const amount = +p.pay.amount_eth;
    if (to && amount > 0 && amount <= 0.05) pay = { to, amount_eth: amount, when: String(p.pay.when || "").slice(0, 120) };
  }
  return { name, job: String(p.job || "").slice(0, 200), tool, args, deep: deep ? { passes: DEEP_PASSES } : null, every_min: every, notify_when: String(p.notify_when || "").slice(0, 120), pay };
}

export async function planJob(env, ask) {
  let plan;
  try {
    const { out } = await llmJson(env, "pro", { system: PLANNER, user: ask.slice(0, 600), maxTokens: 350 });
    if (out.supported === false) return { error: `can't do that one yet: ${String(out.reason || "needs tools i don't have").slice(0, 300)}` };
    if (["wallet", "token"].includes(out.tool)) {
      const c = classify(out.args?.address);
      if (c.kind !== "evm") return { error: c.note };
    }
    plan = validPlan(out);
  } catch {
    return { error: "my planner tripped. try saying it a bit differently." };
  }
  if (!plan) return { error: "couldn't turn that into a job i can run. try naming a price, a page url, a topic or what you want it to put together." };
  if (plan.tool === "computer" && !sandboxEnabled(env)) return { error: "that one needs its own computer, and computers aren't switched on yet. try a simpler watch job for now." };
  return { plan };
}

export { describe, every };

const HELP = `daemon here. ask me anything i can look up live, or hand me a job and a daemon keeps doing it after you close telegram.

ask:
• what's ETH doing right now
• check 0x… on robinhood chain (wallet or pons token)
• any pons launches in the last 30 min where the dev bought 0.2+ ETH

hand off:
• watch this wallet and tell me when it buys or sells
• tell me if the dev of this pons token sells
• research the top open-source agent frameworks and send me a report with a table

/summon <job> starts one directly
/list · /log <name> · /kill <name> · /public <name>
/wallet <name> <your 0x> · /credits

public data only. i can't log in, post, email or trade for you. payments from a daemon wallet always wait for your tap.`;

async function findAgent(env, chat, key) {
  if (!key) return null;
  return env.DB.prepare("SELECT * FROM agents WHERE owner_chat=? AND (id=? OR name=?) ORDER BY created DESC LIMIT 1").bind(String(chat), key, key).first();
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const logLine = (env, agentId, line) => env.DB.prepare("INSERT INTO logs (agent_id,ts,line) VALUES (?,?,?)").bind(agentId, Date.now(), line).run();

export async function requestPayment(env, a, p) {
  const w = await env.DB.prepare("SELECT * FROM wallets WHERE agent_id=?").bind(a.id).first();
  if (!w) return "wanted to pay but has no wallet yet. owner can add one with /wallet.";
  const to = validAddress(p.to);
  const amount = +p.amount_eth;
  if (!to || !(amount > 0)) return "payment request was malformed. dropped it.";
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM actions WHERE agent_id=? AND status='pending'").bind(a.id).first();
  if (n >= 3) return "3 payments already waiting for approval. not asking for more.";
  const id = crypto.randomUUID().slice(0, 8);
  const valueWei = parseEther(String(amount)).toString();
  await env.DB.prepare("INSERT INTO actions (id,agent_id,chat,kind,payload,status,created) VALUES (?,?,?,'pay',?,'pending',?)")
    .bind(id, a.id, a.owner_chat, JSON.stringify({ to, value_wei: valueWei, reason: p.reason }), Date.now()).run();
  await tgSend(env, a.owner_chat, `${a.name} wants to pay ${amount} ETH
to: ${to}
why: ${p.reason || "(no reason given)"}
from: ${w.address}
nothing moves until you tap. expires in 24h.`, {
    reply_markup: { inline_keyboard: [[{ text: "approve", callback_data: `ok:${id}` }, { text: "deny", callback_data: `no:${id}` }]] },
  });
  return `asked the owner to approve ${amount} ETH to ${short(to)}. waiting.`;
}

async function onCallback(env, cq) {
  const [kind, id] = String(cq.data || "").split(":");
  const chat = String(cq.message?.chat?.id || "");
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  const edit = (suffix) =>
    tg(env, "editMessageText", { chat_id: chat, message_id: cq.message.message_id, text: `${cq.message.text}\n\n${suffix}`, disable_web_page_preview: true }).catch(() => {});
  const act = await env.DB.prepare("SELECT * FROM actions WHERE id=? AND chat=?").bind(id, chat).first();
  if (!act) return answer("not found");
  if (act.status !== "pending") return answer(`already ${act.status}`);
  if (Date.now() - act.created > 24 * HOUR) {
    await env.DB.prepare("UPDATE actions SET status='expired', decided=? WHERE id=?").bind(Date.now(), id).run();
    await edit("expired. nothing sent.");
    return answer("expired");
  }
  const decided = await env.DB.prepare("UPDATE actions SET status=?, decided=? WHERE id=? AND status='pending'")
    .bind(kind === "ok" ? "approved" : "denied", Date.now(), id).run();
  if (!decided.meta?.changes) return answer("already handled");
  if (kind !== "ok") {
    await logLine(env, act.agent_id, "owner denied a payment. nothing sent.");
    await edit("denied. nothing sent.");
    return answer("denied");
  }
  const p = JSON.parse(act.payload);
  const w = await env.DB.prepare("SELECT * FROM wallets WHERE agent_id=?").bind(act.agent_id).first();
  try {
    const st = await walletState(env, w.address);
    if (st.frozen) throw new Error("the wallet is frozen");
    if (BigInt(p.value_wei) > st.remaining) throw new Error(`over today's cap (${fmtEth(st.remaining)} left). only you can raise the cap, on the contract`);
    if (BigInt(p.value_wei) > st.balance) throw new Error(`the wallet holds ${fmtEth(st.balance)}`);
    const tx = await pay(env, w.address, p.to, p.value_wei, p.reason || "daemon payment");
    await env.DB.prepare("UPDATE actions SET result=? WHERE id=?").bind(tx, id).run();
    await logLine(env, act.agent_id, `owner approved. paid ${fmtEth(p.value_wei)} to ${short(p.to)} (tx ${tx.slice(0, 10)}…)`);
    await edit(`approved. sent: ${EXPLORER}/tx/${tx}`);
  } catch (e) {
    await env.DB.prepare("UPDATE actions SET status='failed', result=? WHERE id=?").bind(String(e.message).slice(0, 200), id).run();
    await logLine(env, act.agent_id, `payment approved but didn't go through: ${String(e.message).slice(0, 80)}`);
    await edit(`approved, but it didn't go through: ${String(e.message).slice(0, 200)}`);
  }
  return answer("done");
}

async function walletCmd(env, chat, parts, say) {
  if (!walletsEnabled(env)) return say("wallets aren't switched on yet.");
  const [key, ownerRaw, capRaw] = parts;
  const a = await findAgent(env, chat, key);
  if (!a) return say("usage: /wallet <name> <your 0x address> [daily cap in ETH, default 0.002]\nyou become the owner: only you can raise the cap, freeze it or withdraw.");
  const existing = await env.DB.prepare("SELECT * FROM wallets WHERE agent_id=?").bind(a.id).first();
  if (existing) {
    const st = await walletState(env, existing.address);
    return say(`${a.id} wallet: ${existing.address}
holds ${fmtEth(st.balance)} · cap ${fmtEth(st.cap)}/day · ${fmtEth(st.remaining)} left today${st.frozen ? " · FROZEN" : ""}
owner: ${st.owner}
${EXPLORER}/address/${existing.address}`);
  }
  const owner = validAddress(ownerRaw);
  if (!owner) return say("add your own 0x address as the owner: /wallet <name> <your 0x address> [daily cap in ETH]");
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM wallets WHERE chat=?").bind(chat).first();
  if (n >= MAX_WALLETS_PER_CHAT) return say(`you already have ${n} daemon wallets.`);
  if ((await operatorGas(env)) < parseEther("0.00002")) return say("the runner is low on gas right now. try again a bit later.");
  const cap = Math.min(1, Math.max(0, +capRaw || 0.002));
  await say("deploying its wallet on robinhood chain...");
  const w = await createWallet(env, a.id, owner, cap);
  await env.DB.prepare("INSERT INTO wallets (agent_id,chat,address,owner,cap_wei,created) VALUES (?,?,?,?,?,?)")
    .bind(a.id, chat, w.address, owner, w.capWei, Date.now()).run();
  await logLine(env, a.id, `got its own wallet on robinhood chain, capped at ${cap} ETH/day.`);
  return say(`wallet for ${a.id}: ${w.address}
owner: you (${owner})
daily cap: ${cap} ETH, enforced by the contract
${EXPLORER}/address/${w.address}

• send ETH for it to spend. every payment still waits for your tap.
• send $DAEMON to it and it burns them for night-shift minutes.
• freeze, change the cap or withdraw any time: blockscout → contract → write, from your owner address.`);
}

const runCapFor = (plan) => (plan.deep ? plan.deep.passes + 2 : Math.min(300, Math.ceil(1440 / plan.every_min) + 2));

export function newAgent(plan, ask, { kind, chat = null, isPublic = 0, runCap }) {
  const now = Date.now();
  const id = `${plan.name}-${crypto.randomUUID().slice(0, 4)}`;
  return {
    id, name: plan.name, job: plan.job || ask.slice(0, 200), kind, owner_chat: chat,
    plan: JSON.stringify({ tool: plan.tool, args: plan.args, notify_when: plan.notify_when, pay: plan.pay, deep: plan.deep || undefined }),
    every_min: plan.every_min, next_run: plan.tool === "computer" ? now : now + plan.every_min * 60e3, last_run: 0, created: now, status: "active",
    memory: "{}", step: "clocking in", runs_total: 0, runs_today: 0, day: "", run_cap: runCap ?? runCapFor(plan), public: isPublic, thumb_at: 0,
  };
}

export async function insertAgent(env, a) {
  await env.DB.prepare(
    "INSERT INTO agents (id,name,job,kind,owner_chat,plan,every_min,next_run,created,run_cap,public) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(a.id, a.name, a.job, a.kind, a.owner_chat, a.plan, a.every_min, a.next_run, a.created, a.run_cap, a.public).run();
}

async function summonPlan(env, chat, plan, ask, say, ctx, runAgent) {
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM agents WHERE owner_chat=? AND status='active'").bind(chat).first();
  if (n >= MAX_AGENTS_PER_CHAT) return say(`you already have ${n} daemons running. /kill one first.`);
  const agent = newAgent(plan, ask, { kind: "user", chat });
  await insertAgent(env, agent);
  const id = agent.id;
  const isComputer = plan.tool === "computer";
  const pingLine = !["price", "watch_url", "token", "pons_launches"].includes(plan.tool) && !plan.deep && plan.notify_when ? `pings you when: ${plan.notify_when}\n` : "";
  const cadence = plan.deep ? `works in ${plan.deep.passes} passes, about 10 minutes of computer time, then sends report.md here.` : `checks ${every(plan.every_min)}.`;
  await say(`${id} is on the job.

${describe(plan)}
${pingLine}${cadence}
${plan.pay ? `pays ${plan.pay.amount_eth} ETH to ${short(plan.pay.to)} when ${plan.pay.when}, only after your tap. needs /wallet ${id} <your 0x> first.\n` : ""}
${isComputer ? "first pass starts within 5 minutes." : "first look coming up."} stop it any time: /kill ${id}`);

  if (!isComputer) {
    ctx.waitUntil(
      runAgent(env, agent, { ctx })
        .then((r) => say(`${id} · first look\n\n${r.lines.join("\n")}`))
        .catch((e) => say(`${id} first run failed: ${String(e.message).slice(0, 120)}`))
    );
  }
}

async function claimWeb(env, chat, code, say, ctx, runAgent) {
  const s = await env.DB.prepare("SELECT * FROM chats WHERE claim=?").bind(code).first();
  if (!s) return say("that link expired. tell me what you need and i'll set it up here.");
  await env.DB.prepare("UPDATE chats SET claim=NULL WHERE sid=?").bind(s.sid).run();
  const a = s.agent_id ? await env.DB.prepare("SELECT * FROM agents WHERE id=?").bind(s.agent_id).first() : null;
  if (!a || a.kind !== "trial") {
    const offer = s.offer ? JSON.parse(s.offer) : null;
    if (!offer) return say(a ? `${a.id} already has an owner.` : "that link expired. tell me what you need and i'll set it up here.");
    await env.DB.prepare("UPDATE chats SET offer=NULL WHERE sid=?").bind(s.sid).run();
    return summonPlan(env, chat, offer.plan, offer.ask, say, ctx, runAgent);
  }
  const { n } = await env.DB.prepare("SELECT COUNT(*) n FROM agents WHERE owner_chat=? AND status='active'").bind(chat).first();
  if (n >= MAX_AGENTS_PER_CHAT) return say(`you already have ${n} daemons running. /kill one first, then open the link again.`);
  const now = Date.now();
  await env.DB.prepare("UPDATE agents SET kind='user', owner_chat=?, run_cap=?, runs_today=0, status='active', public=0, next_run=? WHERE id=?")
    .bind(chat, Math.min(300, Math.ceil(1440 / a.every_min) + 2), now + a.every_min * 60e3, a.id).run();
  await logLine(env, a.id, "moved to telegram. reports to its owner from now on.");
  return say(`${a.id} moved in with you.

${a.job}
checks ${every(a.every_min)} and reports here from now on.

read its log: /log ${a.id}
stop it: /kill ${a.id}`);
}

const typing = (env, chat) => tg(env, "sendChatAction", { chat_id: chat, action: "typing" }).catch(() => {});

async function talk(env, chat, text, say) {
  const sid = `tg:${chat}`;
  const s = await session(env, sid);
  const day = new Date().toISOString().slice(0, 10);
  const n = s.day === day ? s.n : 0;
  if (n >= 60) return say("that's a lot of talking for one day. your daemons keep working; i'm back at 00:00 utc.");
  await typing(env, chat);
  const daemons = await daemonsOf(env, "owner_chat=?", chat);
  let r;
  try {
    r = await converse(env, { turns: s.turns, text, daemons });
  } catch (e) {
    return say("my head is offline for a second. try again in a minute.");
  }
  const turns = [...s.turns, { role: "user", text: text.slice(0, 600) }, { role: "daemon", text: r.say.slice(0, 900) }];
  let offer = null;
  if (r.offer) {
    const p = await planJob(env, r.offer);
    if (p.plan) offer = { key: crypto.randomUUID().slice(0, 8), plan: p.plan, ask: r.offer };
  }
  await saveTurns(env, sid, turns, { day, n: n + 1, offer: offer ? JSON.stringify(offer) : null });
  if (!offer) return say(r.say);
  const cadence = offer.plan.deep ? "one-time, about 10 minutes, then report.md" : every(offer.plan.every_min);
  return tgSend(env, chat, `${r.say}\n\n› ${describe(offer.plan)}\n› ${cadence}`, {
    reply_markup: { inline_keyboard: [[{ text: "start it", callback_data: `go:${offer.key}` }, { text: "not now", callback_data: `nah:${offer.key}` }]] },
  });
}

async function onOffer(env, cq, ctx, runAgent) {
  const [kind, key] = String(cq.data).split(":");
  const chat = String(cq.message?.chat?.id || "");
  const answer = (text) => tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text }).catch(() => {});
  const say = (t) => tgSend(env, chat, t);
  const s = await session(env, `tg:${chat}`);
  if (!s.offer || s.offer.key !== key) return answer("that offer expired");
  await saveTurns(env, s.sid, s.turns, { offer: null });
  await tg(env, "editMessageReplyMarkup", { chat_id: chat, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
  if (kind === "nah") return answer("ok, dropped");
  await answer("starting");
  return summonPlan(env, chat, s.offer.plan, s.offer.ask, say, ctx, runAgent);
}

export async function handleUpdate(env, upd, ctx, runAgent) {
  if (upd.callback_query) {
    const d = String(upd.callback_query.data || "");
    if (d.startsWith("go:") || d.startsWith("nah:")) return onOffer(env, upd.callback_query, ctx, runAgent);
    return onCallback(env, upd.callback_query);
  }
  const m = upd.message;
  if (!m?.text || !m.chat) return;
  const chat = String(m.chat.id);
  const text = m.text.trim();
  const [cmdRaw, ...rest] = text.split(/\s+/);
  const cmd = cmdRaw.startsWith("/") ? cmdRaw.slice(1).split("@")[0].toLowerCase() : "";
  const arg = rest.join(" ").trim();
  const say = (t) => tgSend(env, chat, t);

  if (cmd === "start" && /^w[0-9a-f]{20}$/.test(arg)) return claimWeb(env, chat, arg, say, ctx, runAgent);
  if (cmd === "start" || cmd === "help") return say(HELP);

  if (cmd === "list") {
    const { results } = await env.DB.prepare("SELECT * FROM agents WHERE owner_chat=? AND status!='killed' ORDER BY created DESC").bind(chat).all();
    if (!results.length) return say("no daemons yet. tell me what you need, or /summon <job>.");
    return say(results.map((a) => `${a.id} · ${a.status === "done" ? "finished" : every(a.every_min)} · ${a.public ? "public" : "private"}\n  ${a.job}\n  › ${a.step}`).join("\n\n"));
  }

  if (cmd === "log") {
    const a = await findAgent(env, chat, arg);
    if (!a) return say("which one? /log <name>. see /list");
    const { results } = await env.DB.prepare("SELECT ts,line FROM logs WHERE agent_id=? ORDER BY id DESC LIMIT 20").bind(a.id).all();
    const out = results.reverse().map((l) => `${new Date(l.ts).toISOString().slice(11, 16)} ${l.line}`).join("\n");
    return say(`${a.id} (utc)\n${out || "nothing logged yet."}`);
  }

  if (cmd === "kill") {
    const a = await findAgent(env, chat, arg);
    if (!a) return say("which one? /kill <name>. see /list");
    await env.DB.prepare("UPDATE agents SET status='killed', step='killed by owner' WHERE id=?").bind(a.id).run();
    await env.DB.prepare("UPDATE actions SET status='denied', decided=? WHERE agent_id=? AND status='pending'").bind(Date.now(), a.id).run();
    await logLine(env, a.id, "killed by owner. no more runs. pending payments cancelled.");
    return say(`${a.id} stopped. no more runs, pending payments cancelled.`);
  }

  if (cmd === "public") {
    const a = await findAgent(env, chat, arg);
    if (!a) return say("which one? /public <name>. see /list");
    const v = a.public ? 0 : 1;
    await env.DB.prepare("UPDATE agents SET public=? WHERE id=?").bind(v, a.id).run();
    return say(v ? `${a.id} now works in the public night office (job and log visible).` : `${a.id} is private again.`);
  }

  if (cmd === "wallet") return walletCmd(env, chat, rest, say);

  if (cmd === "credits") {
    const b = await balance(env, chat);
    const perHour = +env.USD_PER_HOUR || 1;
    return say(`night-shift minutes (computer time):
free today: ${Math.floor(b.freeLeft / 60)}m · bought: ${Math.floor(b.paid / 60)}m
${env.TOKEN_ADDRESS ? `burn pass: send $DAEMON to any of your daemon wallets. it gets burned onchain and you get 1 hour per $${perHour} burned, at the lower of the live and 1-hour average price.` : "burn pass switches on after $DAEMON launches."} free minutes reset at 00:00 utc.`);
  }

  if (cmd === "summon") {
    if (arg.length < 6) return say("give me the job in one sentence. e.g. /summon watch ETH and ping me on a 3% move");
    await typing(env, chat);
    const { plan, error } = await planJob(env, arg);
    if (error) return say(error);
    return summonPlan(env, chat, plan, arg, say, ctx, runAgent);
  }

  if (cmd) return say("not a command i know. /help for the list, or just tell me what you need.");
  return talk(env, chat, text.slice(0, 1500), say);
}
