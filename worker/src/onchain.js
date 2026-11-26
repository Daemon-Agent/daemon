// Robinhood Chain reads straight from the public RPC: Pons launches, Pons curve trades, holders and wallet activity.
import { price } from "./tools.js";

const PUBLIC_RPCS = ["https://robinhood.rpc.pinax.network", "https://rpc.mainnet.chain.robinhood.com"];
const CALL_ONLY_RPCS = ["https://robinhood.drpc.org"];
let custom = null;
export const useRpc = (env) => { custom = env?.RH_RPC_URL || null; };
export const rpcUrls = () => (custom ? [custom, ...PUBLIC_RPCS] : PUBLIC_RPCS);
export const EXPLORER = "https://robinhoodchain.blockscout.com";
const FACTORY = "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e";
const LAUNCH_AND_BUY = "0xe33e9e479df8802cb0866d5d05258bec4cf62948";
const T = {
  launch: "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607",
  launchBuy: "0xdcacba5e",
  buy: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  sell: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
  graduated: "0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67",
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
};
const ZERO = "0x0000000000000000000000000000000000000000";
const BURNS = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);
export const MS_PER_BLOCK = 182;
const OPEN_SPAN = 29000;
const ADDR_SPAN = 9_900_000;
const GRADUATE_ETH = 4.2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let turn = 0;

// Rotates across endpoints: a rate limit or outage on one moves to the next; a real JSON-RPC error (revert, bad range) is returned as is.
export async function rpc(method, params = []) {
  const urls = method === "eth_getLogs" ? rpcUrls() : [...rpcUrls(), ...CALL_ONLY_RPCS];
  const start = custom ? 0 : turn++ % urls.length;
  let last = "unreachable";
  for (let i = 0; i < urls.length * 2; i++) {
    const url = urls[(start + i) % urls.length];
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => ({ ok: false, status: 0 }));
    const j = r.ok ? await r.json().catch(() => null) : null;
    if (j && !j.error) return j.result;
    const msg = j?.error?.message || `HTTP ${r.status || "timeout"}`;
    const transient = !j || r.status === 429 || /too many|rate|limit exceeded|timeout|unavailable|not supported on free|beyond current head/i.test(msg);
    if (!transient) {
      const e = new Error(`rpc ${method}: ${msg.slice(0, 100)}`);
      e.rpc = true;
      throw e;
    }
    last = msg;
    if (i >= urls.length - 1) await sleep(600 * (i - urls.length + 2));
  }
  throw new Error(`rpc ${method}: every endpoint is rate limited right now (${last.slice(0, 60)})`);
}

const hex = (n) => "0x" + n.toString(16);
const topicOf = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const addrOf = (t) => "0x" + t.slice(26);
const words = (d) => (d.slice(2).match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
const eth = (w) => Number(w) / 1e18;
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ago = (blocks) => {
  const m = Math.round((blocks * MS_PER_BLOCK) / 60000);
  return m < 1 ? "just now" : m < 120 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export const headBlock = async () => parseInt(await rpc("eth_blockNumber"), 16) - 5;

async function logs(filter, from, to, span) {
  const out = [];
  for (let hi = to; hi >= from; hi -= span) {
    const lo = Math.max(from, hi - span + 1);
    out.unshift(...(await rpc("eth_getLogs", [{ ...filter, fromBlock: hex(lo), toBlock: hex(hi) }])));
  }
  return out;
}

function str(h) {
  try {
    if (!h || h === "0x") return null;
    const b = h.slice(2);
    if (b.length === 64) return Buffer.from(b, "hex").toString().replace(/\0+$/, "") || null;
    const len = parseInt(b.slice(64, 128), 16);
    return Buffer.from(b.slice(128, 128 + len * 2), "hex").toString() || null;
  } catch {
    return null;
  }
}

const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]).catch((e) => {
  if (e.rpc) return null;
  throw e;
});

async function erc20(addr) {
  const [name, symbol, supply, decimals] = await Promise.all([call(addr, "0x06fdde03"), call(addr, "0x95d89b41"), call(addr, "0x18160ddd"), call(addr, "0x313ce567")]);
  if (!symbol && !supply) return null;
  return { name: str(name), symbol: str(symbol), supply: supply && supply !== "0x" ? BigInt(supply) : 0n, decimals: decimals && decimals !== "0x" ? Number(BigInt(decimals)) : 18 };
}

