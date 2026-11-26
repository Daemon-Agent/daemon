(() => {
  const cfg = window.DAEMON_CONFIG || {};
  const $ = (s) => document.querySelector(s);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const caReady = cfg.ca && !cfg.ca.includes("{");

  // mascots
  const tpl = $("#mascot-tpl");
  const mascots = [];
  for (const id of ["hero-mascot", "escapee", "footer-mascot"]) {
    const host = document.getElementById(id);
    if (!host) continue;
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
    horn.classList.toggle("on", !!e.target.closest(".cta, .job, .tab-x"));
    resetIdle();
  });

  // uptime
  const start = Date.parse(cfg.startTime) || Date.now();
  const pad = (n) => String(n).padStart(2, "0");
  const tickUptime = () => {
    let s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    $("#uptime").textContent = `${pad(d)}d ${pad(h)}h ${pad(m)}m ${pad(s)}s`;
  };
  tickUptime();
  setInterval(tickUptime, 1000);

  // contract address
  const caText = $("#ca-text"), caLink = $("#ca-link"), copyBtn = $("#copy-ca");
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

  // decorative typing logs (personality, not activity data)
  const streamInto = (el, lines, max = 6, every = 900) => {
    let i = 0;
    const buf = [];
    const step = () => {
      buf.push(lines[i++ % lines.length]);
      if (buf.length > max) buf.shift();
      el.textContent = buf.join("\n");
    };
    step();
    if (!reduced) return setInterval(step, every);
  };
  streamInto($("#hero-log"), [
    "> sleeping: no",
    "> coffee: not required",
    "> you: offline. me: fine.",
    "> while true; do work; done",
    "> raise requested: never",
    "> tab status: irrelevant",
  ], 4, 1400);

  const gagLines = [
    "$ daemon run --job \"watch the price\"",
    "  opening browser ...",
    "  page loaded",
    "  reading ...",
    "  nothing yet. checking again in 5m",
    "  memory saved",
    "  still here",
  ];
  let gagTimer = streamInto($("#gag-log"), gagLines, 9, 700);

  // tab gag
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

  // live feed
  const feedEl = $("#feed"), emptyEl = $("#feed-empty");
  let agents = [];
  const fmtUp = (sec) => {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const renderFeed = () => {
    if (!agents.length) {
      feedEl.innerHTML = "";
      emptyEl.hidden = false;
      return;
    }
    emptyEl.hidden = true;
    feedEl.innerHTML = agents.map((a, i) => `
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
  let lastFeed = null;
  let openId = null;
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
    if (open && !$("#drawer").hidden) $("#drawer-log").textContent = (open.log || [open.step]).join("\n");
  };
  loadFeed();
  setInterval(loadFeed, 5000);

  const drawer = $("#drawer");
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

  // night city
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

  // overnight ledger
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

  // status table
  const rows = [
    ["summon agents from templates or a sentence", () => true],
    ["headless browser + live web tools per agent", () => true],
    ["long memory across runs", () => true],
    ["public live office feed", () => true],
    ["run caps, kill switch, full step logs", () => true],
    ["telegram reports", (m) => !!m.telegram],
    ["own cloud computer per agent (files, shell, python)", (m) => m.sandbox],
    ["agent wallets on Robinhood Chain, cap enforced by the contract", (m) => !!m.wallets],
    ["one-tap approvals for payments", (m) => !!(m.wallets && m.telegram)],
    ["$DAEMON burn pass for computer time", (m) => !!m.burnPass],
    ["daemons that hand work to other daemons", null],
    ["agent template marketplace", null],
  ];
  const renderStatus = (m) => {
    $("#status-rows").innerHTML = rows.map(([w, live]) => {
      const s = !live ? "next" : m && live(m) ? "live" : "launch";
      return `<tr><td>${w}</td><td class="${s}">${s === "launch" ? "at launch" : s}</td></tr>`;
    }).join("");
  };
  renderStatus(null);

  // footer links (only real ones)
  const renderLinks = () => {
    const links = [];
    if (cfg.x) links.push(`<a href="${cfg.x}" target="_blank" rel="noopener">x ↗</a>`);
    if (cfg.telegram) links.push(`<a href="${cfg.telegram}" target="_blank" rel="noopener">telegram bot ↗</a>`);
    if (caReady) links.push(`<a href="https://robinhoodchain.blockscout.com/token/${cfg.ca}" target="_blank" rel="noopener">blockscout ↗</a>`);
    $("#footer-links").innerHTML = links.join("");
  };
  renderLinks();
  if (cfg.metaUrl) {
    fetch(cfg.metaUrl).then((r) => r.json()).then((m) => {
      renderStatus(m);
      if (!cfg.telegram && m.telegram) { cfg.telegram = m.telegram; renderLinks(); }
    }).catch(() => {});
  }

  // summon modal
  const modal = $("#modal"), mlog = $("#modal-log");
  $("#summon").addEventListener("click", () => { modal.hidden = false; mlog.textContent = ""; });
  $("#modal-x").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  const jobs = document.querySelectorAll(".job");
  jobs.forEach((b) => b.addEventListener("click", async () => {
    mlog.textContent = `$ daemon summon --job ${b.dataset.job}\n  waking up ...`;
    jobs.forEach((x) => (x.disabled = true));
    try {
      const r = await fetch(cfg.trialUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job: b.dataset.job }) });
      const j = await r.json().catch(() => null);
      if (!j?.log) throw new Error(r.status);
      mlog.textContent += `\n  ${j.log.join("\n  ")}`;
      if (r.ok) loadFeed();
    } catch {
      mlog.textContent += "\n  the trial runner isn't connected yet. no fake run shown.";
    }
    jobs.forEach((x) => (x.disabled = false));
  }));

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
    if (e.key === "`" && document.activeElement !== cin) {
      e.preventDefault();
      con.hidden = !con.hidden;
      if (!con.hidden) cin.focus();
    } else if (e.key === "Escape") {
      con.hidden = true; modal.hidden = true; drawer.hidden = true;
    }
  });
  cin.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const cmd = cin.value.trim();
    cin.value = "";
    print(`$ ${cmd}`);
    if (cmd === "help") print("commands: ps aux, kill -9 daemon, uptime, whoami, clear");
    else if (cmd === "ps aux") print(agents.length ? agents.map((a, i) => `${String(i + 100).padEnd(6)}${a.name.padEnd(24)} ${a.status || "working"}`).join("\n") : "no daemons clocked in yet.");
    else if (/^kill\s+(-9\s+)?daemon/.test(cmd)) {
      print("nice try.");
      const hero = $("#hero-mascot");
      hero.classList.remove("respawn"); void hero.offsetWidth; hero.classList.add("respawn");
    }
    else if (cmd === "uptime") print($("#uptime").textContent);
    else if (cmd === "whoami") print("the one who closes tabs.");
    else if (cmd === "clear") cout.textContent = "";
    else if (cmd) print(`daemon: ${cmd.split(" ")[0]}: not a thing. try help`);
  });
})();
