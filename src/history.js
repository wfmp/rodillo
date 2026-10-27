/* Ride history in IndexedDB: compact ride data plus a lightweight summary per ride for lists and charts. */
(function (root) {
  "use strict";

  const A = root.RodilloAnalysis;
  const DB_NAME = "rodillo";
  const DB_VERSION = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error("Este navegador no permite guardar el historial")); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("rides")) db.createObjectStore("rides", { keyPath: "id" });
        if (!db.objectStoreNames.contains("summaries")) db.createObjectStore("summaries", { keyPath: "id" }).createIndex("start", "start");
        if (!db.objectStoreNames.contains("external")) db.createObjectStore("external", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(stores, mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(stores, mode);
      let result;
      Promise.resolve(fn(t)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Transacción cancelada"));
    }));
  }
  const reqP = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

  /** Convert app samples ([{ts, power, hr, ...}]) to column arrays, which store far more compactly. */
  function toColumns(samples) {
    const cols = { ts: [], power: [], hr: [], cadence: [], speed: [], distance: [], lap: [], target: [] };
    for (const s of samples) {
      cols.ts.push(s.ts);
      cols.power.push(s.power == null ? null : s.power);
      cols.hr.push(s.hr || null);
      cols.cadence.push(s.cadence == null ? null : s.cadence);
      cols.speed.push(s.speed == null ? null : Math.round(s.speed * 100) / 100);
      cols.distance.push(s.distance == null ? null : Math.round(s.distance * 10) / 10);
      cols.lap.push(s.lap == null ? 0 : s.lap);
      cols.target.push(s.target == null ? null : s.target);
    }
    return cols;
  }

  function toSamples(cols) {
    return cols.ts.map((ts, i) => ({
      ts, power: cols.power[i], hr: cols.hr[i], cadence: cols.cadence[i], speed: cols.speed[i],
      distance: cols.distance[i], lap: cols.lap[i], target: cols.target ? cols.target[i] : null,
    }));
  }

  /** Summary used by lists and charts: no per-second data. */
  function summarize(ride) {
    const c = ride.columns;
    const power = c.power.map((p) => p || 0);
    const hasPower = c.power.some((p) => p > 0);
    const z = hasPower ? A.zoneSeconds(power, ride.ftp) : null;
    return {
      id: ride.id, source: ride.source, name: ride.name, sport: ride.sport || "cycling",
      start: c.ts[0], end: c.ts[c.ts.length - 1], timerSeconds: c.ts.length,
      ftp: ride.ftp, stats: ride.stats, fileName: ride.fileName, dropboxPath: ride.dropboxPath || null,
      workoutId: ride.workoutId || null,
      curve: hasPower ? A.powerCurve(power) : null,
      zones: z ? z.zones : null, aboveFtp: z ? z.aboveFtp : 0,
      load: ride.load != null ? ride.load : ride.stats && ride.stats.tss ? ride.stats.tss : 0,
    };
  }

  /** Save a ride: {id, source, name, ftp, stats, fileName, workoutId, samples} */
  function saveRide(ride) {
    const full = Object.assign({}, ride, { columns: ride.columns || toColumns(ride.samples) });
    delete full.samples;
    const summary = summarize(full);
    return tx(["rides", "summaries"], "readwrite", (t) => {
      t.objectStore("rides").put(full);
      t.objectStore("summaries").put(summary);
      return summary;
    });
  }

  function updateSummary(id, patch) {
    return tx(["rides", "summaries"], "readwrite", async (t) => {
      const s = await reqP(t.objectStore("summaries").get(id));
      const r = await reqP(t.objectStore("rides").get(id));
      if (s) t.objectStore("summaries").put(Object.assign(s, patch));
      if (r) t.objectStore("rides").put(Object.assign(r, patch));
    });
  }

  function getRide(id) {
    return tx(["rides"], "readonly", (t) => reqP(t.objectStore("rides").get(id))).then((r) => {
      if (r) r.samples = toSamples(r.columns);
      return r;
    });
  }

  function listSummaries() {
    return tx(["summaries"], "readonly", (t) => reqP(t.objectStore("summaries").getAll()))
      .then((all) => all.sort((a, b) => b.start - a.start));
  }

  function deleteRide(id) {
    return tx(["rides", "summaries"], "readwrite", (t) => {
      t.objectStore("rides").delete(id);
      t.objectStore("summaries").delete(id);
    });
  }

  /** External activities (intervals.icu): replace the cached set. */
  function saveExternal(list) {
    return tx(["external"], "readwrite", (t) => {
      const store = t.objectStore("external");
      store.clear();
      for (const a of list) store.put(a);
    });
  }
  function listExternal() {
    return tx(["external"], "readonly", (t) => reqP(t.objectStore("external").getAll()));
  }

  root.RodilloHistory = { saveRide, updateSummary, getRide, listSummaries, deleteRide, saveExternal, listExternal, toColumns, toSamples };
})(typeof window !== "undefined" ? window : globalThis);
