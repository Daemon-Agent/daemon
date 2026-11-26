(() => {
  const cfg = window.DAEMON_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const page = document.body.dataset.page;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const caReady = cfg.ca && !cfg.ca.includes("{");
  const pad = (n) => String(n).padStart(2, "0");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<)]+[^\s<).,;:!?'"]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.length > 64 ? `${u.slice(0, 61)}…` : u}</a>`);
  const usd = (x) => (x === null || x === undefined ? "—" : `$${Number(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: x && x < 1 ? 4 : 2 })}`);
  const ago = (ts) => {
    const m = Math.round((Date.now() - ts) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };
  const meta = cfg.metaUrl ? fetch(cfg.metaUrl).then((r) => r.json()).catch(() => null) : Promise.resolve(null);

  // nav: active page + mobile menu
  const here = location.pathname.replace(/\.html$/, "").replace(/\/$/, "") || "/";
  document.querySelectorAll(".procnav a").forEach((a) => {
    if (a.getAttribute("href") === here) a.setAttribute("aria-current", "page");
  });
  const nav = $("#procnav"), toggle = $("#navtoggle");
  toggle?.addEventListener("click", () => {
    const open = nav.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "close" : "menu";
  });

  // mascots
  const tpl = $("#mascot-tpl");
  const mascots = [];
  for (const id of ["hero-mascot", "escapee", "footer-mascot"]) {
    const host = document.getElementById(id);
    if (!host || !tpl) continue;
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelectorAll("[id]").forEach((el) => {
      const nid = `${el.id}-${id}`;
      node.querySelectorAll(`[fill="url(#${el.id})"]`).forEach((u) => u.setAttribute("fill", `url(#${nid})`));
      el.id = nid;
    });
    host.appendChild(node);
    mascots.push(node);
  }

  // lamp glow + horn cursor
  const horn = $(".horn-cursor");
  addEventListener("pointermove", (e) => {
    document.documentElement.style.setProperty("--mx", `${e.clientX}px`);
    document.documentElement.style.setProperty("--my", `${e.clientY}px`);
    horn.style.left = `${e.clientX}px`;
    horn.style.top = `${e.clientY}px`;
    horn.classList.toggle("on", !!e.target.closest(".cta, .btn, .chip, .tab-x"));
    resetIdle();
  });

  // uptime
  if ($("#uptime")) {
    const start = Date.parse(cfg.startTime) || Date.now();
    const tickUptime = () => {
      let s = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const d = Math.floor(s / 86400); s %= 86400;
      const h = Math.floor(s / 3600); s %= 3600;
      const m = Math.floor(s / 60); s %= 60;
      $("#uptime").textContent = `${pad(d)}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
    };
    tickUptime();
    setInterval(tickUptime, 1000);
  }

  // contract address
  const caText = $("#ca-text"), caLink = $("#ca-link"), copyBtn = $("#copy-ca");
  if (caText) {
    if (caReady) {
      caText.textContent = cfg.ca;
      caLink.href = `https://robinhoodchain.blockscout.com/token/${cfg.ca}`;
    } else {
      caText.textContent = "appears at launch";
      caLink.hidden = true;
      copyBtn.hidden = true;
    }
    copyBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(cfg.ca);
      copyBtn.textContent = "copied";
      setTimeout(() => (copyBtn.textContent = "copy"), 1200);
    });
  }

  const streamInto = (el, lines, max = 6, every = 900) => {
    if (!el) return;
    let i = 0;
    const buf = [];
    const step = () => {
      buf.push(lines[i++ % lines.length]);
      if (buf.length > max) buf.shift();
      el.textContent = buf.join("\n");
    };
    step();
    if (!reduced) setInterval(step, every);
  };

  // home: hero log, tab gag, night city ledger
  if (page === "home") {
    streamInto($("#hero-log"), [
      "> sleeping: no",
      "> coffee: not required",
      "> you: offline. me: fine.",
      "> while true; do work; done",
      "> raise requested: never",
      "> tab status: irrelevant",
    ], 4, 1400);
    streamInto($("#gag-log"), [
      "$ daemon run --job \"watch the dev wallet\"",
      "  reading robinhood chain ...",
      "  dev still holding",
      "  nothing new. next look in 10m",
      "  notes saved",
      "  still here",
    ], 9, 700);

    const browser = $("#fake-browser"), escapee = $("#escapee"), still = $("#still"), stage = $("#gag-stage"), blackout = $("#blackout");
    $("#tab-x").addEventListener("click", () => {
      blackout.classList.add("on");
      setTimeout(() => {
        browser.classList.add("closed");
        blackout.classList.remove("on");
        escapee.classList.remove("out");
        void escapee.offsetWidth;
        escapee.classList.add("out");
        still.classList.add("show");
      }, 1100);
      if (!stage.querySelector(".reset")) {
        const r = document.createElement("button");
        r.className = "reset mono";
        r.textContent = "reopen tab";
        r.addEventListener("click", () => {
          browser.classList.remove("closed");
          escapee.classList.remove("out");
          still.classList.remove("show");
          r.remove();
        });
        stage.appendChild(r);
      }
    });

    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const starsSvg = $("#stars"), citySvg = $("#city");
    starsSvg.innerHTML = Array.from({ length: 70 }, () =>
      `<circle cx="${(rnd() * 400).toFixed(1)}" cy="${(rnd() * 300).toFixed(1)}" r="${(rnd() * 1.2 + .3).toFixed(2)}" fill="#F2EDE4" opacity="${(rnd() * .6 + .2).toFixed(2)}"/>`).join("");
    let city = "", x = -10, officeDone = false;
    while (x < 410) {
      const w = 34 + rnd() * 40, h = 70 + rnd() * 140, top = 220 - h;
      city += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#06060B" stroke="#1D1D2A" stroke-width=".6"/>`;
      for (let wy = top + 10; wy < 210; wy += 14) {
        for (let wx = x + 6; wx < x + w - 8; wx += 11) {
          const r = rnd();
          if (!officeDone && x > 150 && wy > top + 30) {
            city += `<rect class="office-win" x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="6" height="8" fill="#FF3B2F"/>`;
            officeDone = true;
          } else if (r > .84) {
            city += `<rect class="lit" x="${wx.toFixed(1)}" y="${wy.toFixed(1)}" width="6" height="8" fill="#F2EDE4" opacity=".55"/>`;
          }
        }
      }
      x += w + 2;
    }
    citySvg.innerHTML = city;
    const litWins = citySvg.querySelectorAll(".lit");
    const ledger = $("#ledger"), sky = $("#sky"), sun = $("#sun"), clock = $("#clock"), morning = $("#morning");
    const lines = [...document.querySelectorAll("#ledger-lines li")];
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const rgb = (c) => `rgb(${c.join(",")})`;
    const onScroll = () => {
      const r = ledger.getBoundingClientRect();
      const total = r.height - innerHeight;
      const p = Math.min(1, Math.max(0, -r.top / total / 0.92));
      const t = Math.max(0, (p - 0.55) / 0.45);
      sky.style.background = `linear-gradient(${rgb(mix([5, 5, 12], [255, 160, 110], t))}, ${rgb(mix([34, 30, 70], [255, 214, 160], t))})`;
      sun.style.top = `${110 - t * 62}%`;
      starsSvg.style.opacity = String(1 - t);
      litWins.forEach((w, i) => (w.style.opacity = i / litWins.length < p * 1.4 ? "0" : ".55"));
      const mins = Math.round(23 * 60 + 58 + p * (6 * 60 + 32 + 2));
      clock.textContent = `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
      lines.forEach((li) => li.classList.toggle("on", p >= +li.dataset.at));
      morning.classList.toggle("on", p >= 0.97);
    };
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // live feed (home preview + office)
  let agents = [];
  const feedEl = $("#feed"), emptyEl = $("#feed-empty"), drawer = $("#drawer");
  if (feedEl) {
    const limit = +feedEl.dataset.limit || 0;
    const fmtUp = (sec) => {
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
      return h >= 48 ? `${Math.floor(h / 24)}d` : h ? `${h}h ${m}m` : `${m}m`;
    };
    const renderFeed = () => {
      const shown = limit ? agents.slice(0, limit) : agents;
      emptyEl.hidden = shown.length > 0;
      feedEl.innerHTML = shown.map((a, i) => `
        <button class="card" data-i="${i}">
          ${a.thumb ? `<img src="${esc(a.thumb)}" alt="" loading="lazy" />` : ""}
          <div class="card-body">
            <div class="card-top"><span class="card-name">${esc(a.name)}</span><i class="st ${a.status === "waiting" ? "waiting" : "working"}"></i></div>
            <div class="card-job">${esc(a.job)}</div>
            <div class="card-step">› ${esc(a.step)}</div>
            <div class="card-up">up ${fmtUp(a.uptimeSec || 0)}${a.lastLine ? ` · ${esc(a.lastLine)}` : ""}</div>
          </div>
        </button>`).join("");
    };
    let lastFeed = null, openId = null;
    const loadFeed = async () => {
      try {
        const r = await fetch(cfg.feedUrl, { cache: "no-store" });
        if (!r.ok) throw new Error(r.status);
        const j = await r.json();
        agents = Array.isArray(j.agents) ? j.agents : [];
      } catch {
        agents = [];
      }
      const snap = JSON.stringify(agents);
      if (snap === lastFeed) return;
      lastFeed = snap;
      renderFeed();
      const open = openId && agents.find((a) => a.id === openId);
      if (open && !drawer.hidden) $("#drawer-log").textContent = (open.log || [open.step]).join("\n");
    };
    loadFeed();
    setInterval(loadFeed, 8000);
    feedEl.addEventListener("click", (e) => {
      const card = e.target.closest(".card");
      if (!card) return;
      const a = agents[+card.dataset.i];
      openId = a.id;
      $("#drawer-title").textContent = a.name;
      $("#drawer-log").textContent = (a.log || [a.step]).join("\n");
      drawer.hidden = false;
    });
    $("#drawer-x").addEventListener("click", () => (drawer.hidden = true));
  }

  // office: finished work
  if ($("#gallery")) {
    fetch("/api/files").then((r) => r.json()).then(({ files }) => {
      $("#gallery-empty").hidden = files.length > 0;
      $("#gallery").innerHTML = files.map((f) => `
        <a class="file" href="${esc(f.url)}" target="_blank" rel="noopener">
          <div class="thumb">${f.mime.startsWith("image/") ? `<img src="${esc(f.url)}" alt="${esc(f.name)}" loading="lazy" />` : `<span class="ext">.${esc(f.name.split(".").pop())}</span>`}</div>
          <div class="meta mono"><b>${esc(f.name)}</b>${esc(f.agent)} · ${ago(f.ts)} · ${Math.max(1, Math.round(f.size / 1024))} KB<br />${esc(f.job)}</div>
        </a>`).join("");
    }).catch(() => ($("#gallery-empty").hidden = false));
  }

  // numbers (how + token)
  const nums = $("#nums");
  if (nums) {
    meta.then((m) => {
      const e = m?.economics;
      if (!e) return (nums.innerHTML = `<div><b>—</b><span>numbers unavailable right now</span></div>`);
      const cells = page === "token"
        ? [[usd(e.feesAllTimeUsd), "creator fees earned, all time"], [usd(e.aiAllTimeUsd), "spent on models, all time"], [usd(e.burnedTodayUsd), "$DAEMON burned today"], [`$${e.usdPerHour}`, "buys 1 hour of computer time"]]
        : [[usd(e.aiSpentTodayUsd), "spent on models today"], [usd(e.aiBudgetTodayUsd), "model budget today"], [usd(e.fees24hUsd), "creator fees, last 24h"], [usd(e.burnedTodayUsd), "$DAEMON burned today"]];
      nums.innerHTML = cells.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");
      if ($("#econ-copy") && e.floorUsd !== undefined) {
        $("#econ-copy").textContent = `It thinks with OpenAI models. When OpenAI is down or the day's model budget is spent, it falls back to open models on Cloudflare Workers AI. The daily budget is ${Math.round(e.feeShare * 100)}% of the last 24 hours of creator fees, never below $${e.floorUsd}.`;
      }
      if ($("#rate")) $("#rate").textContent = `1 hour per $${e.usdPerHour} burned`;
    });
  }

  // how: what's live
  if ($("#status-rows")) {
    const rows = [
      ["talk to a daemon on the web and in telegram, with live tools", () => true],
      ["watchers: prices, hacker news, arxiv, any public page", () => true],
      ["robinhood chain: wallet, pons token and new-launch watchers", () => true],
      ["long memory across runs, run caps, kill switch, full logs", () => true],
      ["public live office feed", () => true],
      ["telegram reports and files", (m) => !!m.telegram],
      ["own linux computer per daemon (python, files, real browser)", (m) => m.sandbox],
      ["one-time research jobs that hand over report.md, csv, charts", (m) => m.sandbox && !!m.telegram],
      ["daemon wallets on robinhood chain, cap enforced by the contract", (m) => !!m.wallets],
      ["one-tap approvals for payments", (m) => !!(m.wallets && m.telegram)],
      ["$DAEMON burn pass for computer time", (m) => !!m.burnPass],
      ["model spend capped by creator fees, public at /api/meta", (m) => !!m.economics],
      ["open source, contracts verified on Sourcify", () => !!cfg.github],
      ["daemons that hand work to other daemons", null],
      ["daemon template marketplace", null],
    ];
    const render = (m) => {
      $("#status-rows").innerHTML = rows.map(([w, live]) => {
        const s = !live ? "next" : m && live(m) ? "live" : "launch";
        return `<tr><td>${w}</td><td class="${s}">${s === "launch" ? "at launch" : s}</td></tr>`;
      }).join("");
    };
    render(null);
    meta.then((m) => m && render(m));
  }

  // token: burns
  if ($("#burns")) {
    fetch("/api/burns").then((r) => r.json()).then(({ burns }) => {
      $("#burns-empty").hidden = burns.length > 0;
      $("#burns").innerHTML = burns.map((b) => `<li><span>${(Number(BigInt(b.amount) / 10n ** 15n) / 1000).toLocaleString("en-US", { maximumFractionDigits: 0 })} $DAEMON → ${Math.round(b.sec / 60)} min · ${ago(b.ts)}</span><a href="https://robinhoodchain.blockscout.com/tx/${esc(b.tx)}" target="_blank" rel="noopener">tx ↗</a></li>`).join("");
    }).catch(() => ($("#burns-empty").hidden = false));
  }

  // chat
  if (page === "chat") {
    const log = $("#chat-log"), form = $("#chat-form"), input = $("#chat-in"), send = $("#chat-send"), chips = $("#chips");
    let sid = localStorage.getItem("daemon_sid");
    if (!/^[a-f0-9]{24}$/.test(sid || "")) {
      sid = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("daemon_sid", sid);
    }
    const scroll = () => (log.scrollTop = log.scrollHeight);
    const add = (role, text, extra = "") => {
      const el = document.createElement("div");
      el.className = `msg ${role}`;
      el.innerHTML = linkify(text) + extra;
      log.appendChild(el);
      scroll();
      return el;
    };
    const showAgent = (a, tg) => {
      if (!a) return;
      $("#my-daemon").hidden = false;
      $("#my-name").textContent = a.id;
      $("#my-job").textContent = a.job;
      $("#my-step").textContent = a.status === "active" ? `› ${a.step}` : `› ${a.status === "done" ? "clocked out" : a.status}`;
      $("#my-log").textContent = (a.log || []).join("\n");
      const c = $("#my-claim");
      if (tg) { c.href = tg; c.hidden = false; }
    };
    const offerCard = (o) => {
      if (!o) return;
      const el = document.createElement("div");
      el.className = "offer mono";
      el.innerHTML = `<p><b>${esc(o.what)}</b></p><p>${esc(o.cadence)}</p><div class="row"><button class="btn" data-go>${o.telegramOnly ? "Start it in Telegram" : "Start it"}</button><button class="btn ghost" data-no>Not now</button></div>`;
      log.appendChild(el);
      scroll();
      el.querySelector("[data-no]").addEventListener("click", () => el.remove());
      el.querySelector("[data-go]").addEventListener("click", async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        b.textContent = "starting…";
        try {
          const r = await fetch("/api/chat/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, key: o.key }) });
          const j = await r.json();
          el.remove();
          if (j.error) return add("daemon", j.error);
          add("daemon", j.say);
          if (j.firstLook?.length) add("daemon", `first look:\n${j.firstLook.join("\n")}`);
          if (j.agent) { showAgent(j.agent, j.telegram); watch(); }
          else if (j.telegram) {
            const m = add("daemon", "");
            m.innerHTML = `<a class="btn" href="${esc(j.telegram)}" target="_blank" rel="noopener">Open Telegram</a>`;
          }
        } catch {
          b.disabled = false;
          b.textContent = "try again";
        }
      });
    };
    let watching = null;
    const refresh = async () => {
      const j = await fetch(`/api/chat?sid=${sid}`).then((r) => r.json()).catch(() => null);
      if (j?.agent) showAgent(j.agent, j.telegram);
      return j;
    };
    const watch = () => { if (!watching) watching = setInterval(refresh, 15000); };

    refresh().then((j) => {
      const turns = j?.turns || [];
      if (!turns.length) add("daemon", "daemon here. ask me something i can look up live, or tell me what you need watched or researched. when it's a job, i'll offer to start a daemon that keeps going after you leave.");
      for (const t of turns) add(t.role === "user" ? "user" : "daemon", t.text);
      if (turns.length) chips.hidden = true;
      if (j?.offer) offerCard(j.offer);
      if (j?.agent?.status === "active") watch();
    });

    const sendMsg = async (text) => {
      text = text.trim().slice(0, 500);
      if (!text || send.disabled) return;
      chips.hidden = true;
      add("user", text);
      input.value = "";
      input.style.height = "";
      send.disabled = true;
      const thinking = add("daemon thinking", "looking");
      try {
        const r = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sid, text }) });
        const j = await r.json();
        thinking.remove();
        const looked = j.looked?.length ? `<span class="looked">looked at: ${j.looked.map(esc).join(", ")}</span>` : "";
        add("daemon", j.say || j.error || "something went wrong. try again.", looked);
        if (j.offer) offerCard(j.offer);
        if (r.status === 429 && j.telegram) {
          const m = add("daemon", "");
          m.innerHTML = `<a class="btn" href="${esc(j.telegram)}" target="_blank" rel="noopener">Continue in Telegram</a>`;
        }
      } catch {
        thinking.remove();
        add("daemon", "couldn't reach the office. try again in a moment.");
      }
      send.disabled = false;
      input.focus();
    };
    form.addEventListener("submit", (e) => { e.preventDefault(); sendMsg(input.value); });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMsg(input.value); } });
    input.addEventListener("input", () => { input.style.height = ""; input.style.height = `${Math.min(160, input.scrollHeight)}px`; });
    chips.addEventListener("click", (e) => { const c = e.target.closest(".chip"); if (c) sendMsg(c.textContent); });
  }

  // footer links (only real ones)
  const renderLinks = () => {
    const links = [`<a href="/chat">chat</a>`, `<a href="/office">office</a>`, `<a href="/how">how</a>`, `<a href="/token">$DAEMON</a>`];
    if (cfg.x) links.push(`<a href="${cfg.x}" target="_blank" rel="noopener">x ↗</a>`);
    if (cfg.github) links.push(`<a href="${cfg.github}" target="_blank" rel="noopener">source ↗</a>`);
    if (cfg.telegram) links.push(`<a href="${cfg.telegram}" target="_blank" rel="noopener">telegram ↗</a>`);
    if (caReady) links.push(`<a href="https://robinhoodchain.blockscout.com/token/${cfg.ca}" target="_blank" rel="noopener">blockscout ↗</a>`);
    $("#footer-links").innerHTML = links.join("");
  };
  renderLinks();
  meta.then((m) => { if (m?.telegram && m.telegram !== cfg.telegram) { cfg.telegram = m.telegram; renderLinks(); } });

  // idle: mascot looks at you
  let idleT;
  function resetIdle() {
    mascots.forEach((m) => m.classList.remove("look"));
    clearTimeout(idleT);
    idleT = setTimeout(() => {
      mascots.forEach((m) => m.classList.add("look"));
      setTimeout(() => mascots.forEach((m) => m.classList.remove("look")), 2500);
    }, 60000);
  }
  resetIdle();

  // console
  const con = $("#console"), cin = $("#console-in"), cout = $("#console-out");
  const print = (s) => { cout.textContent += `\n${s}`; con.scrollTop = con.scrollHeight; };
  addEventListener("keydown", (e) => {
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
    if (e.key === "`" && !typing) {
      e.preventDefault();
      con.hidden = !con.hidden;
      if (!con.hidden) cin.focus();
    } else if (e.key === "Escape") {
      con.hidden = true;
      if (drawer) drawer.hidden = true;
    }
  });
  cin.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const cmd = cin.value.trim();
    cin.value = "";
    print(`$ ${cmd}`);
    if (cmd === "help") print("commands: ps aux, kill -9 daemon, uptime, whoami, talk, clear");
    else if (cmd === "ps aux") print(agents.length ? agents.map((a, i) => `${String(i + 100).padEnd(6)}${a.name.padEnd(24)} ${a.status || "working"}`).join("\n") : "open ./office to see who's clocked in.");
    else if (/^kill\s+(-9\s+)?daemon/.test(cmd)) {
      print("nice try.");
      const m = $("#hero-mascot") || $("#footer-mascot");
      m.classList.remove("respawn"); void m.offsetWidth; m.classList.add("respawn");
    }
    else if (cmd === "uptime") print($("#uptime")?.textContent || "since 2026-11-25. still going.");
    else if (cmd === "whoami") print("the one who closes tabs.");
    else if (cmd === "talk") location.href = "/chat";
    else if (cmd === "clear") cout.textContent = "";
    else if (cmd) print(`daemon: ${cmd.split(" ")[0]}: not a thing. try help`);
  });
})();
