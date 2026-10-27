/* Workout parsing (.mrc, .erg, .zwo), target lookup and ride statistics. */
(function (root) {
  "use strict";

  /**
   * A workout is {id, name, description, unit: 'pct'|'watts', segments: [[durationSec, startValue, endValue], ...]}.
   * 'pct' values are % of FTP; 'watts' values are absolute.
   */

  function pointsToSegments(points) {
    // points: [[minutes, value], ...] as in MRC/ERG course data
    const segments = [];
    for (let i = 1; i < points.length; i++) {
      const [t0, v0] = points[i - 1];
      const [t1, v1] = points[i];
      const dur = Math.round((t1 - t0) * 60);
      if (dur > 0) segments.push([dur, v0, v1]);
    }
    return segments;
  }

  function parseCourseFile(text, fallbackName) {
    const header = {};
    const headerMatch = text.match(/\[COURSE HEADER\]([\s\S]*?)\[END COURSE HEADER\]/i);
    if (headerMatch) {
      for (const line of headerMatch[1].split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z ]+?)\s*=\s*(.*)$/i);
        if (m) header[m[1].trim().toUpperCase()] = m[2].trim();
        if (/MINUTES\s+PERCENT/i.test(line)) header.UNITS_KIND = "pct";
        if (/MINUTES\s+WATTS/i.test(line)) header.UNITS_KIND = "watts";
      }
    }
    const dataMatch = text.match(/\[COURSE DATA\]([\s\S]*?)\[END COURSE DATA\]/i);
    if (!dataMatch) throw new Error("No [COURSE DATA] section found");
    const points = [];
    for (const line of dataMatch[1].split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && !isNaN(parseFloat(parts[0])) && !isNaN(parseFloat(parts[1]))) {
        points.push([parseFloat(parts[0]), parseFloat(parts[1])]);
      }
    }
    if (points.length < 2) throw new Error("The course data has fewer than two points");
    const name = header["FILE NAME"] || fallbackName;
    return {
      id: "import-" + name,
      name,
      description: header["DESCRIPTION"] || "",
      unit: header.UNITS_KIND || "pct",
      segments: pointsToSegments(points),
    };
  }

  function parseZwo(text, fallbackName) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("The .zwo file is not valid XML");
    const name = doc.querySelector("name")?.textContent?.trim() || fallbackName;
    const description = doc.querySelector("description")?.textContent?.trim() || "";
    const segments = [];
    const pct = (v) => Math.round(parseFloat(v) * 1000) / 10;
    const workoutEl = doc.querySelector("workout");
    if (!workoutEl) throw new Error("The .zwo file has no <workout> element");
    for (const el of workoutEl.children) {
      const tag = el.tagName;
      const dur = parseInt(el.getAttribute("Duration") || "0", 10);
      if (tag === "SteadyState" || tag === "FreeRide") {
        const p = pct(el.getAttribute("Power") || "0.5");
        segments.push([dur, p, p]);
      } else if (tag === "Warmup" || tag === "Cooldown" || tag === "Ramp") {
        segments.push([dur, pct(el.getAttribute("PowerLow")), pct(el.getAttribute("PowerHigh"))]);
      } else if (tag === "IntervalsT") {
        const reps = parseInt(el.getAttribute("Repeat") || "1", 10);
        const on = parseInt(el.getAttribute("OnDuration"), 10);
        const off = parseInt(el.getAttribute("OffDuration"), 10);
        const onP = pct(el.getAttribute("OnPower"));
        const offP = pct(el.getAttribute("OffPower"));
        for (let i = 0; i < reps; i++) { segments.push([on, onP, onP]); segments.push([off, offP, offP]); }
      }
    }
    if (!segments.length) throw new Error("No supported steps found in the .zwo file");
    return { id: "import-" + name, name, description, unit: "pct", segments };
  }

  function parseWorkoutFile(fileName, text) {
    const base = fileName.replace(/\.[^.]+$/, "");
    if (/\.zwo$/i.test(fileName)) return parseZwo(text, base);
    return parseCourseFile(text, base);
  }

  function totalDuration(workout) {
    return workout.segments.reduce((sum, s) => sum + s[0], 0);
  }

  /** Locate the segment at second t. Returns {index, segStart, segEnd, fraction} or null past the end. */
  function segmentAt(workout, t) {
    let acc = 0;
    for (let i = 0; i < workout.segments.length; i++) {
      const dur = workout.segments[i][0];
      if (t < acc + dur) return { index: i, segStart: acc, segEnd: acc + dur, fraction: (t - acc) / dur };
      acc += dur;
    }
    return null;
  }

  /** Target in watts at second t, given FTP and an intensity multiplier (1.0 = 100 %). */
  function targetWattsAt(workout, t, ftp, intensity) {
    const loc = segmentAt(workout, t);
    if (!loc) return null;
    const [, v0, v1] = workout.segments[loc.index];
    const value = v0 + (v1 - v0) * loc.fraction;
    const watts = workout.unit === "watts" ? value : value * ftp / 100;
    return Math.round(watts * intensity);
  }

  function segmentWatts(workout, seg, ftp) {
    const f = workout.unit === "watts" ? 1 : ftp / 100;
    return [seg[1] * f, seg[2] * f];
  }

  /** Ride statistics from 1 Hz samples with a 'power' field (timer time only). */
  function rideStats(samples, ftp) {
    const n = samples.length;
    const out = { timerSeconds: n, avgPower: 0, maxPower: 0, np: 0, if: 0, tss: 0, kj: 0,
      avgHr: 0, maxHr: 0, avgCadence: 0, distance: 0 };
    if (!n) return out;
    let pSum = 0, hrSum = 0, hrN = 0, cadSum = 0, cadN = 0;
    for (const s of samples) {
      const p = s.power || 0;
      pSum += p;
      if (p > out.maxPower) out.maxPower = p;
      if (s.hr) { hrSum += s.hr; hrN++; if (s.hr > out.maxHr) out.maxHr = s.hr; }
      if (s.cadence) { cadSum += s.cadence; cadN++; }
    }
    out.avgPower = Math.round(pSum / n);
    out.kj = Math.round(pSum / 1000);
    out.avgHr = hrN ? Math.round(hrSum / hrN) : 0;
    out.avgCadence = cadN ? Math.round(cadSum / cadN) : 0;
    out.distance = (samples[n - 1].distance || 0) + (samples[n - 1].speed || 0);
    // Normalized power: 30 s rolling mean, 4th power average, 4th root
    if (n >= 30) {
      let window = 0, acc4 = 0, count = 0;
      for (let i = 0; i < n; i++) {
        window += samples[i].power || 0;
        if (i >= 30) window -= samples[i - 30].power || 0;
        if (i >= 29) { acc4 += Math.pow(window / 30, 4); count++; }
      }
      out.np = Math.round(Math.pow(acc4 / count, 0.25));
    } else {
      out.np = out.avgPower;
    }
    out.if = ftp ? Math.round(out.np / ftp * 100) / 100 : 0;
    out.tss = ftp ? Math.round((n * out.np * (out.np / ftp)) / (ftp * 3600) * 100 * 10) / 10 : 0;
    return out;
  }

  /** Coggan-style zone for a % of FTP (used for colors). */
  function zoneForPct(pct) {
    if (pct < 55) return 1;
    if (pct < 75) return 2;
    if (pct < 90) return 3;
    if (pct < 105) return 4;
    if (pct < 120) return 5;
    return 6;
  }

  root.RodilloWorkouts = {
    parseWorkoutFile, parseCourseFile, totalDuration, segmentAt, targetWattsAt, segmentWatts, rideStats, zoneForPct,
  };
})(typeof window !== "undefined" ? window : globalThis);
