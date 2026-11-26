CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  job TEXT NOT NULL,
  kind TEXT NOT NULL,              -- house | trial | user
  owner_chat TEXT,
  plan TEXT NOT NULL DEFAULT '{}', -- {tool, args, notify_when}
  every_min INTEGER NOT NULL,
  next_run INTEGER NOT NULL DEFAULT 0,
  last_run INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active | killed | done
  memory TEXT NOT NULL DEFAULT '{}',
  step TEXT NOT NULL DEFAULT 'clocking in',
  runs_total INTEGER NOT NULL DEFAULT 0,
  runs_today INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL DEFAULT '',
  run_cap INTEGER NOT NULL DEFAULT 96,   -- per day (house/user) or total (trial)
  public INTEGER NOT NULL DEFAULT 1,
  thumb TEXT,
  thumb_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agents_due ON agents(status, next_run);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  line TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_agent ON logs(agent_id, id);

CREATE TABLE IF NOT EXISTS hits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  agent_id TEXT PRIMARY KEY,
  chat TEXT NOT NULL,
  address TEXT NOT NULL,
  owner TEXT NOT NULL,
  cap_wei TEXT NOT NULL,
  created INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  chat TEXT NOT NULL,
  kind TEXT NOT NULL,             -- pay
  payload TEXT NOT NULL,          -- {to, value_wei, reason}
  status TEXT NOT NULL,           -- pending | approved | denied | failed | expired
  created INTEGER NOT NULL,
  decided INTEGER,
  result TEXT
);

CREATE TABLE IF NOT EXISTS credits (
  chat TEXT PRIMARY KEY,
  sec INTEGER NOT NULL DEFAULT 0,
  free_day TEXT NOT NULL DEFAULT '',
  free_used INTEGER NOT NULL DEFAULT 0,
  burned TEXT NOT NULL DEFAULT '0'
);

CREATE TABLE IF NOT EXISTS burns (
  tx TEXT PRIMARY KEY,
  chat TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  amount TEXT NOT NULL,
  sec INTEGER NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- web chat sessions; claim is the one-time code that moves the session's daemon to telegram
CREATE TABLE IF NOT EXISTS chats (
  sid TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  day TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  claim TEXT,
  offer TEXT,                     -- a planned job waiting for "start it"
  turns TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS chats_claim ON chats (claim);

-- deliverables a daemon produced on its computer (report.md, table.csv, chart.png)
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  body TEXT NOT NULL              -- base64
);
CREATE INDEX IF NOT EXISTS files_agent ON files (agent_id, ts);

-- money in and out, in USD: kind = ai (model spend), fee (creator fees earned), burn (value of $DAEMON burned), price (token price sample)
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  usd REAL NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ledger_kind_ts ON ledger (kind, ts);
