/* FIT file encoder for indoor cycling activities (power, heart rate, cadence, speed). */
(function (root) {
  "use strict";

  const FIT_EPOCH_OFFSET = 631065600; // seconds between 1970-01-01 and 1989-12-31

  const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

  function fitCrc(bytes, start, end, crc) {
    crc = crc || 0;
    for (let i = start; i < end; i++) {
      const byte = bytes[i];
      let tmp = CRC_TABLE[crc & 0xf];
      crc = (crc >> 4) & 0x0fff;
      crc = crc ^ tmp ^ CRC_TABLE[byte & 0xf];
      tmp = CRC_TABLE[crc & 0xf];
      crc = (crc >> 4) & 0x0fff;
      crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xf];
    }
    return crc;
  }

  // Base types: [code, size, invalid value]
  const T = {
    enum: [0x00, 1, 0xff],
    uint8: [0x02, 1, 0xff],
    sint16: [0x83, 2, 0x7fff],
    uint16: [0x84, 2, 0xffff],
    uint32: [0x86, 4, 0xffffffff],
    uint32z: [0x8c, 4, 0],
  };

  // Message definitions: global number and ordered fields [name, fieldNum, type]
  const MESSAGES = {
    file_id: [0, [["type", 0, "enum"], ["manufacturer", 1, "uint16"], ["product", 2, "uint16"],
      ["serial_number", 3, "uint32z"], ["time_created", 4, "uint32"]]],
    sport: [12, [["sport", 0, "enum"], ["sub_sport", 1, "enum"]]],
    event: [21, [["timestamp", 253, "uint32"], ["event", 0, "enum"], ["event_type", 1, "enum"],
      ["event_group", 4, "uint8"]]],
    record: [20, [["timestamp", 253, "uint32"], ["heart_rate", 3, "uint8"], ["cadence", 4, "uint8"],
      ["distance", 5, "uint32"], ["speed", 6, "uint16"], ["power", 7, "uint16"]]],
    lap: [19, [["timestamp", 253, "uint32"], ["event", 0, "enum"], ["event_type", 1, "enum"],
      ["start_time", 2, "uint32"], ["total_elapsed_time", 7, "uint32"], ["total_timer_time", 8, "uint32"],
      ["total_distance", 9, "uint32"], ["avg_heart_rate", 15, "uint8"], ["max_heart_rate", 16, "uint8"],
      ["avg_cadence", 17, "uint8"], ["avg_power", 19, "uint16"], ["max_power", 20, "uint16"],
      ["sport", 25, "enum"], ["sub_sport", 39, "enum"]]],
    session: [18, [["timestamp", 253, "uint32"], ["event", 0, "enum"], ["event_type", 1, "enum"],
      ["start_time", 2, "uint32"], ["sport", 5, "enum"], ["sub_sport", 6, "enum"],
      ["total_elapsed_time", 7, "uint32"], ["total_timer_time", 8, "uint32"], ["total_distance", 9, "uint32"],
      ["avg_heart_rate", 16, "uint8"], ["max_heart_rate", 17, "uint8"], ["avg_cadence", 18, "uint8"],
      ["avg_power", 20, "uint16"], ["max_power", 21, "uint16"], ["first_lap_index", 25, "uint16"],
      ["num_laps", 26, "uint16"], ["normalized_power", 34, "uint16"], ["training_stress_score", 35, "uint16"],
      ["intensity_factor", 36, "uint16"], ["threshold_power", 45, "uint16"], ["total_work", 48, "uint32"]]],
    activity: [34, [["timestamp", 253, "uint32"], ["total_timer_time", 0, "uint32"], ["num_sessions", 1, "uint16"],
      ["type", 2, "enum"], ["event", 3, "enum"], ["event_type", 4, "enum"], ["local_timestamp", 5, "uint32"]]],
  };

  class ByteWriter {
    constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
    ensure(n) {
      if (this.len + n <= this.buf.length) return;
      let size = this.buf.length * 2;
      while (size < this.len + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    u8(v) { this.ensure(1); this.buf[this.len++] = v & 0xff; }
    u16(v) { this.u8(v); this.u8(v >>> 8); }
    u32(v) { this.u16(v & 0xffff); this.u16((v >>> 16) & 0xffff); }
    value(typeName, v) {
      const [, size, invalid] = T[typeName];
      const val = (v === undefined || v === null || Number.isNaN(v)) ? invalid : Math.round(v);
      if (size === 1) this.u8(val);
      else if (size === 2) this.u16(val & 0xffff);
      else this.u32(val >>> 0);
    }
  }

  class FitEncoder {
    constructor() {
      this.w = new ByteWriter();
      this.w.len = 14; // header written at the end
      this.localByName = {};
      this.nextLocal = 0;
    }
    define(name) {
      if (name in this.localByName) return this.localByName[name];
      const local = this.nextLocal++;
      const [globalNum, fields] = MESSAGES[name];
      const w = this.w;
      w.u8(0x40 | local);
      w.u8(0); // reserved
      w.u8(0); // little endian
      w.u16(globalNum);
      w.u8(fields.length);
      for (const [, num, type] of fields) {
        w.u8(num); w.u8(T[type][1]); w.u8(T[type][0]);
      }
      this.localByName[name] = local;
      return local;
    }
    write(name, values) {
      const local = this.define(name);
      const w = this.w;
      w.u8(local);
      for (const [field, , type] of MESSAGES[name][1]) w.value(type, values[field]);
    }
    finish() {
      const w = this.w;
      const dataSize = w.len - 14;
      const b = w.buf;
      b[0] = 14; b[1] = 0x20;
      b[2] = 2132 & 0xff; b[3] = 2132 >> 8; // profile version 21.32
      b[4] = dataSize & 0xff; b[5] = (dataSize >>> 8) & 0xff; b[6] = (dataSize >>> 16) & 0xff; b[7] = (dataSize >>> 24) & 0xff;
      b[8] = 0x2e; b[9] = 0x46; b[10] = 0x49; b[11] = 0x54; // ".FIT"
      const hcrc = fitCrc(b, 0, 12);
      b[12] = hcrc & 0xff; b[13] = hcrc >> 8;
      const crc = fitCrc(b, 0, w.len);
      w.u16(crc);
      return w.buf.slice(0, w.len);
    }
  }

  const toFitTime = (unixSeconds) => Math.round(unixSeconds) - FIT_EPOCH_OFFSET;

  /**
   * Build a FIT activity from 1 Hz samples.
   * samples: [{ts (unix s), power, hr, cadence, speed (m/s), distance (m)}]
   * pauses: [{start (unix s), end (unix s)}]
   * summary: {avgPower, maxPower, avgHr, maxHr, avgCadence, np, tss, if, ftp, kj, timerSeconds, distance}
   */
  function buildActivityFit(samples, pauses, summary) {
    if (!samples.length) throw new Error("No samples recorded");
    const enc = new FitEncoder();
    const SPORT_CYCLING = 2, SUB_INDOOR = 6;
    const start = samples[0].ts;
    const end = samples[samples.length - 1].ts;
    enc.write("file_id", { type: 4, manufacturer: 255, product: 1, serial_number: 26102026, time_created: toFitTime(start) });
    enc.write("sport", { sport: SPORT_CYCLING, sub_sport: SUB_INDOOR });
    enc.write("event", { timestamp: toFitTime(start), event: 0, event_type: 0, event_group: 0 });

    const pauseQueue = (pauses || []).slice().sort((a, b) => a.start - b.start);
    let pi = 0;
    for (const s of samples) {
      while (pi < pauseQueue.length && pauseQueue[pi].start <= s.ts) {
        const p = pauseQueue[pi++];
        enc.write("event", { timestamp: toFitTime(p.start), event: 0, event_type: 4, event_group: 0 });
        if (p.end) enc.write("event", { timestamp: toFitTime(p.end), event: 0, event_type: 0, event_group: 0 });
      }
      enc.write("record", {
        timestamp: toFitTime(s.ts),
        heart_rate: s.hr || undefined,
        cadence: s.cadence == null ? undefined : s.cadence,
        distance: s.distance == null ? undefined : s.distance * 100,
        speed: s.speed == null ? undefined : s.speed * 1000,
        power: s.power == null ? undefined : Math.max(0, s.power),
      });
    }
    enc.write("event", { timestamp: toFitTime(end), event: 0, event_type: 4, event_group: 0 });

    const elapsedMs = (end - start + 1) * 1000;
    const timerMs = summary.timerSeconds * 1000;
    const common = {
      timestamp: toFitTime(end), start_time: toFitTime(start),
      total_elapsed_time: elapsedMs, total_timer_time: timerMs,
      total_distance: (summary.distance || 0) * 100,
      avg_heart_rate: summary.avgHr || undefined, max_heart_rate: summary.maxHr || undefined,
      avg_cadence: summary.avgCadence || undefined,
      avg_power: summary.avgPower, max_power: summary.maxPower,
    };
    enc.write("lap", Object.assign({ event: 9, event_type: 1, sport: SPORT_CYCLING, sub_sport: SUB_INDOOR }, common));
    enc.write("session", Object.assign({
      event: 8, event_type: 1, sport: SPORT_CYCLING, sub_sport: SUB_INDOOR,
      first_lap_index: 0, num_laps: 1,
      normalized_power: summary.np, training_stress_score: summary.tss * 10,
      intensity_factor: summary.if * 1000, threshold_power: summary.ftp, total_work: summary.kj * 1000,
    }, common));
    const tzOffset = -new Date(end * 1000).getTimezoneOffset() * 60;
    enc.write("activity", {
      timestamp: toFitTime(end), total_timer_time: timerMs, num_sessions: 1,
      type: 0, event: 26, event_type: 1, local_timestamp: toFitTime(end + tzOffset),
    });
    return enc.finish();
  }

  root.RodilloFit = { buildActivityFit, fitCrc };
})(typeof window !== "undefined" ? window : globalThis);
