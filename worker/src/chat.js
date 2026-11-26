// The conversational brain shared by Telegram and the web chat: answer with live tools, and offer a daemon when the ask is ongoing work.
import { llmJson } from "./llm.js";
import { arxiv, hn, price, readUrl } from "./tools.js";
import { devSold, headBlock, inspect, MS_PER_BLOCK, nameLaunches, ponsLaunches } from "./onchain.js";

const SYSTEM = `You are DAEMON, a chat front for always-on AI agents ("daemons") that keep working after the person leaves. You can look things up live before you answer.
Reply with exactly ONE JSON object, nothing else. Either call a tool:
{"tool":"price","args":{"symbol":"ETH"}}  live crypto price from coinbase and kraken
{"tool":"hn","args":{"query":"ai agents","hours":24}}  recent hacker news stories
{"tool":"arxiv","args":{"category":"cs.AI"}}  newest arxiv papers in a category (cs.AI, cs.MA, cs.CL, cs.CR, cs.LG, q-fin.TR...)
{"tool":"read_url","args":{"url":"https://..."}}  read one public web page
{"tool":"chain","args":{"address":"0x..."}}  read a wallet or token on Robinhood Chain. pons tokens come with dev wallet, holders, top 10 share, buys/sells, mcap, graduation
{"tool":"pons_launches","args":{"minutes":30,"min_dev_eth":0}}  pons launches on Robinhood Chain in the last minutes (max 120), with dev buy size and whether the dev already sold
or answer:
{"say":"your answer","offer":null}
or answer and propose a daemon:
{"say":"...","offer":"the job in one sentence, as the person would say it"}
When to offer: the person wants something watched over time, alerts, a recurring digest, or a one-time research report that needs browsing several sources (a daemon on its own computer does that in about 10 minutes and sends report.md). In "say", explain in one or two lines what that daemon would do and that they can tap start. Don't offer for small talk or a question you just answered.
What daemons can do: watch prices, hacker news, arxiv, any public page, a Robinhood Chain wallet or pons token, new pons launches; run python and a real browser on their own linux computer; send files (report.md, csv, chart.png) in telegram; pay from a capped wallet only after the owner taps approve.
What they can't: log in anywhere, read email, post or message anyone, trade or buy and sell for anyone, read wallets or tokens on other chains (solana, base, ethereum). Say so plainly if asked.
Rules: every number, name and link must come from tool_results or the conversation. Never invent. If a tool failed, say what failed. No financial advice: on "should i buy" give the data and no verdict. Keep it under 700 characters, plain text, short lines, lowercase is fine, no markdown headings or bold, no emojis. Talk like a calm night-shift operator: dry, exact, helpful. Reply in the language of the latest message only (english message → english, even if earlier turns were russian). At most 2 tool calls per message, then answer.`;

const clip = (s, n) => String(s ?? "").trim().slice(0, n);

async function launchesTool(env, { minutes, min_dev_eth }) {
  const m = Math.min(120, Math.max(5, +minutes || 30));
  const head = await headBlock();
  const { launches } = await ponsLaunches(env, { from: head - Math.round((m * 60e3) / MS_PER_BLOCK), to: head });
  const minDev = Math.max(0, +min_dev_eth || 0);
  const pick = launches.filter((l) => l.devBuyEth >= minDev).slice(0, 12);
  await nameLaunches(env, pick, 12);
  const sold = await devSold(env, pick).catch(() => new Map());
  return {
    window_minutes: m, total_launches: launches.length, matching: launches.filter((l) => l.devBuyEth >= minDev).length,
    launches: pick.map((l) => ({ symbol: l.symbol, name: l.name, token: l.token, when: l.when, dev_buy_eth: l.devBuyEth, dev_sold_eth: +(sold.get(l.curve.toLowerCase()) || 0).toFixed(4) })),
  };
}

function trimChain(r) {
  if (r.kind === "wallet") return { ...r, trades: r.trades.slice(0, 10).map(({ tx, block, ...t }) => t), transfers: r.transfers.slice(0, 10).map(({ tx, block, ...t }) => t) };
  return r;
}

