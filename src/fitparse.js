/* Minimal FIT decoder: records (power, heart rate, cadence, speed, distance), laps and sport/session data. */
(function (root) {
  "use strict";

  const FIT_EPOCH_OFFSET = 631065600;

  // Base type number (low 5 bits) -> [size, reader name, invalid value]
  const BASE = {
    0x00: [1, "u8", 0xff], 0x01: [1, "s8", 0x7f], 0x02: [1, "u8", 0xff],
    0x03: [2, "s16", 0x7fff], 0x04: [2, "u16", 0xffff], 0x05: [4, "s32", 0x7fffffff], 0x06: [4, "u32", 0xffffffff],
    0x07: [1, "str", null], 0x08: [4, "f32", null], 0x09: [8, "f64", null],
    0x0a: [1, "u8", 0x00], 0x0b: [2, "u16", 0x0000], 0x0c: [4, "u32", 0x00000000], 0x0d: [1, "u8", null],
    0x0e: [8, "u64", null], 0x0f: [8, "u64", null], 0x10: [8, "u64", null],
  };

  function readValue(dv, offset, baseType, size, little) {
    const info = BASE[baseType & 0x1f];
    if (!info) return null;
    const [unit, kind, invalid] = info;
    if (size !== unit || kind === "str" || kind === "u64" || kind === "f64") return null; // arrays and strings are skipped
    let v;
    switch (kind) {
      case "u8": v = dv.getUint8(offset); break;
      case "s8": v = dv.getInt8(offset); break;
      case "u16": v = dv.getUint16(offset, little); break;
      case "s16": v = dv.getInt16(offset, little); break;
      case "u32": v = dv.getUint32(offset, little); break;
      case "s32": v = dv.getInt32(offset, little); break;
      case "f32": v = dv.getFloat32(offset, little); break;
      default: return null;
    }
    return v === invalid ? null : v;
  }

  /** Decode the messages we use. Returns {sport, subSport, records:[...], laps:[...], session}. */
  function parse(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = dv.getUint8(0);
    if (bytes.length < 12 || String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) !== ".FIT") {
      throw new Error("No es un archivo FIT");
    }
    const dataEnd = Math.min(bytes.length, headerSize + dv.getUint32(4, true));
    const defs = {};
    const out = { sport: null, subSport: null, records: [], laps: [], session: null };
    let lastTimestamp = 0;
    let p = headerSize;

    while (p < dataEnd) {
      const header = dv.getUint8(p++);
      let local, compressedOffset = null;
      if (header & 0x80) {
        local = (header >> 5) & 0x03;
        compressedOffset = header & 0x1f;
      } else {
        local = header & 0x0f;
        if (header & 0x40) {
          // Definition message
          const hasDev = (header & 0x20) !== 0;
          const little = dv.getUint8(p + 1) === 0;
          const globalNum = dv.getUint16(p + 2, little);
          const numFields = dv.getUint8(p + 4);
          p += 5;
          const fields = [];
          for (let i = 0; i < numFields; i++) {
            fields.push({ num: dv.getUint8(p), size: dv.getUint8(p + 1), type: dv.getUint8(p + 2) });
            p += 3;
          }
          let devSize = 0;
          if (hasDev) {
            const numDev = dv.getUint8(p++);
            for (let i = 0; i < numDev; i++) { devSize += dv.getUint8(p + 1); p += 3; }
          }
          defs[local] = { globalNum, little, fields, devSize };
          continue;
        }
      }

      const def = defs[local];
      if (!def) throw new Error("FIT dañado: mensaje sin definición");
      const values = {};
      for (const f of def.fields) {
        values[f.num] = readValue(dv, p, f.type, f.size, def.little);
        p += f.size;
      }
      p += def.devSize;

      if (values[253] != null) lastTimestamp = values[253];
      else if (compressedOffset != null) {
        let ts = (lastTimestamp & ~0x1f) + compressedOffset;
        if (compressedOffset < (lastTimestamp & 0x1f)) ts += 0x20;
        lastTimestamp = ts;
        values[253] = ts;
      }
      const unixTs = values[253] != null ? values[253] + FIT_EPOCH_OFFSET : null;

      switch (def.globalNum) {
        case 20: { // record
          const speed = values[73] != null ? values[73] / 1000 : values[6] != null ? values[6] / 1000 : null;
          out.records.push({
            ts: unixTs, power: values[7], hr: values[3], cadence: values[4], speed,
            distance: values[5] != null ? values[5] / 100 : null,
          });
          break;
        }
        case 19: // lap
          out.laps.push({ start: values[2] != null ? values[2] + FIT_EPOCH_OFFSET : null, end: unixTs });
          break;
        case 12: // sport
          if (out.sport == null) { out.sport = values[0]; out.subSport = values[1]; }
          break;
        case 18: // session
          out.session = {
            start: values[2] != null ? values[2] + FIT_EPOCH_OFFSET : null, sport: values[5], subSport: values[6],
            timerSeconds: values[8] != null ? values[8] / 1000 : null, avgHr: values[16], tss: values[35] != null ? values[35] / 10 : null,
          };
          if (out.sport == null) { out.sport = values[5]; out.subSport = values[6]; }
          break;
        default: break;
      }
    }
    return out;
  }

  /** Resample FIT records to 1 Hz app samples (one per timer second), assigning laps by time. */
  function toSamples(fit) {
    const recs = fit.records.filter((r) => r.ts != null).sort((a, b) => a.ts - b.ts);
    const samples = [];
    const lapStarts = fit.laps.map((l) => l.start).filter((x) => x != null).sort((a, b) => a - b);
    let lapIdx = 0;
    for (let i = 0; i < recs.length; i++) {
      const r = recs[i];
      const next = recs[i + 1];
      // Fill short recording gaps (smart recording) by holding values; longer gaps are pauses
      const span = next && next.ts - r.ts <= 5 ? next.ts - r.ts : 1;
      for (let k = 0; k < span; k++) {
        const ts = r.ts + k;
        while (lapIdx + 1 < lapStarts.length && ts >= lapStarts[lapIdx + 1]) lapIdx++;
        if (samples.length && ts <= samples[samples.length - 1].ts) continue;
        samples.push({
          ts, power: r.power, hr: r.hr, cadence: r.cadence, speed: r.speed,
          distance: r.distance, lap: lapIdx,
        });
      }
    }
    return samples;
  }

  root.RodilloFitParse = { parse, toSamples };
})(typeof window !== "undefined" ? window : globalThis);
