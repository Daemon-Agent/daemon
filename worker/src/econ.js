// Unit economics: model spend is capped by what the token earns, and burns are credited at a USD price per hour.
import { formatEther, parseAbi, parseEther } from "viem";
import { pub } from "./wallet.js";
import { price } from "./tools.js";

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const PROBE = "0x000000000000000000000000000000000000dAd0";

// USD per 1M tokens: [input, cached input, output]
const PRICES = {
  "gpt-6-luna": [0.1, 0.01, 0.5],
  "gpt-6.1-terra": [1, 0.05, 5],
  "gpt-6.1-sol": [2, 0.1, 10],
  "gpt-6.2-sol": [2, 0.1, 10],
  "gpt-6-sol": [2, 0.2, 10],
};
const UNKNOWN = [2, 0.2, 10];

const CURVE_ABI = parseAbi([
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)",
  "function creatorTaxBalance() view returns (uint256)",
  "function feeEscrow() view returns (address)",
]);
const ESCROW_ABI = parseAbi(["function balanceOf(address recipient) view returns (uint256)"]);

const startOfDay = () => new Date(new Date().toISOString().slice(0, 10)).getTime();
const usdPerHour = (env) => +env.USD_PER_HOUR || 1;

async function sum(env, kind, since) {
  const r = await env.DB.prepare("SELECT COALESCE(SUM(usd),0) s FROM ledger WHERE kind=? AND ts>=?").bind(kind, since).first();
  return r.s;
}

async function meta(env, k, v) {
  if (v === undefined) return (await env.DB.prepare("SELECT v FROM meta WHERE k=?").bind(k).first())?.v ?? null;
  await env.DB.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(k, String(v)).run();
}

export function modelCost(model, usage = {}) {
  const [inp, cached, out] = PRICES[model] || UNKNOWN;
  const c = usage.prompt_tokens_details?.cached_tokens || 0;
  const p = (usage.prompt_tokens || 0) - c;
  return (p * inp + c * cached + (usage.completion_tokens || 0) * out) / 1e6;
}

export async function recordAi(env, model, usage) {
  const usd = modelCost(model, usage);
  await env.DB.prepare("INSERT INTO ledger (ts,kind,usd,note) VALUES (?,?,?,?)")
    .bind(Date.now(), "ai", usd, `${model} ${usage.prompt_tokens || 0}/${usage.completion_tokens || 0}`).run();
  return usd;
}

// Daily model budget: AI_FEE_SHARE of the creator fees earned in the last 24h, never below the OPENAI_FLOOR_USD floor.
export async function aiBudget(env) {
  const floor = +env.OPENAI_FLOOR_USD || 5;
  const share = env.AI_FEE_SHARE === undefined ? 0.5 : +env.AI_FEE_SHARE;
  const [spent, fees24h] = await Promise.all([sum(env, "ai", startOfDay()), sum(env, "fee", Date.now() - DAY)]);
  const budget = Math.max(floor, share * fees24h);
  return { spent, budget, fees24h, share, floor, ok: spent < budget };
}

// Price of 1 token in ETH, quoted by simulating a tiny buy on the Pons curve (after graduation: DexScreener).
async function spotEth(env) {
  if (env.CURVE_ADDRESS) {
    try {
      const probe = parseEther("0.0001");
      const { result } = await pub.simulateContract({
        address: env.CURVE_ADDRESS, abi: CURVE_ABI, functionName: "buy", args: [probe, 0n, PROBE], value: probe,
        account: PROBE, stateOverride: [{ address: PROBE, balance: parseEther("1") }],
      });
      if (result > 0n) return 0.0001 / Number(formatEther(result));
    } catch {}
  }
  const j = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${env.TOKEN_ADDRESS}`).then((r) => r.json()).catch(() => null);
  const pair = (j?.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  return pair?.priceNative ? +pair.priceNative : null;
}

// Conservative USD price: the lower of spot and the last hour's average, so a pump right before a burn buys nothing extra.
export async function tokenUsd(env) {
  const avg = await env.DB.prepare("SELECT AVG(usd) a, COUNT(*) n FROM ledger WHERE kind='price' AND ts>=?").bind(Date.now() - HOUR).first();
  const [eth, ethUsd] = await Promise.all([spotEth(env), price("ETH").then((p) => p.usd)]);
  if (!eth) return null;
  const spot = eth * ethUsd;
  return avg.n >= 3 ? Math.min(spot, avg.a) : spot;
}

export function secondsFor(env, usd) {
  return Math.floor((usd / usdPerHour(env)) * 3600);
}

async function creatorEth(env) {
  const recipient = env.FEE_RECIPIENT;
  const [tax, escrow] = await Promise.all([
    pub.readContract({ address: env.CURVE_ADDRESS, abi: CURVE_ABI, functionName: "creatorTaxBalance" }).catch(() => 0n),
    pub.readContract({ address: env.CURVE_ADDRESS, abi: CURVE_ABI, functionName: "feeEscrow" }).catch(() => null),
  ]);
  const held = escrow ? await pub.readContract({ address: escrow, abi: ESCROW_ABI, functionName: "balanceOf", args: [recipient] }).catch(() => 0n) : 0n;
  return tax + held;
}

// Every cron tick: sample the token price and book new creator fees (claims lower the balance and just reset the baseline).
export async function econTick(env) {
  if (!env.TOKEN_ADDRESS) return;
  const now = Date.now();
  const ethUsd = (await price("ETH")).usd;
  const eth = await spotEth(env).catch(() => null);
  if (eth) await env.DB.prepare("INSERT INTO ledger (ts,kind,usd,note) VALUES (?,?,?,?)").bind(now, "price", eth * ethUsd, `${eth} eth`).run();
  if (env.CURVE_ADDRESS && env.FEE_RECIPIENT) {
    const cur = await creatorEth(env);
    const last = await meta(env, "fee_wei");
    if (last !== null && cur > BigInt(last)) {
      const usd = Number(formatEther(cur - BigInt(last))) * ethUsd;
      await env.DB.prepare("INSERT INTO ledger (ts,kind,usd,note) VALUES (?,?,?,?)").bind(now, "fee", usd, formatEther(cur - BigInt(last))).run();
    }
    await meta(env, "fee_wei", cur.toString());
  }
  await env.DB.prepare("DELETE FROM ledger WHERE kind='price' AND ts<?").bind(now - DAY).run();
}

export async function econSummary(env) {
  const b = await aiBudget(env);
  const since = startOfDay();
  const [burnToday, feesAll, aiAll] = await Promise.all([sum(env, "burn", since), sum(env, "fee", 0), sum(env, "ai", 0)]);
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    usdPerHour: usdPerHour(env),
    aiSpentTodayUsd: r2(b.spent), aiBudgetTodayUsd: r2(b.budget), feeShare: b.share,
    fees24hUsd: r2(b.fees24h), burnedTodayUsd: r2(burnToday),
    feesAllTimeUsd: r2(feesAll), aiAllTimeUsd: r2(aiAll),
  };
}
