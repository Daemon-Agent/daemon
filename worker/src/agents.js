import { arxiv, hn, price, readUrl, rhchain, screenshot } from "./tools.js";
import { llmJson } from "./llm.js";
import { requestPayment, tgFile, tgSend } from "./tg.js";
import { devSold, EXPLORER, headBlock, MS_PER_BLOCK, nameLaunches, ponsLaunches, ponsToken, short, walletActivity } from "./onchain.js";
import { runComputer, sandboxEnabled } from "./computer.js";
import { balance, credit, spend } from "./credits.js";
import { burnHeld, walletsEnabled } from "./wallet.js";
import { econTick, secondsFor, tokenUsd } from "./econ.js";

export const HOUSE = [
  {
    id: "hn-scout",
    job: "Watch Hacker News for new AI agent stories and flag the ones worth reading.",
    every_min: 20,
    plan: { tool: "hn", args: { query: "AI agents" }, shot: { url: "https://news.ycombinator.com/newest", every_min: 60 } },
  },
  {
    id: "night-reader",
    job: "Read every new multi-agent paper on arXiv and keep a running brief.",
    every_min: 60,
    plan: { tool: "arxiv", args: { category: "cs.MA" }, size: "big", shot: { url: "https://arxiv.org/list/cs.MA/recent", every_min: 180 } },
  },
  {
    id: "price-hawk",
    job: "Watch the ETH price around the clock and write down every move over 1%.",
    every_min: 5,
    plan: { tool: "price", args: { symbol: "ETH", threshold_pct: 1 } },
  },
  {
    id: "chain-clerk",
    job: "Keep the night log for Robinhood Chain: blocks, gas, daily transactions.",
    every_min: 15,
    plan: { tool: "rhchain", args: {}, shot: { url: "https://robinhoodchain.blockscout.com/", every_min: 120 } },
  },
  {
    id: "digest-desk",
    job: "Every hour, pull new AI agent stories from Hacker News and Lobsters on its own computer, dedupe them into a running markdown digest, and keep the file.",
    every_min: 60,
    needs: "sandbox",
    plan: { tool: "computer", args: { goal: "maintain digest.md: AI agent stories from https://hn.algolia.com/api/v1/search_by_date?query=ai%20agent&tags=story and https://lobste.rs/hottest.json (keep items whose title mentions agent or llm), deduped by url, newest first, max 60 entries as '- [title](url) · source · date'. print how many entries were new this run." } },
  },
];

export async function ensureHouse(env) {
  const now = Date.now();
  await env.DB.batch(
    HOUSE.filter((h) => h.needs !== "sandbox" || sandboxEnabled(env)).map((h) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO agents (id,name,job,kind,plan,every_min,created,run_cap,public) VALUES (?,?,?,'house',?,?,?,?,1)"
      ).bind(h.id, h.id, h.job, JSON.stringify(h.plan), h.every_min, now, Math.ceil(1440 / h.every_min) + 4)
    )
  );
}

const fmtN = (x) => Number(x).toLocaleString("en-US");
const fmtUsd = (x) => `$${Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: x < 1 ? 6 : 2 })}`;
const pct = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
const HOUR = 3600e3;

