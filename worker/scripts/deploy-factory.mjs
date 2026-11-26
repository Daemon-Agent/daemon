#!/usr/bin/env node
// Deploys DaemonWalletFactory from the operator key, verifies it on Sourcify, then runs an
// onchain check of the wallet rules: cap enforced, freeze blocks the operator, owner can withdraw.
//   node scripts/deploy-factory.mjs            deploy + verify + test
//   node scripts/deploy-factory.mjs --test 0x  test an existing factory
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, formatEther, http, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { compileContract, verifyOnSourcifyV2 } from "./sourcify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOL = path.resolve(HERE, "../../contracts/DaemonWallet.sol");
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const opKey = fs.readFileSync(path.join(os.homedir(), ".daemon-operator.key"), "utf8").trim();
const op = privateKeyToAccount(opKey);
const pub = createPublicClient({ chain, transport: http(RPC) });
const wal = (account) => createWalletClient({ account, chain, transport: http(RPC) });

const factoryArt = compileContract(SOL, "DaemonWalletFactory");
const walletArt = compileContract(SOL, "DaemonWallet");

async function send(account, req) {
  const hash = await wal(account).writeContract(req);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`reverted: ${hash}`);
  return hash;
}

async function expectRevert(label, fn) {
  try {
    await fn();
    throw new Error(`EXPECTED REVERT: ${label}`);
  } catch (e) {
    if (String(e.message).startsWith("EXPECTED REVERT")) throw e;
    console.log(`  [ok] ${label} reverted`);
  }
}

const bal = await pub.getBalance({ address: op.address });
console.log(`operator ${op.address} holds ${formatEther(bal)} ETH`);
if (bal < parseEther("0.0001")) {
  console.error("fund the operator first (0.001 ETH is plenty)");
  process.exit(1);
}

let factory = process.argv.includes("--test") ? process.argv[process.argv.indexOf("--test") + 1] : null;
if (!factory) {
  const hash = await wal(op).deployContract({ abi: factoryArt.abi, bytecode: factoryArt.bytecode, args: [op.address] });
  const r = await pub.waitForTransactionReceipt({ hash });
  factory = r.contractAddress;
  console.log(`factory deployed: ${factory} (tx ${hash})`);
  await new Promise((s) => setTimeout(s, 4000));
  const v = await verifyOnSourcifyV2({ address: factory, artifact: factoryArt }).catch((e) => ({ ok: false, error: e.message }));
  console.log(v.ok ? `sourcify: ${v.match}` : `sourcify failed: ${v.error}`);
}

// onchain rules check with a throwaway owner key
const owner = privateKeyToAccount(generatePrivateKey());
const agentId = keccak256(toHex(`selftest-${Date.now()}`));
const cap = parseEther("0.00002");
const wallet = await pub.readContract({ address: factory, abi: factoryArt.abi, functionName: "predict", args: [owner.address, agentId, cap] });
await send(op, { address: factory, abi: factoryArt.abi, functionName: "create", args: [owner.address, agentId, cap] });
console.log(`test wallet ${wallet} (owner ${owner.address}, cap 0.00002 ETH/day)`);

await wal(op).sendTransaction({ to: wallet, value: parseEther("0.00005") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
const W = { address: wallet, abi: walletArt.abi };
await send(op, { ...W, functionName: "pay", args: [op.address, parseEther("0.000015"), "selftest under cap"] });
console.log("  [ok] operator paid 0.000015 under cap");
await expectRevert("operator paying past the daily cap", () => send(op, { ...W, functionName: "pay", args: [op.address, parseEther("0.00001"), "over cap"] }));
await expectRevert("operator raising its own cap", () => send(op, { ...W, functionName: "setCap", args: [parseEther("1")] }));
await expectRevert("operator withdrawing", () => send(op, { ...W, functionName: "withdraw", args: [op.address, 1n] }));

// owner needs gas for its own calls
await wal(op).sendTransaction({ to: owner.address, value: parseEther("0.00001") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
await send(owner, { ...W, functionName: "setFrozen", args: [true] });
await expectRevert("operator paying while frozen", () => send(op, { ...W, functionName: "pay", args: [op.address, 1n, "frozen"] }));
const left = await pub.getBalance({ address: wallet });
await send(owner, { ...W, functionName: "withdraw", args: [op.address, left] });
console.log(`  [ok] owner froze it and withdrew ${formatEther(left)} ETH`);

console.log(`\nWALLET_FACTORY=${factory}`);