export function classify(raw) {
  const s = String(raw || "").trim();
  if (/^So1{30,}2$/.test(s)) return { kind: "solana", note: "that's wrapped SOL, a Solana token. i read Robinhood Chain only." };
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { kind: "solana", note: "that looks like a Solana address. i read Robinhood Chain only." };
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: "evm", address: s.toLowerCase() };
  return { kind: "invalid", note: "that isn't an address i can read. send a 0x address on Robinhood Chain." };
}

async function cached(env, k, fn) {
  const hit = await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first().catch(() => null);
  if (hit) return JSON.parse(hit.v);
  const v = await fn();
  if (v) await env.DB.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, JSON.stringify(v)).run();
  return v;
}

// Where and how a Pons token launched. Searches the factory log backwards in 10M-block windows.
async function ponsLaunch(env, token) {
  return cached(env, `pons:${token}`, async () => {
    const head = await headBlock();
    for (let k = 0; k < 6; k++) {
      const hi = head - k * ADDR_SPAN, lo = Math.max(0, hi - ADDR_SPAN + 1);
      const [l] = await rpc("eth_getLogs", [{ address: FACTORY, topics: [T.launch, topicOf(token)], fromBlock: hex(lo), toBlock: hex(hi) }]);
      if (l) {
        const rc = await rpc("eth_getTransactionReceipt", [l.transactionHash]).catch(() => null);
        const lb = rc?.logs.find((x) => x.address.toLowerCase() === LAUNCH_AND_BUY && x.topics[0].startsWith(T.launchBuy));
        return { curve: addrOf(l.topics[2]), creator: addrOf(l.topics[3]), block: parseInt(l.blockNumber, 16), tx: l.transactionHash, devEth: lb ? eth(words(lb.data)[1]) : 0 };
      }
      if (lo === 0) break;
    }
    return null;
  });
}

async function spotPriceEth(curve) {
  const probe = 10n ** 14n;
  const data = "0x59a87bc1" + probe.toString(16).padStart(64, "0") + "0".repeat(64) + "000000000000000000000000000000000000000000000000000000000000dad0";
  const r = await rpc("eth_call", [{ from: "0x000000000000000000000000000000000000dAd0", to: curve, data, value: hex(probe) }, "latest", { "0x000000000000000000000000000000000000dAd0": { balance: "0xde0b6b3a7640000" } }]).catch(() => null);
  if (!r || r === "0x") return null;
  const out = BigInt(r);
  return out > 0n ? 1e-4 / eth(out) : null;
}

