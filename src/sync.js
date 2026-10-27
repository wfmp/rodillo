/*
 * Sync between devices through Dropbox.
 * Every piece of user data is a record "<domain>/<id>" with a modification time. Each device keeps a snapshot of
 * what it last synced, so it can tell local edits and deletions apart; records are merged with "newest wins" and
 * deletions are kept as tombstones. Ride data (second by second) goes to one gzip file per ride.
 */
(function () {
  "use strict";

  const D = window.RodilloDropbox;
  const H = window.RodilloHistory;
  const DOC = "datos/sync.json";
  const SNAP_KEY = "rodillo.sync";
  const SETTINGS_KEYS = ["ftp", "weight", "height", "birthDate", "hrMax", "hrRest", "autoPause", "sounds"];
  // localStorage keys whose changes should trigger a sync
  const WATCHED = ["rodillo.medidas", "rodillo.foods", "rodillo.foodlog", "rodillo.imported", "rodillo.settings", "rodillo.intervals"];
  let app = null;
  let running = null, again = false, applying = false, timer = null;

  const $ = (s) => document.querySelector(s);
  const readJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; } };
  const writeJson = (key, value) => localStorage.setItem(key, JSON.stringify(value));
  const norm = (s) => String(s || "").trim().toLowerCase();

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + ":" + str.length;
  }

  const enabled = () => D.isConnected() && readJson(SNAP_KEY, {}).enabled !== false;

  // ---------- Local records ----------
  async function collectLocal() {
    const out = new Map();
    for (const m of readJson("rodillo.medidas", [])) out.set("m/" + m.id, m);
    for (const f of readJson("rodillo.foods", [])) out.set("f/" + norm(f.name), f);
    const log = readJson("rodillo.foodlog", {});
    for (const day of Object.keys(log)) out.set("d/" + day, log[day]);
    for (const w of readJson("rodillo.imported", [])) out.set("w/" + w.id, w);
    // One record per setting, so changing the FTP on one device does not undo the height set on another
    const s = readJson("rodillo.settings", {});
    for (const k of SETTINGS_KEYS) if (s[k] != null) out.set("s/" + k, s[k]);
    const icu = readJson("rodillo.intervals", {});
    if (icu.apiKey) out.set("i/main", { apiKey: icu.apiKey, athleteId: icu.athleteId || "" });
    for (const r of await H.listSummaries()) out.set("r/" + r.id, r);
    return out;
  }

  /** Write merged records back into local storage. Only domains that changed are rewritten. */
  async function applyLocal(merged, local) {
    const changed = new Set();
    for (const [key, rec] of merged) {
      const cur = local.get(key);
      const same = rec.d == null ? cur == null : cur != null && JSON.stringify(cur) === JSON.stringify(rec.d);
      if (!same) changed.add(key.split("/")[0]);
    }
    if (!changed.size) return changed;
    const pick = (prefix) => [...merged].filter(([k, r]) => k.startsWith(prefix + "/") && r.d != null).map(([, r]) => r.d);
    applying = true;
    try {
      if (changed.has("m")) writeJson("rodillo.medidas", pick("m").sort((a, b) => a.date < b.date ? -1 : 1));
      if (changed.has("f")) writeJson("rodillo.foods", pick("f").sort((a, b) => norm(a.name).localeCompare(norm(b.name), "es")));
      if (changed.has("d")) {
        const log = {};
        for (const [k, r] of merged) if (k.startsWith("d/") && r.d != null) log[k.slice(2)] = r.d;
        writeJson("rodillo.foodlog", log);
      }
      if (changed.has("w")) writeJson("rodillo.imported", pick("w"));
      if (changed.has("s")) {
        for (const k of SETTINGS_KEYS) { const r = merged.get("s/" + k); if (r && r.d != null) app.settings[k] = r.d; }
        writeJson("rodillo.settings", app.settings);
      }
      if (changed.has("i")) {
        const i = merged.get("i/main");
        const cur = readJson("rodillo.intervals", {});
        writeJson("rodillo.intervals", i && i.d ? Object.assign(cur, i.d) : {});
      }
      if (changed.has("r")) {
        for (const [key, rec] of merged) {
          if (!key.startsWith("r/")) continue;
          const id = key.slice(2);
          if (rec.d == null && local.has(key)) await H.deleteRide(id);
          else if (rec.d != null && !local.has(key)) {
            const body = await downloadRide(id);
            if (body) await H.saveRide(body);
          } else if (rec.d != null && local.has(key) && JSON.stringify(local.get(key)) !== JSON.stringify(rec.d)) {
            await H.updateSummary(id, { dropboxPath: rec.d.dropboxPath || null, name: rec.d.name });
          }
        }
      }
    } finally { applying = false; }
    return changed;
  }

  // ---------- Ride bodies ----------
  async function gzip(text) {
    const bytes = new TextEncoder().encode(text);
    if (typeof CompressionStream === "undefined") return { bytes, ext: ".json" };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), ext: ".json.gz" };
  }
  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new TextDecoder().decode(await new Response(stream).arrayBuffer());
  }

  async function uploadRide(id) {
    const ride = await H.getRide(id);
    if (!ride) return;
    delete ride.samples; // the column arrays already hold the data
    const z = await gzip(JSON.stringify(ride));
    await D.upload("datos/rides/" + id + z.ext, z.bytes, { overwrite: true });
  }

  async function downloadRide(id) {
    const gz = await D.download("datos/rides/" + id + ".json.gz");
    if (gz) return JSON.parse(await gunzip(gz.bytes));
    const plain = await D.download("datos/rides/" + id + ".json");
    return plain ? JSON.parse(new TextDecoder().decode(plain.bytes)) : null;
  }

  // ---------- Sync ----------
  async function syncOnce() {
    const snap = readJson(SNAP_KEY, {});
    const prev = snap.keys || {};
    const now = Date.now();
    const local = await collectLocal();

    // Local view as records: unchanged keys keep their time, edits get "now", disappeared keys become tombstones
    // On a device's first sync its local values are oldest, so Dropbox wins any conflict
    const first = !snap.last;
    const mine = new Map();
    for (const [key, data] of local) {
      const h = hash(JSON.stringify(data));
      mine.set(key, { t: first ? 0 : prev[key] && prev[key].h === h ? prev[key].t : now, d: data, h });
    }
    // A domain that is suddenly empty here (but had several records) means lost browser storage, not deletions
    const count = (src, dom) => [...src].filter((k) => k.startsWith(dom + "/")).length;
    const lost = new Set(["m", "f", "d", "r"].filter((dom) =>
      count(local.keys(), dom) === 0 && Object.entries(prev).filter(([k, p]) => k.startsWith(dom + "/") && p.h !== "-").length >= 3));
    for (const [key, p] of Object.entries(prev)) {
      if (local.has(key)) continue;
      if (lost.has(key.split("/")[0]) && p.h !== "-") continue; // let the remote copy restore it
      mine.set(key, { t: p.h === "-" ? p.t : now, d: null, h: "-" });
    }

    const remoteFile = await D.download(DOC);
    const remote = remoteFile ? JSON.parse(new TextDecoder().decode(remoteFile.bytes)) : { records: {} };

    // Newest wins; on a tie the remote copy is kept
    const merged = new Map();
    const keys = new Set([...mine.keys(), ...Object.keys(remote.records || {})]);
    for (const key of keys) {
      const a = mine.get(key), b = remote.records[key];
      merged.set(key, !b || (a && a.t > b.t) ? { t: a.t, d: a.d } : { t: b.t, d: b.d });
    }

    // Ride bodies: upload the ones this device has and Dropbox does not
    for (const [key, rec] of merged) {
      if (!key.startsWith("r/") || rec.d == null || !local.has(key)) continue;
      const known = remote.records && remote.records[key] && remote.records[key].d != null;
      if (!known) await uploadRide(key.slice(2));
    }

    const changed = await applyLocal(merged, local);

    // Upload the merged document, guarded by the revision we read
    const doc = { version: 1, updated: now, records: Object.fromEntries(merged) };
    const bytes = new TextEncoder().encode(JSON.stringify(doc));
    await D.upload(DOC, bytes, remoteFile && remoteFile.rev ? { rev: remoteFile.rev } : { overwrite: true });

    const keysOut = {};
    for (const [key, rec] of merged) keysOut[key] = { t: rec.t, h: rec.d == null ? "-" : hash(JSON.stringify(rec.d)) };
    writeJson(SNAP_KEY, Object.assign(snap, { keys: keysOut, last: now }));
    return changed;
  }

  async function sync(reason) {
    if (!enabled()) { renderStatus(); return; }
    if (running) { again = true; return running; }
    renderStatus("Sincronizando…");
    running = (async () => {
      let changed = new Set();
      for (let attempt = 0; attempt < 3; attempt++) {
        try { changed = await syncOnce(); break; } catch (e) {
          if (e.conflict && attempt < 2) continue; // another device wrote in between: merge again
          renderStatus("No se pudo sincronizar: " + (e.message || e));
          return;
        }
      }
      renderStatus();
      if (changed.size && document.body.dataset.view !== "ride" && document.body.dataset.view !== "summary") {
        const tab = document.body.dataset.view;
        if (["library", "activities", "form", "power", "measures", "food"].includes(tab)) window.RodilloViews.showTab(tab);
        if (reason !== "start") app.toast("Datos actualizados desde otro dispositivo.");
      }
    })().finally(() => {
      running = null;
      if (again) { again = false; schedule(1000); }
    });
    return running;
  }

  function schedule(ms) {
    if (applying || !enabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => sync("change"), ms == null ? 4000 : ms);
  }

  function renderStatus(text) {
    const el = $("#sync-status");
    if (!el) return;
    if (text) { el.textContent = text; return; }
    const snap = readJson(SNAP_KEY, {});
    el.textContent = !D.isConnected() ? "Conecta Dropbox para sincronizar entre dispositivos."
      : snap.enabled === false ? "Sincronización desactivada en este dispositivo."
      : snap.last ? "Última sincronización: " + new Date(snap.last).toLocaleString("es") : "Todavía sin sincronizar.";
    $("#sync-enabled").checked = snap.enabled !== false;
  }

  // ---------- Wire up ----------
  function init(helpers) {
    app = helpers;
    // Any change to synced data in localStorage schedules a sync
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      setItem.call(this, key, value);
      if (this === window.localStorage && WATCHED.includes(key)) schedule();
    };
    for (const name of ["saveRide", "deleteRide", "updateSummary"]) {
      const fn = H[name];
      H[name] = function () { const r = fn.apply(H, arguments); Promise.resolve(r).then(() => schedule(), () => {}); return r; };
    }
    $("#sync-now").addEventListener("click", () => sync("manual"));
    $("#sync-enabled").addEventListener("change", (e) => {
      const snap = readJson(SNAP_KEY, {});
      snap.enabled = e.target.checked;
      writeJson(SNAP_KEY, snap);
      renderStatus();
      if (e.target.checked) sync("manual");
    });
    $("#btn-settings").addEventListener("click", () => renderStatus());
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") sync("resume"); });
    setTimeout(() => sync("start"), 1500);
  }

  window.RodilloSync = { init, sync };
})();
