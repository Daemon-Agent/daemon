#!/usr/bin/env node
// After $DAEMON launches: node scripts/set-burn-token.mjs <factory> <tokenCA>
// One-time call; the factory refuses a second one.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const [factory, token] = process.argv.slice(2).map((a) => getAddress(a));
const RPC = "https://rpc.mainnet.chain.robinhood.com";
const chain = defineChain({ id: 4663, name: "Robinhood Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = privateKeyToAccount(fs.readFileSync(path.join(os.homedir(), ".daemon-operator.key"), "utf8").trim());
const abi = parseAbi(["function setBurnToken(address)", "function burnToken() view returns (address)"]);
const pub = createPublicClient({ chain, transport: http(RPC) });
const hash = await createWalletClient({ account, chain, transport: http(RPC) }).writeContract({ address: factory, abi, functionName: "setBurnToken", args: [token] });
await pub.waitForTransactionReceipt({ hash });
console.log(`burnToken = ${await pub.readContract({ address: factory, abi, functionName: "burnToken" })} (tx ${hash})`);