// Full read of a Pons token: launch, dev behaviour, curve trades, holders, price.
export async function ponsToken(env, token) {
  token = token.toLowerCase();
  const info = await erc20(token);
  if (!info) return null;
  const L = await ponsLaunch(env, token);
  if (!L) return { token, ...info, pons: false };
  const head = await headBlock();
  const [curveLogs, xfers, ethUsd] = await Promise.all([
    logs({ address: L.curve }, L.block, head, ADDR_SPAN),
    logs({ address: token, topics: [T.transfer] }, L.block, head, ADDR_SPAN),
    price("ETH").then((p) => p.usd).catch(() => null),
  ]);
  let buys = 0, sells = 0, ethIn = 0, ethOut = 0, devSoldTokens = 0n, devSoldEth = 0, lastTrade = L.block, graduated = false;
  const buyers = new Set(), sellers = new Set();
  for (const l of curveLogs) {
    const t0 = l.topics[0];
    if (t0 === T.graduated) graduated = true;
    if (t0 !== T.buy && t0 !== T.sell) continue;
    const w = words(l.data);
    lastTrade = parseInt(l.blockNumber, 16);
    if (t0 === T.buy) { buys++; ethIn += eth(w[0]); buyers.add(addrOf(l.topics[2])); }
    else {
      sells++; ethOut += eth(w[1]);
      const who = addrOf(l.topics[1]);
      sellers.add(who);
      if (who === L.creator) { devSoldTokens += w[0]; devSoldEth += eth(w[1]); }
    }
  }
  const bal = new Map();
  let burned = 0n;
  for (const l of xfers) {
    const from = addrOf(l.topics[1]), to = addrOf(l.topics[2]), v = BigInt(l.data);
    bal.set(from, (bal.get(from) || 0n) - v);
    bal.set(to, (bal.get(to) || 0n) + v);
    if (BURNS.has(to) && from !== ZERO) burned += v;
  }
  const curve = L.curve.toLowerCase();
  const holders = [...bal.entries()].filter(([a, v]) => v > 0n && a !== curve && !BURNS.has(a)).sort((a, b) => (b[1] > a[1] ? 1 : -1));
  const supply = Number(info.supply) || 1;
  const pctOf = (v) => +((Number(v) / supply) * 100).toFixed(2);
  const px = graduated ? null : await spotPriceEth(L.curve);
  const priceUsd = px && ethUsd ? px * ethUsd : null;
  return {
    token, name: info.name, symbol: info.symbol, pons: true, curve: L.curve, creator: L.creator,
    launched: ago(head - L.block), launchBlock: L.block, devBuyEth: +L.devEth.toFixed(4),
    devHoldsPct: pctOf(bal.get(L.creator) || 0n), devSold: devSoldTokens > 0n, devSoldEth: +devSoldEth.toFixed(4),
    trades: { buys, sells, buyers: buyers.size, sellers: sellers.size, ethIn: +ethIn.toFixed(4), ethOut: +ethOut.toFixed(4), last: ago(head - lastTrade) },
    holders: holders.length, top: holders.slice(0, 5).map(([a, v]) => ({ address: a, pct: pctOf(v), dev: a === L.creator })),
    top10Pct: +holders.slice(0, 10).reduce((s, [, v]) => s + pctOf(v), 0).toFixed(2), burnedPct: pctOf(burned),
    graduated, netEthIn: +(ethIn - ethOut).toFixed(4), graduateAtEth: GRADUATE_ETH,
    priceUsd, mcapUsd: priceUsd ? Math.round(priceUsd * eth(info.supply)) : null,
    explorer: `${EXPLORER}/token/${token}`,
  };
}

async function tokenMeta(env, addr) {
  return cached(env, `erc20:${addr}`, async () => {
    const m = await erc20(addr);
    return m ? { symbol: m.symbol || short(addr), decimals: m.decimals } : null;
  });
}

async function curveToken(env, curve) {
  return cached(env, `curve:${curve}`, async () => {
    const r = await call(curve, "0xfc0c546a");
    return r && r.length >= 66 ? addrOf(r) : null;
  });
}

// What a wallet did on Robinhood Chain in a block window (default: the last ~90 minutes).
export async function walletActivity(env, addr, { from, to } = {}) {
  addr = addr.toLowerCase();
  const head = to ?? (await headBlock());
  from = Math.max(from ?? head - OPEN_SPAN + 1, head - 3 * OPEN_SPAN);
  const t = topicOf(addr);
  const [code, balHex, nonceHex] = await Promise.all([rpc("eth_getCode", [addr, "latest"]), rpc("eth_getBalance", [addr, "latest"]), rpc("eth_getTransactionCount", [addr, "latest"])]);
  const inLogs = await logs({ topics: [T.transfer, null, t] }, from, head, OPEN_SPAN);
  const outLogs = await logs({ topics: [T.transfer, t] }, from, head, OPEN_SPAN);
  const buyLogs = await logs({ topics: [T.buy, null, t] }, from, head, OPEN_SPAN);
  const sellLogs = await logs({ topics: [T.sell, t] }, from, head, OPEN_SPAN);
  const trades = [];
  for (const l of [...buyLogs.map((l) => ["buy", l]), ...sellLogs.map((l) => ["sell", l])]) {
    const [side, x] = l;
    const w = words(x.data);
    const token = await curveToken(env, x.address.toLowerCase());
    const m = token ? await tokenMeta(env, token) : null;
    trades.push({
      side, token, symbol: m?.symbol || "?", block: parseInt(x.blockNumber, 16), when: ago(head - parseInt(x.blockNumber, 16)),
      eth: +eth(side === "buy" ? w[0] : w[1]).toFixed(5), tokens: Math.round(eth(side === "buy" ? w[1] : w[0])), tx: x.transactionHash,
    });
  }
  trades.sort((a, b) => b.block - a.block);
  const tradeTx = new Set(trades.map((x) => x.tx));
  const transfers = [];
  for (const [dir, list] of [["in", inLogs], ["out", outLogs]]) {
    for (const l of list) {
      if (tradeTx.has(l.transactionHash)) continue;
      const m = await tokenMeta(env, l.address.toLowerCase());
      if (!m) continue;
      transfers.push({
        dir, token: l.address.toLowerCase(), symbol: m.symbol, amount: +(Number(BigInt(l.data)) / 10 ** m.decimals).toPrecision(6),
        counterparty: addrOf(dir === "in" ? l.topics[1] : l.topics[2]), block: parseInt(l.blockNumber, 16), when: ago(head - parseInt(l.blockNumber, 16)), tx: l.transactionHash,
      });
    }
  }
  transfers.sort((a, b) => b.block - a.block);
  return {
    address: addr, contract: code !== "0x", ethBalance: +eth(BigInt(balHex)).toFixed(5), txCount: parseInt(nonceHex, 16),
    window: { from, to: head, minutes: Math.round(((head - from) * MS_PER_BLOCK) / 60000) },
    trades: trades.slice(0, 25), transfers: transfers.slice(0, 25), explorer: `${EXPLORER}/address/${addr}`,
  };
}

