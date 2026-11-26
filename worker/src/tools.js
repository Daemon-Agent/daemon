import puppeteer from "@cloudflare/puppeteer";

const UA = { "user-agent": "daemon-agent/0.1 (+https://usedaemon.xyz)" };

async function retry(fn, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      err = e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  throw err;
}

async function getJson(url, init = {}) {
  return retry(() => getJsonOnce(url, init));
}

async function getJsonOnce(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { ...UA, accept: "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`${new URL(url).host} HTTP ${r.status}`);
  return r.json();
}

export async function price(symbol = "ETH") {
  const s = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10) || "ETH";
  const sources = {};
  await Promise.allSettled([
    getJson(`https://api.coinbase.com/v2/prices/${s}-USD/spot`).then((j) => {
      const v = +j?.data?.amount;
      if (Number.isFinite(v) && v > 0) sources.coinbase = v;
    }),
    getJson(`https://api.kraken.com/0/public/Ticker?pair=${s === "BTC" ? "XBT" : s}USD`).then((j) => {
      const k = Object.values(j?.result || {})[0];
      const v = +k?.c?.[0];
      if (Number.isFinite(v) && v > 0) sources.kraken = v;
    }),
  ]);
  const vals = Object.values(sources);
  if (!vals.length) throw new Error(`no price source answered for ${s}`);
  const usd = vals.reduce((a, b) => a + b, 0) / vals.length;
  const spreadPct = vals.length > 1 ? ((Math.max(...vals) - Math.min(...vals)) / usd) * 100 : null;
  return { symbol: s, usd, sources, spreadPct };
}

export async function hn(query = "AI agents", hours = 24) {
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  const j = await getJson(
    `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&numericFilters=created_at_i>${since}&hitsPerPage=20`
  );
  return (j.hits || []).map((h) => ({
    id: h.objectID,
    title: h.title,
    url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    hn: `https://news.ycombinator.com/item?id=${h.objectID}`,
    points: h.points || 0,
    comments: h.num_comments || 0,
  }));
}

export async function arxiv(cat = "cs.MA", n = 15) {
  const c = String(cat).replace(/[^A-Za-z.\-]/g, "") || "cs.MA";
  const xml = await retry(async () => {
    const r = await fetch(
      `https://export.arxiv.org/api/query?search_query=cat:${c}&sortBy=submittedDate&sortOrder=descending&max_results=${n}`,
      { headers: UA, signal: AbortSignal.timeout(25000) }
    );
    if (!r.ok) throw new Error(`arxiv HTTP ${r.status}`);
    return r.text();
  });
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => {
    const g = (t) => ((e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || "").replace(/\s+/g, " ").trim();
    const id = g("id");
    return { id: id.split("/abs/")[1] || id, url: id, title: g("title"), summary: g("summary").slice(0, 420), published: g("published") };
  });
}

const RH_RPCS = ["https://robinhood.rpc.pinax.network", "https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"];
let rpcTurn = 0;
const rpc = (method) => retry(() => rpcOnce(method, RH_RPCS[rpcTurn++ % RH_RPCS.length]), 3);

async function rpcOnce(method, url) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  if (!j.result) throw new Error(`rpc ${method} failed`);
  return parseInt(j.result, 16);
}

export async function rhchain() {
  const [block, gasWei, stats] = await Promise.all([
    rpc("eth_blockNumber").catch(() => null),
    rpc("eth_gasPrice").catch(() => null),
    getJson("https://robinhoodchain.blockscout.com/api/v2/stats").catch(() => null),
  ]);
  const b = block ?? (stats?.total_blocks ? +stats.total_blocks : null);
  const gwei = gasWei !== null ? gasWei / 1e9 : stats?.gas_prices?.average?.wei ? +stats.gas_prices.average.wei / 1e9 : null;
  if (b === null || gwei === null) throw new Error("rpc and blockscout both unreachable");
  return {
    block: b,
    gasGwei: gwei,
    txToday: stats?.transactions_today ? +stats.transactions_today : null,
    addresses: stats?.total_addresses ? +stats.total_addresses : null,
    blockMs: stats?.average_block_time ?? null,
  };
}

export async function readUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) pages");
  const r = await fetch(u, { headers: { ...UA, accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${u.host} HTTP ${r.status}`);
  const html = (await r.text()).slice(0, 500000);
  const title = ((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || u.host).replace(/\s+/g, " ").trim().slice(0, 120);
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return { url: u.href, title, text: text.slice(0, 5000), hash: await sha(text) };
}

export async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function browseText(env, url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) pages");
  if (!env.BROWSER) return readUrl(u.href);
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.goto(u.href, { waitUntil: "networkidle2", timeout: 25000 });
    const title = await page.title();
    const text = await page.evaluate(() => document.body?.innerText || "");
    const links = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].slice(0, 40).map((a) => `${a.innerText.trim().slice(0, 60)} -> ${a.href}`).filter((s) => !s.startsWith(" ->"))
    );
    return { url: page.url(), title, text: text.replace(/\s+\n/g, "\n").slice(0, 5000), links };
  } finally {
    await browser.close();
  }
}

export async function screenshot(env, url) {
  if (!env.BROWSER) throw new Error("no browser binding");
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 540 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 25000 });
    const buf = await page.screenshot({ type: "jpeg", quality: 55 });
    return Buffer.from(buf).toString("base64");
  } finally {
    await browser.close();
  }
}
