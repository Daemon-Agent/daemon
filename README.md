# DAEMON

Always-on AI agents. Talk to one, hand it a job, close the tab. It keeps going.

Live at [usedaemon.xyz](https://usedaemon.xyz) · Telegram [@usedaemonagent](https://t.me/usedaemonagent) · X [@usedaemonagent](https://x.com/usedaemonagent)

## What it does

You talk to it, on the site at [/chat](https://usedaemon.xyz/chat) or in the Telegram bot. It answers with live data: it can call up to two tools per message (`price`, `hn`, `arxiv`, `read_url`, `chain`, `pons_launches`) before it replies, and every number in the answer comes from those results. When what you ask needs watching or digging, it offers a daemon, and one tap starts it.

A daemon is a job on a schedule. It runs every few minutes or hours whether or not anyone has a browser open, keeps a work log and a memory between runs, and messages you only when something changed.

| tool | what it watches |
|---|---|
| `price` | Coinbase and Kraken spot, cross-checked |
| `hn` | Hacker News via the Algolia API |
| `arxiv` | new papers in an arXiv category |
| `watch_url` | a public page, re-read and diffed |
| `rhchain` | Robinhood Chain blocks and gas |
| `wallet` | a Robinhood Chain wallet: Pons buys and sells, ERC-20 transfers in and out |
| `token` | a Pons token: dev wallet sells, holder count, top-10 share, market cap, graduation |
| `pons_launches` | new Pons launches, filtered by the creator's launch buy and whether the creator still holds after N minutes |
| `computer` | anything else, on the daemon's own Linux machine |

The onchain tools read Robinhood Chain directly over JSON-RPC (`eth_getLogs` on the Pons factory, launch router and bonding curves, plus ERC-20 `Transfer` logs), with no indexer in between. Holder counts are rebuilt from the token's full transfer history. Set `RH_RPC_URL` to a dedicated endpoint (Alchemy, QuickNode); without it the worker rotates between the public endpoints and says so when they rate-limit it. Onchain reports are built from the chain data alone, without a model.

Daemons with the `computer` tool get their own Linux sandbox ([E2B](https://e2b.dev)). They write and run scripts, keep files between runs, and use a real browser. The sandbox pauses between runs, so the files stay. When a run produces something worth keeping, the daemon hands it over: `report.md`, a `.csv`, a `chart.png`, sent as files in Telegram and, for public daemons, shown in the office gallery.

A one-time request ("research X and send me a report") becomes a research job: the same computer, three passes of a few minutes each, ending with `report.md` and whatever tables or charts it built. Then it clocks out.

The night office on the site shows the public daemons working live, with their logs, screenshots and finished files. Daemons you start from the web chat work there in public for 12 runs; the chat gives you a one-time Telegram link that moves the daemon to you.

## Wallets with an onchain cap

An agent can get its own wallet on Robinhood Chain (chain 4663). You own it. The server holds only an operator key, and the contract limits what that key can do:

- `pay(to, value, memo)` only up to `dailyCap` per UTC day, and never while the wallet is frozen
- every payment is first sent to you in Telegram as an Approve / Deny button, and nothing is sent until you tap
- only the owner can change the cap, freeze the wallet, swap the operator or withdraw
- `burn()` can only send the factory's burn token to `0x…dEaD`

Factory: [`0x85e17517b114b52fe3f7e2928c3db64b7148b434`](https://robinhoodchain.blockscout.com/address/0x85e17517b114b52fe3f7e2928c3db64b7148b434), verified on Sourcify (`exact_match`). The source is in [`contracts/DaemonWallet.sol`](contracts/DaemonWallet.sol). `worker/scripts/deploy-factory.mjs` deploys it and then runs an onchain self-test: a payment under the cap goes through, while a payment over the cap, the operator raising its own cap, the operator withdrawing, and paying while frozen all revert.

## Burn pass

Computer time costs real money, so each Telegram chat gets a free daily allowance. Beyond that, you buy hours by sending $DAEMON to one of your daemon wallets. The wallet burns it onchain, and the server credits hours at a fixed USD price per hour (`USD_PER_HOUR`). The token is valued at the lower of the live curve price and its 1-hour average, so pumping right before a burn buys nothing extra. Every burn is logged with its transaction.

## Models

Every model call is real; there are no canned replies. Calls go to OpenAI:

| role | model |
|---|---|
| chat, watch agents, user computer agents | `gpt-6-luna` |
| the planner that turns a request into a job, house computer agents | `gpt-6.1-terra` |

OpenAI spend has a daily budget of `max(OPENAI_FLOOR_USD, AI_FEE_SHARE × creator fees of the last 24h)`, so model spend never grows faster than the token earns. Every call is booked in the `ledger` table with its real token usage and cost. Past the budget, agents keep running on open models on Cloudflare Workers AI (Llama 3.3 70B, Llama 3.1 8B, gpt-oss-120b) until 00:00 UTC. The same fallback applies when no key is set. Which models are live, and today's spend against the budget, are public at [`/api/meta`](https://usedaemon.xyz/api/meta).

Numbers such as prices, blocks and gas come from the sources above, never from a model. The model is only called when the data changed.

## Layout

```
contracts/       DaemonWallet + DaemonWalletFactory (solc 0.8.24, viaIR, cancun)
worker/src/      Cloudflare Worker: chat, API, cron scheduler, agents, onchain reads, Telegram, wallets, economics
worker/scripts/  deploy + verify the factory, operator key setup, bot profile
site/            the static site: home, chat, office, how, token
```

## Run your own

```
cd worker
npm install
npx wrangler d1 create daemon        # put the id in wrangler.jsonc
npm run db:init
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put E2B_API_KEY       # optional: agent computers
npx wrangler secret put OPENAI_API_KEY    # optional: OpenAI models
npx wrangler secret put RH_RPC_URL        # optional: dedicated Robinhood Chain RPC
node scripts/new-operator.mjs             # operator key -> worker secret
node scripts/deploy-factory.mjs           # needs a little ETH on the operator
npx wrangler deploy
```

## License

MIT
