/*
 * Bryton Active sync: log in over Meteor DDP (WebSocket), list the rides and download each new FIT through the
 * user's Cloudflare Worker (Bryton's REST API sends no CORS headers). New rides go into the history and on to
 * intervals.icu and Dropbox (GoldenCheetah). Protocol from github.com/jorge-huxley/intervalssync (MIT).
 * Only the session token is stored, never the password.
 */
(function () {
  "use strict";

  const CFG_KEY = "rodillo.bryton";
  const DEFAULT_WORKER = "https://bryton-proxy.wfmoralesp.workers.dev";
  const HOSTS = { international: "m3.brytonactive.com", china: "active.cn.brytonactive.com" };
  const FIRST_SYNC_DAYS = 7;

  let app = null;
  let running = false;
  const $ = (s) => document.querySelector(s);

  const loadCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (e) { return {}; } };
  const saveCfg = (c) => { try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) { /* ignore */ } };

  async function sha256Hex(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Minimal Meteor DDP client over a raw WebSocket. */
  function ddpConnect(host, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://" + host + "/websocket");
      let nextId = 1;
      const pending = {}, subs = {}, collections = {};
      const fail = (err) => {
        for (const p of Object.values(pending)) p.rej(err);
        for (const p of Object.values(subs)) p.rej(err);
      };
      const timer = setTimeout(() => { reject(new Error("Bryton no responde")); try { ws.close(); } catch (e) { /* ignore */ } }, timeoutMs || 20000);
      const withTimeout = (promise) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("Bryton no responde")), 60000))]);
      const client = {
        collections,
        call(method, params) {
          const id = String(nextId++);
          const p = new Promise((res, rej) => { pending[id] = { res, rej }; });
          ws.send(JSON.stringify({ msg: "method", method, params, id }));
          return withTimeout(p);
        },
        subscribe(name, params) {
          const id = String(nextId++);
          const p = new Promise((res, rej) => { subs[id] = { res, rej }; });
          ws.send(JSON.stringify({ msg: "sub", id, name, params: params || [] }));
          return withTimeout(p);
        },
        close() { try { ws.close(); } catch (e) { /* ignore */ } },
      };
      ws.onopen = () => ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1", "pre2", "pre1"] }));
      ws.onerror = () => { clearTimeout(timer); const err = new Error("no se pudo conectar con Bryton"); reject(err); fail(err); };
      ws.onmessage = (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch (e) { return; }
        if (m.msg === "ping") ws.send(JSON.stringify({ msg: "pong", id: m.id }));
        else if (m.msg === "connected") { clearTimeout(timer); resolve(client); }
        else if (m.msg === "failed") { clearTimeout(timer); reject(new Error("Bryton rechazó la conexión")); }
        else if (m.msg === "result" && pending[m.id]) {
          const p = pending[m.id]; delete pending[m.id];
          if (m.error) { const err = new Error(m.error.reason || m.error.message || "error de Bryton"); err.ddp = m.error; p.rej(err); }
          else p.res(m.result);
        } else if (m.msg === "added") {
          (collections[m.collection] = collections[m.collection] || {})[m.id] = m.fields || {};
        } else if (m.msg === "changed") {
          const doc = ((collections[m.collection] = collections[m.collection] || {})[m.id] = collections[m.collection][m.id] || {});
          Object.assign(doc, m.fields || {});
          for (const k of m.cleared || []) delete doc[k];
        } else if (m.msg === "removed") {
          if (collections[m.collection]) delete collections[m.collection][m.id];
        } else if (m.msg === "ready") {
          for (const id of m.subs || []) if (subs[id]) { subs[id].res(); delete subs[id]; }
        } else if (m.msg === "nosub" && subs[m.id]) {
          subs[m.id].rej(new Error("Bryton no entregó la lista de actividades")); delete subs[m.id];
        }
      };
    });
  }

  /** Log in with email and password; returns {userId, token}. */
  async function login(host, email, password) {
    const client = await ddpConnect(host);
    try {
      const r = await client.call("login", [{ user: { email }, password: { digest: await sha256Hex(password), algorithm: "sha-256" } }]);
      if (!r || !r.id || !r.token) throw new Error("respuesta inesperada de Bryton");
      return { userId: r.id, token: r.token };
    } finally { client.close(); }
  }

  /** Recent activities of the logged-in user, newest first: [{id, name, start}] (start in Unix seconds). */
  async function listActivities(cfg) {
    const client = await ddpConnect(cfg.host);
    try {
      try { await client.call("login", [{ resume: cfg.token }]); } catch (e) {
        const err = new Error("la sesión de Bryton caducó: vuelve a conectar en Ajustes"); err.expired = true; throw err;
      }
      await client.subscribe("activityList", []);
      const docs = client.collections.userActivities || {};
      return Object.entries(docs)
        .filter(([, f]) => !f._deleted && (f.name || f.title) !== "_deleted")
        .map(([id, f]) => ({ id, name: f.name || f.title || "", start: toSeconds(f.start_time) || toSeconds(f.local_start_time) }))
        .sort((a, b) => b.start - a.start);
    } finally { client.close(); }
  }

  /** Bryton dates may come as Unix seconds, milliseconds, EJSON {$date: ms} or an ISO string; 0 when unknown. */
  const toSeconds = (t) => {
    if (t && typeof t === "object" && t.$date != null) t = t.$date;
    let n = typeof t === "string" && !/^\d+$/.test(t) ? Date.parse(t) : +t;
    if (!isFinite(n) || n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : n;
  };

  async function downloadFit(cfg, activityId) {
    const base = (cfg.worker || DEFAULT_WORKER).replace(/\/+$/, "");
    const res = await fetch(base + "/activity?id=" + encodeURIComponent(activityId), {
      headers: { "x-user-id": cfg.userId, "x-auth-token": cfg.token, "x-bryton-host": cfg.host },
    });
    if (res.status === 401 || res.status === 403) { const err = new Error("la sesión de Bryton caducó: vuelve a conectar en Ajustes"); err.expired = true; throw err; }
    if (!res.ok) throw new Error("descarga HTTP " + res.status);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length < 14 || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== ".FIT") throw new Error("Bryton no devolvió un FIT");
    return bytes;
  }

  const GENERIC_NAME = /^(new activity|activity|a|ride|)$/i;

  /** Pull new Bryton rides into the history and forward them. */
  async function sync(opts) {
    const auto = opts && opts.auto;
    const cfg = loadCfg();
    if (!cfg.token) { if (!auto) app.toast("Conecta primero tu cuenta de Bryton en Ajustes.", "warn"); return; }
    if (running) return;
    running = true;
    setStatus("Sincronizando Bryton…");
    try {
      const list = await listActivities(cfg);
      const done = new Set(cfg.done || []);
      const from = cfg.since || 0;
      const summaries = (await window.RodilloViews.loadData()).summaries;
      const have = new Set(summaries.map((s) => s.id));
      const todo = list.filter((a) => (!a.start || a.start >= from) && !done.has(a.id) && !have.has("bryton-" + a.id)).reverse();
      let got = 0, failed = 0;
      for (let i = 0; i < todo.length; i++) {
        const a = todo[i];
        setStatus("Bajando actividad de Bryton " + (i + 1) + "/" + todo.length + "…");
        try {
          const bytes = await downloadFit(cfg, a.id);
          const name = GENERIC_NAME.test(a.name.trim()) ? null : a.name;
          const result = await window.RodilloViews.importFitBytes(bytes, { name, forward: true, id: "bryton-" + a.id, source: "bryton", skipOverlap: true });
          if (result === "ok") got++;
          done.add(a.id);
        } catch (e) {
          if (e.expired) throw e;
          failed++;
        }
      }
      const fresh = loadCfg();
      fresh.done = [...done].slice(-500);
      fresh.lastSync = Date.now();
      saveCfg(fresh);
      if (got) {
        app.toast(got === 1 ? "1 salida nueva del Bryton, enviada a intervals.icu y GoldenCheetah." : got + " salidas nuevas del Bryton, enviadas a intervals.icu y GoldenCheetah.");
        window.RodilloViews.refreshDataView();
      } else if (!auto) app.toast("Bryton: no hay salidas nuevas.");
      if (failed) app.toast("Bryton: " + failed + " actividad(es) no se pudieron bajar; se reintenta en la próxima sincronización.", "warn");
      renderStatus();
    } catch (e) {
      setStatus("No se pudo sincronizar Bryton: " + (e.message || e));
      if (e.expired) { const c = loadCfg(); c.expired = true; saveCfg(c); renderStatus(); }
      if (!auto || e.expired) app.toast("Bryton: " + (e.message || e), "warn");
    } finally {
      running = false;
    }
  }

  function autoSync() {
    const cfg = loadCfg();
    if (!cfg.token || cfg.expired || document.visibilityState !== "visible") return;
    if (document.body.dataset.view === "ride") return;
    if (cfg.lastSync && Date.now() - cfg.lastSync < 5 * 60 * 1000) return;
    sync({ auto: true });
  }

  function setStatus(text) { const n = $("#bryton-status"); if (n) n.textContent = text; }

  function renderStatus() {
    const cfg = loadCfg();
    const connected = !!cfg.token;
    setStatus(!connected ? "Sin conectar."
      : cfg.expired ? "La sesión caducó: vuelve a conectar."
      : "Conectado como " + (cfg.email || "") + (cfg.lastSync ? " · última sincronización " + new Date(cfg.lastSync).toLocaleString("es") : "") + ".");
    $("#bryton-login").hidden = connected && !cfg.expired;
    $("#bryton-disconnect").hidden = !connected;
    $("#bryton-sync").hidden = !connected || !!cfg.expired;
  }

  function fillSettings() {
    const cfg = loadCfg();
    $("#bryton-email").value = cfg.email || "";
    $("#bryton-pass").value = "";
    $("#bryton-region").value = cfg.region || "international";
    $("#bryton-worker").value = cfg.worker || DEFAULT_WORKER;
    renderStatus();
  }

  async function connect() {
    const email = $("#bryton-email").value.trim();
    const password = $("#bryton-pass").value;
    const region = $("#bryton-region").value;
    const worker = $("#bryton-worker").value.trim() || DEFAULT_WORKER;
    if (!email || !password) { app.toast("Escribe el email y la contraseña de Bryton Active.", "warn"); return; }
    setStatus("Conectando…");
    try {
      const host = HOSTS[region] || HOSTS.international;
      const session = await login(host, email, password);
      const old = loadCfg();
      saveCfg({
        email, region, host, worker, userId: session.userId, token: session.token,
        since: old.since || Math.floor(Date.now() / 1000) - FIRST_SYNC_DAYS * 86400, done: old.done || [],
      });
      $("#bryton-pass").value = "";
      renderStatus();
      sync();
    } catch (e) {
      setStatus("No se pudo conectar: " + (e.message || e));
    }
  }

  function disconnect() {
    const cfg = loadCfg();
    // Keep the list of imported rides so a reconnect does not import them again
    saveCfg({ email: cfg.email, region: cfg.region, worker: cfg.worker, since: cfg.since, done: cfg.done });
    renderStatus();
  }

  function init(helpers) {
    app = helpers;
    $("#btn-settings").addEventListener("click", fillSettings);
    $("#bryton-login").addEventListener("click", connect);
    $("#bryton-disconnect").addEventListener("click", disconnect);
    $("#bryton-sync").addEventListener("click", () => sync());
    $("#bryton-worker").addEventListener("change", () => {
      const cfg = loadCfg(); cfg.worker = $("#bryton-worker").value.trim() || DEFAULT_WORKER; saveCfg(cfg);
    });
    setTimeout(autoSync, 4000);
    setInterval(autoSync, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", autoSync);
  }

  window.RodilloBryton = { init, sync, login, listActivities, downloadFit };
})();
