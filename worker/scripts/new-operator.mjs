#!/usr/bin/env node
// Generates the DAEMON runner (operator) key, stores it as the OPERATOR_KEY worker secret
// and keeps a backup outside the repo. Prints only the address.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const backup = path.join(os.homedir(), ".daemon-operator.key");
let key;
if (fs.existsSync(backup)) {
  key = fs.readFileSync(backup, "utf8").trim();
  console.log("reusing existing operator key from backup");
} else {
  key = generatePrivateKey();
  fs.writeFileSync(backup, `${key}\n`, { mode: 0o600 });
}
const address = privateKeyToAccount(key).address;

const r = spawnSync("npx", ["wrangler", "secret", "put", "OPERATOR_KEY"], {
  input: key,
  encoding: "utf8",
  shell: true,
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
});
if (r.status !== 0) {
  console.error("wrangler secret put failed:", (r.stderr || r.stdout || "").split("\n").slice(-5).join("\n"));
  process.exit(1);
}
console.log(`operator address: ${address}`);
console.log(`backup: ${backup}`);
