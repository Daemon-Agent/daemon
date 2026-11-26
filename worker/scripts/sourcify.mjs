// Compile with solc 0.8.24 (same settings as the deployed contracts) and verify on Sourcify v2.
import fs from "node:fs";
import path from "node:path";
import solc from "solc";

const SOURCIFY_API = "https://sourcify.dev/server";
const UA = { "User-Agent": "daemon-verifier/1.0 (https://usedaemon.xyz)" };

export function compileContract(solPath, contractName) {
  const fileName = path.basename(solPath);
  const stdJsonInput = {
    language: "Solidity",
    sources: { [fileName]: { content: fs.readFileSync(solPath, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(stdJsonInput)));
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const compiled = out.contracts?.[fileName]?.[contractName];
  if (!compiled) throw new Error(`Contract '${contractName}' not found in ${fileName}`);
  return {
    contractName,
    fileName,
    compilerVersion: solc.version().match(/^(\d+\.\d+\.\d+\+commit\.[0-9a-f]+)/)?.[1] || solc.version(),
    abi: compiled.abi,
    bytecode: "0x" + compiled.evm.bytecode.object,
    stdJsonInput,
  };
}

export async function verifyOnSourcifyV2({ chainId = 4663, address, artifact }) {
  const check = await fetch(`${SOURCIFY_API}/v2/contract/${chainId}/${address}`, { headers: UA });
  if (check.status === 200) {
    const existing = await check.json();
    if (existing.match === "exact_match" || existing.match === "match") return { ok: true, match: existing.match, address, alreadyVerified: true };
  }
  const res = await fetch(`${SOURCIFY_API}/v2/verify/${chainId}/${address}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...UA },
    body: JSON.stringify({
      stdJsonInput: artifact.stdJsonInput,
      compilerVersion: artifact.compilerVersion,
      contractIdentifier: `${artifact.fileName}:${artifact.contractName}`,
    }),
  });
  const posted = await res.json().catch(() => ({}));
  if (!res.ok && !posted.verificationId) throw new Error(`Sourcify POST ${res.status}: ${JSON.stringify(posted)}`);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${SOURCIFY_API}/v2/verify/${posted.verificationId}`, { headers: UA }).then((r) => r.json());
    if (poll.isJobCompleted) {
      if (poll.contract?.match) return { ok: true, match: poll.contract.match, address };
      throw new Error(`Sourcify finished without match: ${JSON.stringify(poll.error || poll)}`);
    }
  }
  throw new Error(`Sourcify verification timed out (${posted.verificationId})`);
}
