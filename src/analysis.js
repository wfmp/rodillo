/* Ride analysis: power curve, zones, weekly aggregates and the performance management chart. */
(function (root) {
  "use strict";

  const MMP_DURATIONS = [1, 5, 10, 15, 30, 60, 120, 180, 300, 600, 1200, 1800, 3600];
  const ZONE_LIMITS = [55, 75, 90, 105, 120]; // % FTP upper limits of Z1..Z5; Z6 above
  const ZONE_NAMES = ["Z1 Recuperación", "Z2 Resistencia", "Z3 Tempo", "Z4 Umbral", "Z5 VO2máx", "Z6 Anaeróbico"];

  /** Mean maximal power for each duration in MMP_DURATIONS (null when the ride is shorter). */
  function powerCurve(power) {
    const n = power.length;
    const prefix = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (power[i] || 0);
    const out = {};
    for (const d of MMP_DURATIONS) {
      if (d > n) { out[d] = null; continue; }
      let best = 0;
      for (let i = d; i <= n; i++) {
        const v = prefix[i] - prefix[i - d];
        if (v > best) best = v;
      }
      out[d] = Math.round(best / d);
    }
    return out;
  }

  function zoneIndex(watts, ftp) {
    const pct = watts / ftp * 100;
    for (let z = 0; z < ZONE_LIMITS.length; z++) if (pct < ZONE_LIMITS[z]) return z;
    return ZONE_LIMITS.length;
  }

  /** Seconds in each of the six power zones, plus seconds at or above FTP. */
  function zoneSeconds(power, ftp) {
    const zones = [0, 0, 0, 0, 0, 0];
    let aboveFtp = 0;
    for (const p of power) {
      if (p == null) continue;
      zones[zoneIndex(p, ftp)]++;
      if (p >= ftp) aboveFtp++;
    }
    return { zones, aboveFtp };
  }

  /** Monday 00:00 local time of the week containing the unix time (seconds). */
  function weekStart(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime() / 1000;
  }

  function dayKey(unixSeconds) {
    const d = new Date(unixSeconds * 1000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /**
   * Performance management chart from daily loads.
   * loads: Map dayKey -> load. Returns [{day, load, ctl, atl, tsb, ratio}] from firstDay to lastDay.
   * TSB is computed from the previous day's CTL and ATL (as GoldenCheetah does).
   */
  function pmc(loads, firstDay, lastDay) {
    const out = [];
    let ctl = 0, atl = 0;
    const kCtl = 1 - Math.exp(-1 / 42), kAtl = 1 - Math.exp(-1 / 7);
    const d = new Date(firstDay + "T12:00:00");
    const end = new Date(lastDay + "T12:00:00");
    while (d <= end) {
      const key = dayKey(d.getTime() / 1000);
      const load = loads.get(key) || 0;
      const tsb = ctl - atl;
      ctl += (load - ctl) * kCtl;
      atl += (load - atl) * kAtl;
      out.push({ day: key, load, ctl, atl, tsb, ratio: ctl > 0 ? atl / ctl : null });
      d.setDate(d.getDate() + 1);
    }
    return out;
  }

  /** Banister TRIMP (male coefficients), as used by GoldenCheetah's TRIMP Points. */
  function trimp(hrSamples, hrRest, hrMax) {
    let sum = 0;
    for (const hr of hrSamples) {
      if (!hr) continue;
      const x = Math.max(0, Math.min(1, (hr - hrRest) / (hrMax - hrRest)));
      sum += x * 0.64 * Math.exp(1.92 * x) / 60;
    }
    return sum;
  }

  root.RodilloAnalysis = {
    MMP_DURATIONS, ZONE_LIMITS, ZONE_NAMES,
    powerCurve, zoneIndex, zoneSeconds, weekStart, dayKey, pmc, trimp,
  };
})(typeof window !== "undefined" ? window : globalThis);
