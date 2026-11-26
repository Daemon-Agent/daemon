// Sets the Telegram bot's photo, name and descriptions.
// Usage: $env:TGT="<bot token>"; node scripts/bot-profile.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const token = process.env.TGT;
if (!token) throw new Error("set TGT to the bot token");
const api = (m) => `https://api.telegram.org/bot${token}/${m}`;

async function call(method, body) {
  const r = await fetch(api(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  console.log(method, j.ok ? "ok" : j.description);
  return j;
}

const logo = readFileSync(fileURLToPath(new URL("../../site/brand/logo.png", import.meta.url)));
const fd = new FormData();
fd.append("photo", JSON.stringify({ type: "static", photo: "attach://f" }));
fd.append("f", new Blob([logo], { type: "image/png" }), "logo.png");
const p = await (await fetch(api("setMyProfilePhoto"), { method: "POST", body: fd })).json();
console.log("setMyProfilePhoto", p.ok ? "ok" : p.description);

await call("setMyName", { name: "DAEMON" });
await call("setMyShortDescription", {
  short_description: "Always-on AI agents. Give one a job in a sentence. Close the tab. It keeps going. usedaemon.xyz",
});
await call("setMyDescription", {
  description: [
    "DAEMON runs AI agents that keep working after you close the tab.",
    "",
    'Send one sentence, like "watch ETH and ping me on a 2% move" or "every morning, read new arXiv agent papers and send me the 3 worth reading". Your daemon plans the job, runs it on a schedule, and messages you here when something matters.',
    "",
    "Some daemons get their own computer. Payments only go out after you tap Approve, under a daily cap enforced onchain.",
    "",
    "usedaemon.xyz",
  ].join("\n"),
});