const TOOLS = {
  price: async ({ symbol }) => {
    const p = await price(symbol || "ETH");
    return { symbol: p.symbol, usd: +p.usd.toPrecision(8), sources: p.sources, spread_pct: p.spreadPct === null ? null : +p.spreadPct.toFixed(3) };
  },
  hn: async ({ query, hours }) => (await hn(clip(query || "AI agents", 80), Math.min(168, Math.max(1, +hours || 24)))).slice(0, 8).map(({ id, ...h }) => h),
  arxiv: async ({ category }) => (await arxiv(category || "cs.AI", 8)).map(({ title, url, summary, published }) => ({ title, url, summary: summary.slice(0, 240), published })),
  read_url: async ({ url }) => {
    const p = await readUrl(String(url));
    return { url: p.url, title: p.title, text: p.text.slice(0, 3000) };
  },
  chain: async ({ address }, env) => trimChain(await inspect(env, address)),
  pons_launches: (args, env) => launchesTool(env, args),
};

export const BRAIN_TOOLS = Object.keys(TOOLS);

export async function converse(env, { turns = [], text, daemons = [] }) {
  const results = [];
  for (let i = 0; i < 3; i++) {
    const force = i === 2;
    const { out } = await llmJson(env, "agent", {
      system: SYSTEM,
      user: JSON.stringify({
        time_utc: new Date().toISOString(),
        conversation: turns.slice(-10),
        your_daemons: daemons,
        tool_results: results,
        message: text,
        ...(force ? { instruction: "no more tools. answer now with say." } : {}),
      }),
      maxTokens: 900,
    });
    const tool = String(out?.tool || "");
    if (tool && !force && TOOLS[tool]) {
      const args = out.args && typeof out.args === "object" ? out.args : {};
      try {
        const r = await TOOLS[tool](args, env);
        const s = JSON.stringify(r);
        results.push({ tool, args, result: s.length > 6000 ? `${s.slice(0, 6000)}… (trimmed)` : r });
      } catch (e) {
        results.push({ tool, args, error: clip(e.message, 160) });
      }
      continue;
    }
    const say = clip(out?.say, 1500);
    if (!say) continue;
    const offer = typeof out.offer === "string" && out.offer.trim().length > 8 ? clip(out.offer, 400) : null;
    return { say, offer, tools: results.map((r) => r.tool) };
  }
  return { say: "lost my train of thought there. ask me again?", offer: null, tools: results.map((r) => r.tool) };
}

// Sessions: one row per web visitor (random sid) or per Telegram chat ("tg:<id>").
export async function session(env, sid) {
  const now = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO chats (sid,created,updated) VALUES (?,?,?)").bind(sid, now, now).run();
  const s = await env.DB.prepare("SELECT * FROM chats WHERE sid=?").bind(sid).first();
  return { ...s, turns: JSON.parse(s.turns || "[]"), offer: s.offer ? JSON.parse(s.offer) : null };
}

export async function saveTurns(env, sid, turns, fields = {}) {
  const sets = ["turns=?", "updated=?"];
  const vals = [JSON.stringify(turns.slice(-16)), Date.now()];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k}=?`);
    vals.push(v && typeof v === "object" ? JSON.stringify(v) : v);
  }
  await env.DB.prepare(`UPDATE chats SET ${sets.join(",")} WHERE sid=?`).bind(...vals, sid).run();
}

export async function daemonsOf(env, where, bind) {
  const { results } = await env.DB.prepare(`SELECT id,job,step,status,every_min FROM agents WHERE ${where} AND status!='killed' ORDER BY created DESC LIMIT 3`).bind(bind).all();
  const out = [];
  for (const a of results) {
    const { results: l } = await env.DB.prepare("SELECT line FROM logs WHERE agent_id=? ORDER BY id DESC LIMIT 4").bind(a.id).all();
    out.push({ id: a.id, job: a.job, status: a.status, now: a.step, recent_log: l.map((x) => x.line).reverse() });
  }
  return out;
}

export const claimCode = () => "w" + [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("");
