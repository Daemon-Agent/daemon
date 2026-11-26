// Night-shift seconds per Telegram chat: a free daily allowance first, then seconds bought by burning $DAEMON.
const free = (env) => +env.FREE_SECONDS_PER_DAY || 600;
const today = () => new Date().toISOString().slice(0, 10);

async function row(env, chat) {
  await env.DB.prepare("INSERT OR IGNORE INTO credits (chat) VALUES (?)").bind(chat).run();
  return env.DB.prepare("SELECT * FROM credits WHERE chat=?").bind(chat).first();
}

export async function balance(env, chat) {
  const r = await row(env, chat);
  const used = r.free_day === today() ? r.free_used : 0;
  return { freeLeft: Math.max(0, free(env) - used), paid: r.sec, burned: r.burned };
}

export async function spend(env, chat, sec) {
  const r = await row(env, chat);
  const d = today();
  const used = r.free_day === d ? r.free_used : 0;
  const fromFree = Math.min(sec, Math.max(0, free(env) - used));
  const fromPaid = Math.min(r.sec, sec - fromFree);
  await env.DB.prepare("UPDATE credits SET free_day=?, free_used=?, sec=sec-? WHERE chat=?").bind(d, used + fromFree, fromPaid, chat).run();
}

export async function credit(env, chat, sec, burnedWei) {
  await row(env, chat);
  const r = await env.DB.prepare("SELECT burned FROM credits WHERE chat=?").bind(chat).first();
  const total = (BigInt(r.burned || "0") + BigInt(burnedWei)).toString();
  await env.DB.prepare("UPDATE credits SET sec=sec+?, burned=? WHERE chat=?").bind(sec, total, chat).run();
}