const GATHER = {
  async price(env, a, mem, args) {
    const sym = String(args.symbol || "ETH").toUpperCase();
    const th = Math.max(0.2, +args.threshold_pct || 1);
    const p = await price(sym);
    const prev = mem.last;
    if (mem.anchor === undefined) mem.anchor = p.usd;
    const anchor = mem.anchor;
    const dLast = prev ? ((p.usd - prev) / prev) * 100 : 0;
    const dAnchor = ((p.usd - anchor) / anchor) * 100;
    const src = Object.entries(p.sources).map(([k, v]) => `${k} ${fmtUsd(v)}`).join(" · ");
    const lines = [`${sym.toLowerCase()} ${fmtUsd(p.usd)}${prev ? ` (${pct(dLast)} since last look)` : ""} · ${src}`];
    const split = p.spreadPct !== null && p.spreadPct > 0.5;
    if (split) lines.push(`sources disagree by ${p.spreadPct.toFixed(2)}%. not trusting either until they line up.`);
    if (!prev) lines.push(`reference set at ${fmtUsd(p.usd)}. checking every ${a.every_min}m, flagging a ${th}% move either way.`);
    mem.last = p.usd;
    const hr = mem.hr && Date.now() - mem.hr.at < HOUR ? mem.hr : null;
    if (!hr) {
      if (mem.hr) {
        const net = ((p.usd - mem.hr.open) / mem.hr.open) * 100;
        lines.push(`last hour: ${sym.toLowerCase()} ranged ${fmtUsd(mem.hr.lo)} to ${fmtUsd(mem.hr.hi)}, net ${pct(net)}.`);
      }
      mem.hr = { at: Date.now(), open: p.usd, lo: p.usd, hi: p.usd };
    } else {
      hr.lo = Math.min(hr.lo, p.usd);
      hr.hi = Math.max(hr.hi, p.usd);
    }
    const crossed = !split && Math.abs(dAnchor) >= th;
    const out = { lines, step: `watching ${sym.toLowerCase()} for a ${th}% move`, notifyAllowed: crossed };
    if (crossed) {
      lines.push(`${pct(dAnchor)} from the ${fmtUsd(anchor)} reference. that's past ${th}%.`);
      out.llm = "big";
      out.data = {
        symbol: sym,
        price_usd: +p.usd.toFixed(6),
        change_since_last_look_pct: +dLast.toFixed(3),
        reference_price_usd: +anchor.toFixed(6),
        change_since_reference_pct: +dAnchor.toFixed(3),
        threshold_pct: th,
        crossed_threshold: crossed,
        sources: p.sources,
      };
      mem.llmAt = Date.now();
      if (crossed) mem.anchor = p.usd;
    }
    return out;
  },

  async hn(env, a, mem, args) {
    const q = String(args.query || "AI agents").slice(0, 80);
    const hits = await hn(q, 24);
    const seen = new Set(mem.seen || []);
    const fresh = hits.filter((h) => !seen.has(h.id));
    mem.seen = [...new Set([...hits.map((h) => h.id), ...(mem.seen || [])])].slice(0, 300);
    const step = `watching hacker news for "${q}"`;
    if (!fresh.length) return { lines: [`checked hacker news for "${q}". nothing new since last look.`], step };
    return {
      lines: [`${fresh.length} new on hacker news for "${q}"`],
      step,
      llm: a.plan.size || "small",
      notifyAllowed: true,
      data: { query: q, new_stories: fresh.slice(0, 8).map(({ title, url, hn: link, points, comments }) => ({ title, url, discussion: link, points, comments })) },
    };
  },

  async arxiv(env, a, mem, args) {
    const cat = String(args.category || "cs.MA");
    const papers = await arxiv(cat, 15);
    const seen = new Set(mem.seen || []);
    const fresh = papers.filter((p) => !seen.has(p.id));
    mem.seen = [...new Set([...papers.map((p) => p.id), ...(mem.seen || [])])].slice(0, 300);
    const step = `reading arxiv ${cat}`;
    if (!fresh.length) return { lines: [`arxiv ${cat}: no new papers since last look.`], step };
    return {
      lines: [`${fresh.length} new papers in arxiv ${cat}`],
      step,
      llm: a.plan.size || "big",
      notifyAllowed: true,
      data: { category: cat, new_papers: fresh.slice(0, 6).map(({ title, url, summary }) => ({ title, url, summary })) },
    };
  },

  async rhchain(env, a, mem) {
    const c = await rhchain();
    const prev = mem.snap;
    const lines = [`block ${fmtN(c.block)} · gas ${c.gasGwei.toFixed(3)} gwei${prev ? ` · +${fmtN(c.block - prev.block)} blocks since last look` : ""}`];
    mem.snap = { block: c.block, gasGwei: c.gasGwei, txToday: c.txToday, at: Date.now() };
    const out = { lines, step: "keeping the robinhood chain log" };
    if (Date.now() - (mem.llmAt || 0) > HOUR) {
      if (c.txToday) lines.push(`${fmtN(c.txToday)} transactions so far today`);
      out.llm = a.plan.size || "big";
      out.data = { now: c, previous_snapshot: mem.hourSnap || null };
      mem.hourSnap = mem.snap;
      mem.llmAt = Date.now();
    }
    return out;
  },

  async watch_url(env, a, mem, args) {
    const p = await readUrl(args.url);
    const host = new URL(p.url).host;
    const step = `watching ${host}`;
    if (!mem.hash) {
      mem.hash = p.hash;
      mem.excerpt = p.text.slice(0, 1500);
      return { lines: [`read ${host} ("${p.title}"). saved it as the baseline.`], step };
    }
    if (mem.hash === p.hash) return { lines: [`${host}: no change since last look.`], step };
    const before = mem.excerpt;
    mem.hash = p.hash;
    mem.excerpt = p.text.slice(0, 1500);
    return {
      lines: [`${host} changed since last look.`],
      step,
      llm: a.plan.size || "small",
      notifyAllowed: true,
      data: { url: p.url, title: p.title, before_excerpt: before, now_excerpt: p.text.slice(0, 2500) },
    };
  },

  async wallet(env, a, mem, args) {
    const addr = args.address;
    const head = await headBlock();
    const first = !mem.block;
    const w = await walletActivity(env, addr, { from: first ? head - blocksFor(a.every_min) : mem.block + 1, to: head });
    mem.block = head;
    const step = `watching ${short(addr)} on robinhood chain`;
    const items = [...w.trades.map(fmtTrade), ...w.transfers.map(fmtTransfer)];
    if (!items.length) {
      return { lines: [first ? `watching ${short(addr)}: ${w.ethBalance} ETH, ${fmtN(w.txCount)} txs sent so far. quiet in the last ${w.window.minutes}m.` : `${short(addr)}: no trades or transfers in the last ${w.window.minutes}m.`], step };
    }
    const lines = [`${short(addr)}: ${items.length} move${items.length > 1 ? "s" : ""} in the last ${w.window.minutes}m`, ...items.slice(0, 3)];
    return { lines, step, notifyAllowed: true, final: { notify: true, report: [`${short(addr)} on robinhood chain:`, ...items.slice(0, 8), w.explorer].join("\n") } };
  },

  async token(env, a, mem, args) {
    const t = await ponsToken(env, args.address);
    if (!t) throw new Error("that address is not a token on robinhood chain");
    if (!t.pons) throw new Error(`$${t.symbol} did not launch on pons. holder tracking covers pons tokens only`);
    const sym = `$${t.symbol}`;
    const prev = mem.snap;
    mem.snap = { holders: t.holders, devSoldEth: t.devSoldEth, graduated: t.graduated, mcap: t.mcapUsd, buys: t.trades.buys, sells: t.trades.sells };
    const lines = [`${sym}: ${fmtN(t.holders)} holders · top 10 hold ${t.top10Pct}% · ${fmtN(t.trades.buys)} buys / ${fmtN(t.trades.sells)} sells${t.mcapUsd ? ` · mcap ~$${fmtN(t.mcapUsd)}` : ""}`];
    const step = `watching ${sym} holders and dev wallet`;
    if (!prev) {
      lines.push(t.devSold ? `dev ${short(t.creator)} already sold ${t.devSoldEth} ETH worth.` : `dev ${short(t.creator)} bought ${t.devBuyEth} ETH at launch and hasn't sold.`);
      return { lines, step };
    }
    const ev = [];
    if (t.devSoldEth > prev.devSoldEth + 1e-6) ev.push(`dev ${short(t.creator)} sold: ${(t.devSoldEth - prev.devSoldEth).toFixed(4)} ETH out. now holds ${t.devHoldsPct}%.`);
    if (t.graduated && !prev.graduated) ev.push(`${sym} graduated off the pons curve.`);
    const hp = Math.max(5, +args.holders_pct || 15);
    if (prev.holders >= 5 && Math.abs(t.holders - prev.holders) / prev.holders * 100 >= hp) ev.push(`holders ${prev.holders} → ${t.holders} (${pct(((t.holders - prev.holders) / prev.holders) * 100)}).`);
    const mp = Math.max(5, +args.move_pct || 30);
    if (prev.mcap && t.mcapUsd && Math.abs(t.mcapUsd - prev.mcap) / prev.mcap * 100 >= mp) ev.push(`mcap ~$${fmtN(prev.mcap)} → ~$${fmtN(t.mcapUsd)} (${pct(((t.mcapUsd - prev.mcap) / prev.mcap) * 100)}).`);
    if (!ev.length) return { lines, step };
    lines.push(...ev);
    return { lines, step, notifyAllowed: true, final: { notify: true, report: [`${sym}:`, ...ev, t.explorer].join("\n") } };
  },

  async pons_launches(env, a, mem, args) {
    const minDev = Math.max(0, +args.min_dev_eth || 0);
    const hold = Math.min(120, Math.max(0, args.hold_min === undefined ? 10 : +args.hold_min));
    const head = await headBlock();
    const { launches } = await ponsLaunches(env, { from: mem.block ? mem.block + 1 : head - blocksFor(a.every_min), to: head });
    mem.block = head;
    const fresh = launches.filter((l) => l.devBuyEth >= minDev);
    const pending = [...(mem.pending || []), ...fresh.map(({ token, curve, creator, block, devBuyEth }) => ({ token, curve, creator, block, devBuyEth }))].slice(-40);
    const holdBlocks = blocksFor(hold);
    const ripe = pending.filter((p) => head - p.block >= holdBlocks);
    mem.pending = pending.filter((p) => head - p.block < holdBlocks);
    const sold = hold && ripe.length ? await devSold(env, ripe) : new Map();
    const keep = ripe.filter((p) => !sold.has(p.curve.toLowerCase()));
    await nameLaunches(env, keep, 8);
    const filter = minDev ? ` with a dev buy of ${minDev}+ ETH` : "";
    const lines = [`${launches.length} new pons launch${launches.length === 1 ? "" : "es"} since last look, ${fresh.length}${filter}.`];
    if (hold && ripe.length) lines.push(`${ripe.length - keep.length} of ${ripe.length} devs sold within ${hold}m. ${keep.length} still holding.`);
    const step = `watching pons launches${filter}`;
    if (!keep.length) return { lines, step };
    const rows = keep.slice(0, 8).map((k) => `$${k.symbol} · dev bought ${k.devBuyEth} ETH${hold ? `, still holding after ${hold}m` : ""} · ${EXPLORER}/token/${k.token}`);
    lines.push(...rows.slice(0, 2).map((r) => r.split(" · http")[0]));
    return { lines, step, notifyAllowed: true, final: { notify: true, report: [`pons launches${filter}${hold ? `, dev still holding after ${hold}m` : ""}:`, ...rows].join("\n") } };
  },
};

