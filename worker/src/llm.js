// Real model calls only. OpenAI while the daily budget allows it, otherwise Workers AI.
import { aiBudget, recordAi } from "./econ.js";

const CF = {
  small: "@cf/meta/llama-3.1-8b-instruct-fast",
  big: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  agent: "@cf/openai/gpt-oss-120b",
};
const OA = { small: "gpt-6-luna", big: "gpt-6-luna", agent: "gpt-6-luna", pro: "gpt-6.1-terra" };
const cfSize = (size) => (size === "pro" ? "agent" : size);
const oaModel = (env, size) => env[`OPENAI_MODEL_${size.toUpperCase()}`] || OA[size];

function responsesText(res) {
  if (typeof res?.output_text === "string") return res.output_text;
  const msg = (res?.output || []).filter((o) => o.type === "message").at(-1);
  return (msg?.content || []).map((c) => c.text || "").join("") || res?.response || "";
}

export function llmName(env, size = "small") {
  if (env.OPENAI_API_KEY) return `openai:${oaModel(env, size)}`;
  return `workers-ai:${CF[cfSize(size)].split("/").pop()}`;
}

export function parseJson(raw) {
  if (raw && typeof raw === "object") return raw;
  const txt = String(raw || "").trim();
  const fenced = txt.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fenced ? fenced[1] : txt;
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model reply had no JSON");
  return JSON.parse(s.slice(a, b + 1));
}

async function openai(env, model, { system, user, maxTokens, json }) {
  const body = {
    model,
    max_completion_tokens: maxTokens + 1000,
    reasoning_effort: "low",
    ...(json ? { response_format: { type: "json_object" } } : {}),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  const call = (b) => fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(b),
  });
  let r = await call(body);
  if (r.status === 400 && /reasoning_effort/.test(await r.clone().text())) {
    delete body.reasoning_effort;
    r = await call(body);
  }
  if (!r.ok) throw new Error(`openai HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  await recordAi(env, model, j.usage || {});
  return j.choices?.[0]?.message?.content ?? "";
}

async function workersAi(env, size, { system, user, maxTokens }) {
  if (!env.AI) throw new Error("no model configured");
  size = cfSize(size);
  if (size === "agent") {
    try {
      const res = await env.AI.run(CF.agent, { instructions: system, input: user, reasoning: { effort: "low" }, max_output_tokens: maxTokens + 1500 });
      const text = responsesText(res);
      if (text) return { provider: `workers-ai:${CF.agent.split("/").pop()}`, text };
    } catch {}
    size = "big";
  }
  const res = await env.AI.run(CF[size], {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.3,
    max_tokens: maxTokens,
  });
  return { provider: `workers-ai:${CF[size].split("/").pop()}`, text: res?.response ?? "" };
}

export async function llmText(env, size, { system, user, maxTokens = 500, json = false }) {
  if (env.OPENAI_API_KEY && (await aiBudget(env)).ok) {
    const model = oaModel(env, size);
    try {
      return { provider: `openai:${model}`, text: await openai(env, model, { system, user, maxTokens, json }) };
    } catch (e) {
      await env.DB.prepare("INSERT INTO meta (k,v) VALUES ('openai_error',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
        .bind(`${new Date().toISOString()} ${e.message}`).run();
    }
  }
  return workersAi(env, size, { system, user, maxTokens });
}

export async function llmJson(env, size, opts) {
  const { provider, text } = await llmText(env, size, { ...opts, json: true });
  return { provider, out: parseJson(text) };
}
