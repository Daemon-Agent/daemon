import { createPublicClient, createWalletClient, defineChain, fallback, formatEther, getAddress, http, isAddress, keccak256, parseAbi, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "Blockscout", url: EXPLORER } },
});

const FACTORY_ABI = parseAbi([
  "function create(address owner, bytes32 agentId, uint256 dailyCap) returns (address)",
  "function predict(address owner, bytes32 agentId, uint256 dailyCap) view returns (address)",
  "function burnToken() view returns (address)",
]);
const WALLET_ABI = parseAbi([
  "function pay(address to, uint256 value, string memo)",
  "function burn() returns (uint256)",
  "function remainingToday() view returns (uint256)",
  "function dailyCap() view returns (uint256)",
  "function frozen() view returns (bool)",
  "function owner() view returns (address)",
  "function operator() view returns (address)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const transport = () => fallback([http("https://robinhood.rpc.pinax.network"), http(RPC)], { retryCount: 2 });
export const pub = createPublicClient({ chain, transport: transport() });
const opClient = (env) => createWalletClient({ account: privateKeyToAccount(env.OPERATOR_KEY), chain, transport: transport() });

export const walletsEnabled = (env) => Boolean(env.OPERATOR_KEY && env.WALLET_FACTORY);
export const operatorAddress = (env) => (env.OPERATOR_KEY ? privateKeyToAccount(env.OPERATOR_KEY).address : null);
export const validAddress = (s) => isAddress(String(s || "")) ? getAddress(s) : null;
export { formatEther, parseEther };

async function send(env, req) {
  const hash = await opClient(env).writeContract(req);
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 25000 });
  if (receipt.status !== "success") throw new Error(`tx reverted ${hash}`);
  return hash;
}

export async function createWallet(env, agentId, owner, capEth) {
  const salt = keccak256(toHex(agentId));
  const cap = parseEther(String(capEth));
  const address = await pub.readContract({ address: env.WALLET_FACTORY, abi: FACTORY_ABI, functionName: "predict", args: [owner, salt, cap] });
  const code = await pub.getCode({ address });
  if (code && code !== "0x") return { address, tx: null, capWei: cap.toString() };
  const tx = await send(env, { address: env.WALLET_FACTORY, abi: FACTORY_ABI, functionName: "create", args: [owner, salt, cap] });
  return { address, tx, capWei: cap.toString() };
}

export async function walletState(env, address) {
  const read = (functionName) => pub.readContract({ address, abi: WALLET_ABI, functionName });
  const [balance, remaining, cap, frozen, owner, operator] = await Promise.all([
    pub.getBalance({ address }), read("remainingToday"), read("dailyCap"), read("frozen"), read("owner"), read("operator"),
  ]);
  const token = env.TOKEN_ADDRESS ? await pub.readContract({ address: env.TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [address] }) : 0n;
  return { balance, remaining, cap, frozen, owner, operator, token };
}

export async function pay(env, wallet, to, valueWei, memo) {
  return send(env, { address: wallet, abi: WALLET_ABI, functionName: "pay", args: [to, BigInt(valueWei), String(memo).slice(0, 120)] });
}

export async function burnHeld(env, wallet) {
  if (!env.TOKEN_ADDRESS) return null;
  const amount = await pub.readContract({ address: env.TOKEN_ADDRESS, abi: ERC20_ABI, functionName: "balanceOf", args: [wallet] });
  if (amount === 0n) return null;
  const tx = await send(env, { address: wallet, abi: WALLET_ABI, functionName: "burn", args: [] });
  return { amount, tx };
}

export async function operatorGas(env) {
  const a = operatorAddress(env);
  return a ? pub.getBalance({ address: a }) : 0n;
}

export const fmtEth = (wei) => `${Number(formatEther(BigInt(wei))).toLocaleString("en-US", { maximumFractionDigits: 6 })} ETH`;