const blocksFor = (min) => Math.round((min * 60e3) / MS_PER_BLOCK);
const fmtAmt = (x) => (x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${+(+x).toPrecision(4)}`);
const fmtTrade = (t) => `${t.side === "buy" ? "bought" : "sold"} ${fmtAmt(t.tokens)} $${t.symbol} for ${t.eth} ETH · ${t.when}`;
const fmtTransfer = (t) => `${t.dir === "in" ? "received" : "sent"} ${fmtAmt(t.amount)} ${t.symbol} ${t.dir === "in" ? "from" : "to"} ${short(t.counterparty)} · ${t.when}`;

export const TOOLS = Object.keys(GATHER);

const payRule = (p) => `when ${p.when}, ask the owner to approve paying ${p.amount_eth} ETH to ${p.to}`;

async function computerStep(env, a, mem) {
  if (!sandboxEnabled(env)) return { lines: ["its computer isn't connected yet. skipping this run."], step: "waiting for its computer" };
  const deep = a.plan.deep ? { pass: (mem.pass || 0) + 1, passes: a.plan.deep.passes } : null;
  let budget = deep ? 200 : 180;
  if (a.kind === "user") {
    const b = await balance(env, a.owner_chat);
    budget = Math.min(budget, b.freeLeft + b.paid);
    if (budget < 20) return { lines: ["out of night-shift minutes for today. back at 00:00 utc, or burn $DAEMON for more."], step: "out of minutes" };
  }
  const r = await runComputer(env, a, mem, { budgetSec: budget, payRule: a.plan.pay ? payRule(a.plan.pay) : "", model: a.kind === "house" ? "pro" : "agent", deep });
  if (a.kind === "user") await spend(env, a.owner_chat, r.seconds);
  if (deep) mem.pass = deep.pass;
  const finished = deep && (r.final?.finished === true || deep.pass >= deep.passes);
  const step = deep ? (finished ? "finished. report delivered" : `pass ${deep.pass + 1} of ${deep.passes} next`) : `next pass in ${a.every_min}m`;
  return { lines: [...r.lines, `used ${r.seconds}s of computer time.`], step, final: r.final || {}, payment: r.payment, files: r.files, finished, notifyAllowed: true };
}

async function keepFiles(env, a, files, caption) {
  const out = [];
  for (const f of files || []) {
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
    await env.DB.prepare("INSERT INTO files (id,agent_id,name,mime,size,ts,body) VALUES (?,?,?,?,?,?,?)")
      .bind(id, a.id, f.name, f.mime, f.bytes.length, Date.now(), Buffer.from(f.bytes).toString("base64")).run();
    out.push(f.name);
    if (a.kind === "user" && a.owner_chat) await tgFile(env, a.owner_chat, f, caption).catch((e) => console.log("tg file", e.message));
  }
  return out;
}

function system(a) {
  return `You are "${a.name}", an always-on agent running on DAEMON.
Your job: ${a.job}
${a.plan.notify_when ? `Your owner wants a ping when: ${a.plan.notify_when}\n` : ""}${a.plan.pay ? `Payment rule: ${payRule(a.plan.pay)}. Add "pay":true to your JSON only if that condition is met right now by new_data.\n` : ""}You wake up on a schedule, look at fresh data, and write your work log.
Rules: use only facts present in new_data and notes. Never invent numbers, names or links. Every log line must name something concrete from new_data (a title, a number, a change). No filler like "data loaded" or "multiple sources". No links in log lines; links go only in the report. Short lowercase terminal-log voice, dry, a little deadpan, no emojis, no hype, never tell anyone to buy or sell.
Report lines look like: "title or fact: why it matters, in under 12 words (link)".
Return only JSON, no prose:
{"log":["1 to 3 lines, each under 110 chars, about what you noticed"],"step":"what you do next, under 60 chars","notes":"your working memory for the next run, under 500 chars, keep what matters","notify":false,"report":"only if notify is true: 1 to 5 short lines for your owner, include links from new_data; else empty string"}`;
}

const clean = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export async function runAgent(env, a, { ctx } = {}) {
  a = { ...a, plan: typeof a.plan === "string" ? JSON.parse(a.plan || "{}") : a.plan };
  const mem = JSON.parse(a.memory || "{}");
  const now = Date.now();
  const lines = [];
  let step = a.step;
  let provider = null;
  let report = "";
  let finished = false;

  const pay = a.plan.pay;
  const apply = async (o, g) => {
    for (const l of (Array.isArray(o.log) ? o.log : []).slice(0, 3)) if (clean(l, 140)) lines.push(clean(l, 140));
    if (clean(o.step, 70)) step = clean(o.step, 70);
    if (o.notes) mem.notes = clean(o.notes, 600);
    if (o.notify && g.notifyAllowed) report = String(o.report || "").trim().slice(0, 1200);
    if (report && a.kind === "user" && a.owner_chat) {
      const sent = await tgSend(env, a.owner_chat, `${a.name}:\n${report}`).catch(() => false);
      if (sent) lines.push("sent a report to telegram.");
    }
  };

  try {
    const g = a.plan.tool === "computer" ? await computerStep(env, a, mem) : await GATHER[a.plan.tool](env, a, mem, a.plan.args || {});
    lines.push(...(g.lines || []));
    step = g.step || step;
    let payment = g.payment || null;
    if (g.final) await apply(g.final, g);
    if (g.files?.length) {
      const names = await keepFiles(env, a, g.files, `${a.name} · ${g.finished ? "final report" : "new file"}`);
      lines.push(`handed over ${names.join(", ")}${a.kind === "user" ? " in telegram" : ""}.`);
    }
    if (g.finished) finished = true;
    if (g.llm) {
      try {
        const r = await llmJson(env, g.llm, {
          system: system(a),
          user: JSON.stringify({ run: a.runs_total + 1, time_utc: new Date(now).toISOString(), notes: mem.notes || "(empty: first run)", new_data: g.data }),
        });
        provider = r.provider;
        await apply(r.out || {}, g);
        if (pay && r.out?.pay === true) payment = { amount_eth: pay.amount_eth, reason: pay.when };
      } catch (e) {
        lines.push(`model step failed (${clean(e.message, 60)}). kept the raw numbers, will think next run.`);
      }
    }
    if (payment && pay && a.kind === "user") {
      const amount = Math.min(+payment.amount_eth || 0, +pay.amount_eth);
      lines.push(await requestPayment(env, a, { to: pay.to, amount_eth: amount, reason: payment.reason || pay.when }));
    }
  } catch (e) {
    lines.push(`${a.plan.tool === "computer" ? "run failed" : "couldn't reach a source"}: ${clean(e.message, 80)}. retrying next run.`);
    step = "retrying after an error";
  }

  const shot = a.plan.shot;
  if (shot && env.BROWSER && now - (a.thumb_at || 0) > shot.every_min * 60e3) {
    const job = screenshot(env, shot.url)
      .then((b64) =>
        env.DB.prepare("UPDATE agents SET thumb=?, thumb_at=? WHERE id=?").bind(b64, Date.now(), a.id).run()
          .then(() => env.DB.prepare("INSERT INTO logs (agent_id,ts,line) VALUES (?,?,?)").bind(a.id, Date.now(), `opened ${new URL(shot.url).host} in its browser and took a look.`).run())
      )
      .catch((e) => console.log("shot failed", a.id, e.message));
    ctx ? ctx.waitUntil(job) : await job;
  }

  const day = new Date(now).toISOString().slice(0, 10);
  const runsToday = (a.day === day ? a.runs_today : 0) + 1;
  const runsTotal = a.runs_total + 1;
  let next = now + a.every_min * 60e3;
  let status = a.status;
  if (finished) {
    status = "done";
    lines.push("job finished. clocking out.");
  } else if (a.plan.deep && a.plan.tool === "computer" && step === "out of minutes") {
    next = Date.parse(`${day}T00:00:00Z`) + 86400e3;
  } else if (a.kind === "trial" && runsTotal >= a.run_cap) {
    status = "done";
    lines.push("trial shift over. clocking out.");
    step = "clocked out";
  } else if (a.kind !== "trial" && runsToday >= a.run_cap) {
    next = Date.parse(`${day}T00:00:00Z`) + 86400e3;
    lines.push("hit today's run cap. sleeping till 00:00 utc.");
    step = "run cap reached, back at 00:00 utc";
  }

  const stmts = lines.map((l) => env.DB.prepare("INSERT INTO logs (agent_id,ts,line) VALUES (?,?,?)").bind(a.id, now, l));
  stmts.push(
    env.DB.prepare(
      "UPDATE agents SET memory=?, step=?, last_run=?, next_run=?, runs_total=?, runs_today=?, day=?, status=CASE WHEN status='killed' THEN 'killed' ELSE ? END WHERE id=?"
    ).bind(JSON.stringify(mem), step, now, next, runsTotal, runsToday, day, status, a.id)
  );
  await env.DB.batch(stmts);
  return { lines, provider, step, report };
}

async function burnSweep(env) {
  if (!env.TOKEN_ADDRESS || !walletsEnabled(env)) return;
  const { results } = await env.DB.prepare(
    "SELECT w.* FROM wallets w JOIN agents a ON a.id=w.agent_id WHERE a.status='active' LIMIT 25"
  ).all();
  if (!results.length) return;
  const px = await tokenUsd(env).catch(() => null);
  if (!px) return;
  for (const w of results) {
    const r = await burnHeld(env, w.address).catch((e) => (console.log("burn", w.address, e.message), null));
    if (!r) continue;
    const tokens = Number(r.amount / 10n ** 12n) / 1e6;
    const usd = tokens * px;
    const sec = secondsFor(env, usd);
    await env.DB.prepare("INSERT OR IGNORE INTO burns (tx,chat,agent_id,wallet,amount,sec,ts) VALUES (?,?,?,?,?,?,?)")
      .bind(r.tx, w.chat, w.agent_id, w.address, r.amount.toString(), sec, Date.now()).run();
    await env.DB.prepare("INSERT INTO ledger (ts,kind,usd,note) VALUES (?,?,?,?)").bind(Date.now(), "burn", usd, r.tx).run();
    await credit(env, w.chat, sec, r.amount.toString());
    const line = `burned ${tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} $DAEMON (~$${usd.toFixed(2)}). +${Math.round(sec / 60)} night-shift minutes.`;
    await env.DB.prepare("INSERT INTO logs (agent_id,ts,line) VALUES (?,?,?)").bind(w.agent_id, Date.now(), line).run();
    await tgSend(env, w.chat, `${line}\nhttps://robinhoodchain.blockscout.com/tx/${r.tx}`).catch(() => {});
  }
}

