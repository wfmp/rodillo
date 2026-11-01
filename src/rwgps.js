/*
 * Ride with GPS (where the Bryton uploads outdoor rides): fetch new trips, turn the track points into a FIT,
 * keep the ride in the history, upload the FIT to Dropbox for GoldenCheetah and to intervals.icu for Forma.
 */
(function () {
  "use strict";

  const H = window.RodilloHistory;
  const F = window.RodilloFit;
  const W = window.RodilloWorkouts;
  const D = window.RodilloDropbox;
  const KEY = "rodillo.rwgps";
  const BASE = "https://ridewithgps.com";
  let app = null;
  let running = false;

  const $ = (s) => document.querySelector(s);
  const cfg = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  const saveCfg = (c) => { try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) { /* ignore */ } };
  const headers = (c) => ({ "x-rwgps-api-key": c.apiKey, "x-rwgps-auth-token": c.authToken, Accept: "application/json" });

  function setStatus(text) { for (const n of document.querySelectorAll(".rw-status")) n.textContent = text; }

  /** Exchange email + password for an auth token once; the password is not stored. */
  async function connect(apiKey, email, password) {
    const res = await fetch(BASE + "/api/v1/auth_tokens.json", {
      method: "POST",
      headers: { "x-rwgps-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ user: { email, password } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(res.status === 401 ? "email o contraseña incorrectos" : "HTTP " + res.status);
    const tok = data.auth_token || data;
    if (!tok.auth_token) throw new Error("Ride with GPS no devolvió un token");
    const c = cfg();
    Object.assign(c, { apiKey, authToken: tok.auth_token, userId: tok.user && tok.user.id, since: c.since || Math.floor(Date.now() / 1000) - 7 * 86400 });
    saveCfg(c);
  }

  async function getJson(path) {
    const c = cfg();
    const res = await fetch(BASE + path, { headers: headers(c) });
    if (res.status === 401) throw new Error("la conexión con Ride with GPS caducó: vuelve a conectar en Ajustes");
    if (!res.ok) throw new Error("Ride with GPS HTTP " + res.status);
    return res.json();
  }

  /** Trips newer than the start date, newest first, following pagination while they are recent enough. */
  async function recentTrips(since) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const data = await getJson("/api/v1/trips.json?page=" + page);
      const list = data.trips || data.results || (Array.isArray(data) ? data : []);
      if (!list.length) break;
      let older = false;
      for (const t of list) {
        const start = Math.floor(new Date(t.departed_at || t.created_at).getTime() / 1000);
        if (start >= since) out.push(Object.assign({ start }, t)); else older = true;
      }
      const next = data.meta && data.meta.pagination && data.meta.pagination.next_page_url;
      if (older || !next) break;
    }
    return out;
  }

  /** Track points (t, x, y, e, d, s km/h, h, c, p, lap) -> 1 Hz samples; gaps up to 5 s are filled. */
  function toSamples(points) {
    const pts = points.filter((p) => p.t != null).sort((a, b) => a.t - b.t);
    const out = [];
    let lap = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], next = pts[i + 1];
      if (p.lap && out.length) lap++;
      const span = next && next.t - p.t > 0 && next.t - p.t <= 5 ? next.t - p.t : 1;
      for (let k = 0; k < span; k++) {
        const ts = Math.round(p.t) + k;
        if (out.length && ts <= out[out.length - 1].ts) continue;
        out.push({
          ts, lap, power: p.p == null ? null : Math.round(p.p), hr: p.h || null, cadence: p.c == null ? null : Math.round(p.c),
          speed: p.s == null ? null : p.s / 3.6, distance: p.d == null ? null : p.d,
          lat: p.y, lon: p.x, alt: p.e == null ? null : p.e,
        });
      }
    }
    return out;
  }

  function fileName(start, name) {
    const d = new Date(start * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const clean = String(name || "Salida").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w.-]+/g, "_").slice(0, 40);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + "_" + clean + ".fit";
  }

  async function uploadToIntervals(bytes, name, fname) {
    let icu = {};
    try { icu = JSON.parse(localStorage.getItem("rodillo.intervals") || "{}"); } catch (e) { icu = {}; }
    if (!icu.apiKey) return false;
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "application/octet-stream" }), fname);
    const res = await fetch("https://intervals.icu/api/v1/athlete/" + encodeURIComponent(icu.athleteId || "0") + "/activities?name=" + encodeURIComponent(name), {
      method: "POST", headers: { Authorization: "Basic " + btoa("API_KEY:" + icu.apiKey) }, body: form,
    });
    if (!res.ok) throw new Error("intervals.icu HTTP " + res.status);
    return true;
  }

  /** Bring one trip in. Returns true if it was new. */
  async function importTrip(trip, have) {
    const id = "rwgps-" + trip.id;
    if (have.has(id)) return false;
    const data = await getJson("/api/v1/trips/" + trip.id + ".json");
    const full = data.trip || data;
    const samples = toSamples(full.track_points || []);
    if (samples.length < 60) return false;
    const ftp = app.settings.ftp;
    const stats = W.rideStats(samples, ftp);
    const name = full.name || trip.name || "Salida";
    const fname = fileName(samples[0].ts, name);
    const bytes = F.buildActivityFit(samples, [], Object.assign({ ftp, outdoor: true }, stats));
    const hasPower = samples.some((s) => s.power > 0);
    let load = stats.tss;
    if (!hasPower) {
      stats.np = 0; stats.tss = 0; stats.if = 0;
      load = Math.round(window.RodilloAnalysis.trimp(samples.map((s) => s.hr), app.settings.hrRest, app.settings.hrMax) * 0.56 * 10) / 10;
    }
    let dropboxPath = null;
    if (D.isConnected()) dropboxPath = await D.uploadOrQueue(fname, bytes);
    await H.saveRide({ id, source: "rwgps", name, sport: "Bici", ftp, stats, load, fileName: fname, dropboxPath, samples });
    try { await uploadToIntervals(bytes, name, fname); } catch (e) { app.toast("Salida guardada; intervals.icu no la aceptó (" + (e.message || e) + ").", "warn"); }
    return true;
  }

  async function sync(opts) {
    const auto = opts && opts.auto;
    const c = cfg();
    if (!c.apiKey || !c.authToken) { if (!auto) app.toast("Conecta primero Ride with GPS en Ajustes.", "warn"); return; }
    if (running) return;
    running = true;
    setStatus("Buscando salidas nuevas…");
    try {
      const trips = await recentTrips(c.since || 0);
      const have = new Set((await H.listSummaries()).map((s) => s.id));
      let n = 0;
      for (const t of trips) {
        setStatus("Bajando " + (t.name || "salida") + "…");
        if (await importTrip(t, have)) n++;
      }
      c.lastSync = Date.now(); saveCfg(c);
      renderStatus();
      if (n) {
        app.toast(n === 1 ? "1 salida del Bryton importada (Dropbox e intervals.icu)." : n + " salidas del Bryton importadas.");
        const view = document.body.dataset.view;
        if (["activities", "form", "power", "food"].includes(view)) window.RodilloViews.showTab(view);
      }
    } catch (e) {
      setStatus(e instanceof TypeError
        ? "No se pudo conectar: Ride with GPS no acepta llamadas directas desde esta página (o no hay red)."
        : "No se pudo sincronizar: " + (e.message || e));
    } finally { running = false; }
  }

  function renderStatus() {
    const c = cfg();
    setStatus(!c.authToken ? "Sin conectar. Crea una API key en Ride with GPS (Ajustes → Developers) y conecta aquí."
      : c.lastSync ? "Conectado. Última búsqueda: " + new Date(c.lastSync).toLocaleString("es") : "Conectado, todavía sin buscar salidas.");
    const connected = !!c.authToken;
    $("#rw-fields").hidden = connected;
    $("#rw-connect").hidden = connected;
    $("#rw-sync").hidden = !connected;
    $("#rw-disconnect").hidden = !connected;
    $("#rw-key").value = c.apiKey || "";
  }

  function autoSync() {
    const c = cfg();
    if (!c.authToken || document.visibilityState !== "visible" || document.body.dataset.view === "ride") return;
    if (c.lastSync && Date.now() - c.lastSync < 5 * 60 * 1000) return;
    sync({ auto: true });
  }

  function init(helpers) {
    app = helpers;
    $("#btn-settings").addEventListener("click", renderStatus);
    $("#rw-connect").addEventListener("click", async () => {
      const key = $("#rw-key").value.trim(), email = $("#rw-email").value.trim(), pw = $("#rw-password").value;
      if (!key || !email || !pw) { app.toast("Hacen falta la API key, el email y la contraseña de Ride with GPS.", "warn"); return; }
      setStatus("Conectando…");
      try {
        await connect(key, email, pw);
        $("#rw-password").value = "";
        renderStatus();
        app.toast("Ride with GPS conectado.");
        sync();
      } catch (e) {
        setStatus(e instanceof TypeError ? "No se pudo conectar: Ride with GPS no acepta llamadas directas desde esta página (o no hay red)." : "No se pudo conectar: " + (e.message || e));
      }
    });
    $("#rw-sync").addEventListener("click", () => sync());
    $("#rw-disconnect").addEventListener("click", () => { const c = cfg(); saveCfg({ apiKey: c.apiKey, since: c.since }); renderStatus(); });
    setTimeout(autoSync, 4000);
    setInterval(autoSync, 30 * 60 * 1000);
    document.addEventListener("visibilitychange", autoSync);
  }

  window.RodilloRwgps = { init, sync, toSamples };
})();
