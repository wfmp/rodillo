/*
 * Send watch activities to GoldenCheetah through Dropbox: download the original FIT from intervals.icu,
 * set the corrected sport, drop speed/distance/altitude (the watch's GPS-less estimates break GC's
 * "time moving" and TRIMP), fix the CRC and upload it next to the trainer rides.
 */
(function () {
  "use strict";

  const D = window.RodilloDropbox;
  const DONE_KEY = "rodillo.gcexported";
  const SINCE_KEY = "rodillo.gcsince";

  // intervals.icu type -> FIT sport / sub_sport
  const FIT_SPORT = {
    Badminton: [64, 95], Soccer: [7, 0], Tennis: [8, 0], Swim: [5, 17], Run: [1, 0],
    WeightTraining: [10, 20], Walk: [11, 0], Hike: [17, 0], Other: [0, 0],
  };
  // Record fields cleared: altitude, distance, speed, enhanced speed, enhanced altitude
  const CLEAR_RECORD_FIELDS = new Set([2, 5, 6, 73, 78]);

  const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];
  function fitCrc(bytes, end) {
    let crc = 0;
    for (let i = 0; i < end; i++) {
      const b = bytes[i];
      let tmp = CRC_TABLE[crc & 0xf]; crc = (crc >> 4) & 0x0fff; crc = crc ^ tmp ^ CRC_TABLE[b & 0xf];
      tmp = CRC_TABLE[crc & 0xf]; crc = (crc >> 4) & 0x0fff; crc = crc ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
    }
    return crc;
  }

  const INVALID = { 1: 0xff, 2: 0xffff, 4: 0xffffffff };

  /** Patch a FIT file in place: sport/sub_sport in sport, session and lap messages; clear speed-type record fields. */
  function patchFit(src, sport, subSport) {
    const bytes = new Uint8Array(src);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = bytes[0];
    const dataEnd = headerSize + dv.getUint32(4, true);
    const defs = {};
    const setField = (offset, size, value) => {
      if (size === 1) bytes[offset] = value;
      else if (size === 2) dv.setUint16(offset, value, defs.little);
      else if (size === 4) dv.setUint32(offset, value, defs.little);
    };
    let p = headerSize;
    while (p < dataEnd) {
      const header = bytes[p++];
      let local;
      if (header & 0x80) local = (header >> 5) & 0x03;
      else {
        local = header & 0x0f;
        if (header & 0x40) {
          const little = bytes[p + 1] === 0;
          const globalNum = little ? dv.getUint16(p + 2, true) : dv.getUint16(p + 2, false);
          const n = bytes[p + 4];
          p += 5;
          const fields = [];
          for (let i = 0; i < n; i++) { fields.push({ num: bytes[p], size: bytes[p + 1] }); p += 3; }
          let devSize = 0;
          if (header & 0x20) { const nd = bytes[p++]; for (let i = 0; i < nd; i++) { devSize += bytes[p + 1]; p += 3; } }
          defs[local] = { globalNum, little, fields, devSize };
          continue;
        }
      }
      const def = defs[local];
      if (!def) throw new Error("FIT dañado");
      defs.little = def.little;
      let o = p;
      for (const f of def.fields) {
        const g = def.globalNum;
        if (f.size === 1 && ((g === 12 && f.num === 0) || (g === 18 && f.num === 5) || (g === 19 && f.num === 25))) bytes[o] = sport;
        if (f.size === 1 && ((g === 12 && f.num === 1) || (g === 18 && f.num === 6) || (g === 19 && f.num === 39))) bytes[o] = subSport;
        if (g === 20 && CLEAR_RECORD_FIELDS.has(f.num) && INVALID[f.size] != null) setField(o, f.size, INVALID[f.size]);
        o += f.size;
      }
      p = o + def.devSize;
    }
    const crc = fitCrc(bytes, dataEnd);
    bytes[dataEnd] = crc & 0xff; bytes[dataEnd + 1] = crc >> 8;
    return bytes;
  }

  async function maybeGunzip(bytes) {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const loadDone = () => { try { return JSON.parse(localStorage.getItem(DONE_KEY) || "{}"); } catch (e) { return {}; } };
  function markDone(id, path) {
    const done = loadDone();
    done[id] = path;
    try { localStorage.setItem(DONE_KEY, JSON.stringify(done)); } catch (e) { /* ignore */ }
  }

  /** Only activities from the last days before this feature started, plus everything after, are sent. */
  function since() {
    let s = null;
    try { s = +localStorage.getItem(SINCE_KEY); } catch (e) { s = null; }
    if (!s) { s = Math.floor(Date.now() / 1000) - 3 * 86400; try { localStorage.setItem(SINCE_KEY, String(s)); } catch (e) { /* ignore */ } }
    return s;
  }

  function fileName(x, type) {
    const d = new Date(x.start * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes()) + "_" + type + ".fit";
  }

  /** Export one activity (x from intervals.icu, type = intervals.icu sport). Returns the Dropbox path or null. */
  async function exportActivity(x, type, apiKey, force) {
    if (!D.isConnected() || !FIT_SPORT[type] || !x.icuId) return null;
    const done = loadDone();
    if (done[x.id] && done[x.id].endsWith("_" + type + ".fit") && !force) return done[x.id];
    const res = await fetch("https://intervals.icu/api/v1/activity/" + encodeURIComponent(x.icuId) + "/file", {
      headers: { Authorization: "Basic " + btoa("API_KEY:" + apiKey) },
    });
    if (!res.ok) throw new Error("intervals.icu HTTP " + res.status);
    const raw = await maybeGunzip(new Uint8Array(await res.arrayBuffer()));
    if (String.fromCharCode(raw[8], raw[9], raw[10], raw[11]) !== ".FIT") throw new Error("el archivo original no es FIT");
    const [sport, sub] = FIT_SPORT[type];
    const patched = patchFit(raw, sport, sub);
    // A previous export with another sport is replaced
    if (done[x.id] && done[x.id] !== "/" + fileName(x, type)) D.removeFile(done[x.id]).catch(() => {});
    const path = await D.upload(fileName(x, type), patched, { overwrite: true });
    markDone(x.id, path);
    return path;
  }

  /** Export every classified, non-bike watch activity since the start date that is not in Dropbox yet. */
  async function exportPending(list, typeOf, apiKey) {
    if (!D.isConnected()) return 0;
    const from = since(), done = loadDone();
    let n = 0;
    for (const x of list) {
      const type = typeOf(x);
      if (x.start < from || x.hasPower || !FIT_SPORT[type] || type === "Other") continue;
      if (done[x.id] && done[x.id].endsWith("_" + type + ".fit")) continue;
      try { if (await exportActivity(x, type, apiKey)) n++; } catch (e) { /* retried on the next sync */ }
    }
    return n;
  }

  window.RodilloGcExport = { patchFit, exportActivity, exportPending, FIT_SPORT };
})();