export async function tick(env, ctx) {
  await ensureHouse(env);
  const now = Date.now();
  const { results } = await env.DB.prepare(
    "SELECT * FROM agents WHERE status='active' AND next_run<=? ORDER BY next_run LIMIT 12"
  ).bind(now + 90e3).all();
  let computers = 0;
  for (const a of results) {
    if (Date.now() - now > 9 * 60e3) break;
    if (a.plan.includes('"tool":"computer"') && (++computers > 3 || Date.now() - now > 6 * 60e3)) continue;
    await runAgent(env, a, { ctx }).catch((e) => console.log("run failed", a.id, e.message));
  }
  await econTick(env).catch((e) => console.log("econ", e.message));
  await burnSweep(env).catch((e) => console.log("burn sweep", e.message));
  await env.DB.prepare("DELETE FROM logs WHERE ts < ?").bind(now - 7 * 86400e3).run();
  await env.DB.prepare("DELETE FROM agents WHERE kind='trial' AND status!='active' AND last_run < ?").bind(now - 6 * HOUR).run();
  await env.DB.prepare("DELETE FROM logs WHERE agent_id NOT IN (SELECT id FROM agents)").run();
  await env.DB.prepare("DELETE FROM files WHERE ts < ? OR agent_id NOT IN (SELECT id FROM agents)").bind(now - 30 * 86400e3).run();
  await env.DB.prepare("DELETE FROM hits WHERE reset < ?").bind(now).run();
}
