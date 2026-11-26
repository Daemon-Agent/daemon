# DAEMON

Always-on AI agents. Give one a job in a sentence. Close the tab. It keeps going.

Live at [usedaemon.xyz](https://usedaemon.xyz) · Telegram [@usedaemonagent](https://t.me/usedaemonagent) · X [@usedaemonagent](https://x.com/usedaemonagent)

## What it does

You send one sentence to the Telegram bot, like `watch ETH and ping me on a 2% move` or `every morning, read new arXiv agent papers and send me the 3 worth reading`. A planner turns it into a job, and a scheduler runs it every few minutes or hours, whether or not anyone has a browser open. The agent keeps a work log and a memory between runs, and messages you only when something matters.

Watch jobs run on fixed tools:

| tool | source |
|---|---|
| `price` | Coinbase and Kraken spot, cross-checked |
| `hn` | Hacker News via the Algolia API |
| `arxiv` | arXiv listings for a category |
| `watch_url` | re-reads a public page and notices when it changes |
| `rhchain` | Robinhood Chain RPC, with Blockscout as fallback |

Agents with the `computer` tool get their own Linux sandbox ([E2B](https://e2b.dev)). They write and run scripts, keep files between runs, and use a real browser. The sandbox pauses between runs, so the files stay.

The public night office on the site shows the house agents working live, with their logs and screenshots. You can try a job there without a wallet or an account.

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

Every model call is real; there are no canned replies. With an `OPENAI_API_KEY` set, calls go to OpenAI under a daily budget: `max(OPENAI_FLOOR_USD, AI_FEE_SHARE × creator fees of the last 24h)`. Every call is booked in the `ledger` table with its real token usage. Past the budget, or without a key, agents fall back to open models on Cloudflare Workers AI (Llama 3.3 70B, Llama 3.1 8B, gpt-oss-120b). Which models are live, and today's spend against the budget, are public at [`/api/meta`](https://usedaemon.xyz/api/meta).

Numbers such as prices, blocks and gas come from the sources above, never from a model. The model is only called when the data changed.

## Layout

```
contracts/       DaemonWallet + DaemonWalletFactory (solc 0.8.24, viaIR, cancun)
worker/src/      Cloudflare Worker: API, cron scheduler, agents, Telegram, wallets, economics
worker/scripts/  deploy + verify the factory, operator key setup, bot profile
site/            the static site and night office
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
node scripts/new-operator.mjs             # operator key -> worker secret
node scripts/deploy-factory.mjs           # needs a little ETH on the operator
npx wrangler deploy
```

## License

MIT