// New Pons launches in a block window, with the creator's launch buy.
export async function ponsLaunches(env, { from, to } = {}) {
  const head = to ?? (await headBlock());
  from = Math.max(from ?? head - 3300, head - 50000);
  const [launches, lbs] = await Promise.all([
    logs({ address: FACTORY, topics: [T.launch] }, from, head, ADDR_SPAN),
    logs({ address: LAUNCH_AND_BUY }, from, head, ADDR_SPAN),
  ]);
  const dev = new Map(lbs.filter((l) => l.topics[0].startsWith(T.launchBuy)).map((l) => [addrOf(l.topics[1]), eth(words(l.data)[1])]));
  const out = launches.map((l) => {
    const token = addrOf(l.topics[1]);
    return { token, curve: addrOf(l.topics[2]), creator: addrOf(l.topics[3]), block: parseInt(l.blockNumber, 16), when: ago(head - parseInt(l.blockNumber, 16)), devBuyEth: +(dev.get(token) || 0).toFixed(4) };
  }).reverse();
  return { head, from, launches: out };
}

export async function nameLaunches(env, list, n = 12) {
  for (const x of list.slice(0, n)) {
    const m = await erc20(x.token);
    x.symbol = m?.symbol || "?";
    x.name = m?.name || "";
  }
  return list;
}

// Recent sells by each creator on their own curve, to tell "dev still holding" from "dev dumped".
export async function devSold(env, launches) {
  if (!launches.length) return new Map();
  const head = await headBlock();
  const from = Math.max(Math.min(...launches.map((l) => l.block)), head - 99000);
  const curves = launches.map((l) => l.curve);
  const sells = await rpc("eth_getLogs", [{ address: curves, topics: [T.sell], fromBlock: hex(from), toBlock: hex(head) }]).catch(() => []);
  const byCurve = new Map(launches.map((l) => [l.curve.toLowerCase(), l.creator.toLowerCase()]));
  const sold = new Map();
  for (const s of sells) {
    const creator = byCurve.get(s.address.toLowerCase());
    if (creator && addrOf(s.topics[1]) === creator) sold.set(s.address.toLowerCase(), (sold.get(s.address.toLowerCase()) || 0) + eth(words(s.data)[1]));
  }
  return sold;
}

export async function inspect(env, raw) {
  const c = classify(raw);
  if (c.kind !== "evm") return c;
  const code = await rpc("eth_getCode", [c.address, "latest"]);
  if (code !== "0x") {
    const t = await ponsToken(env, c.address).catch((e) => ({ error: e.message }));
    if (t && !t.error) return { kind: t.pons ? "pons_token" : "token", ...t };
    if (t?.error) return { kind: "error", note: `chain read failed: ${t.error}` };
    return { kind: "contract", address: c.address, note: "a contract, but not an erc-20 token.", explorer: `${EXPLORER}/address/${c.address}` };
  }
  return { kind: "wallet", ...(await walletActivity(env, c.address)) };
}
