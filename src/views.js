/* Tabs beyond training: activity history, power analysis and fitness (PMC). */
(function () {
  "use strict";

  const H = window.RodilloHistory;
  const A = window.RodilloAnalysis;
  const C = window.RodilloChart;
  const P = window.RodilloFitParse;
  const F = window.RodilloFit;
  const W = window.RodilloWorkouts;
  const D = window.RodilloDropbox;
  let app = null; // helpers exported by app.js

  const ZONE_VARS = ["--z1", "--z2", "--z3", "--z4", "--z5", "--z6"];
  const SERIES = ["#3f8cff", "#27b37f", "#f2c94c", "#e63971"]; // fixed categorical order for multi-line charts
  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const SPORTS = { 0: "Actividad", 1: "Carrera", 2: "Ciclismo", 5: "Natación", 7: "Fútbol", 8: "Tenis", 64: "Raqueta" };
  const SUB_SPORTS = { 95: "Bádminton", 6: "Rodillo" };

  const $ = (s) => document.querySelector(s);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  /** "#rrggbb" + alpha -> rgba(), because canvas does not understand color-mix(). */
  const alpha = (hex, a) => {
    const h = hex.replace("#", "");
    const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const fmtDur = (s) => {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? h + " h " + String(m).padStart(2, "0") : m + " min";
  };
  const fmtDate = (ts) => { const d = new Date(ts * 1000); return WEEKDAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; };
  const fmtTimeOfDay = (ts) => { const d = new Date(ts * 1000); return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };
  const fmtWeek = (ws) => { const d = new Date(ws * 1000); return d.getDate() + " " + MONTHS[d.getMonth()]; };
  const fmtSecs = (s) => s < 60 ? s + " s" : s < 3600 ? (s / 60) + " min" : (s / 3600) + " h";

  // ---------- Data ----------
  let summaries = [];
  let external = [];

  async function loadData() {
    try { summaries = await H.listSummaries(); } catch (e) { summaries = []; }
    try { external = await H.listExternal(); } catch (e) { external = []; }
    return { summaries, external };
  }

  /** External activities that are not already in the local history (same time window). */
  function externalOnly() {
    const overlaps = (a, b) => a.start < b.end + 600 && a.end > b.start - 600;
    const rank = (x) => (x.hasPower ? 2 : 0) + (x.load > 0 ? 1 : 0);
    return external.filter((x) => !summaries.some((s) => overlaps(x, s))
      // when two external activities cover the same session (watch + trainer), keep the one with power
      && !external.some((y) => y !== x && overlaps(x, y) && (rank(y) > rank(x) || (rank(y) === rank(x) && y.id < x.id))));
  }

  /** Combined training load per local day: TSS for rides with power, TRIMP × 0.56 otherwise. */
  function dailyLoads() {
    const bike = new Map(), other = new Map();
    const add = (map, ts, v) => { const k = A.dayKey(ts); map.set(k, (map.get(k) || 0) + v); };
    for (const s of summaries) add(s.curve ? bike : other, s.start, s.load || 0);
    for (const x of externalOnly()) add(x.hasPower ? bike : other, x.start, x.load || 0);
    const total = new Map();
    for (const m of [bike, other]) for (const [k, v] of m) total.set(k, (total.get(k) || 0) + v);
    return { bike, other, total };
  }

  // ---------- Tabs ----------
  const TABS = ["library", "activities", "form", "power", "measures", "food"];
  function showTab(name) {
    app.showView(name);
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    try { localStorage.setItem("rodillo.tab", name); } catch (e) { /* ignore */ }
    render(name);
  }

  function render(name) {
    if (name === "activities") renderActivities();
    else if (name === "power") renderPower();
    else if (name === "form") renderForm();
    else if (name === "measures") window.RodilloMeasures.render();
    else if (name === "food") window.RodilloFood.render();
    else if (name === "library") app.renderLibrary();
  }

  // ---------- Activities ----------
  async function renderActivities() {
    await loadData();
    const list = $("#activity-list");
    const items = summaries.map((s) => ({ kind: "local", start: s.start, s }))
      .concat(externalOnly().map((x) => ({ kind: "ext", start: x.start, x })))
      .sort((a, b) => b.start - a.start);
    if (!items.length) {
      list.replaceChildren(app.el("p", { class: "empty" }, "Todavía no hay actividades. Termina una sesión en Entrenar, importa archivos FIT o sincroniza intervals.icu en Forma."));
      return;
    }
    const groups = new Map();
    for (const it of items) {
      const wk = A.weekStart(it.start);
      if (!groups.has(wk)) groups.set(wk, []);
      groups.get(wk).push(it);
    }
    const nodes = [];
    for (const [wk, its] of groups) {
      let secs = 0, load = 0;
      for (const it of its) { secs += it.kind === "local" ? it.s.timerSeconds : it.x.seconds; load += (it.kind === "local" ? it.s.load : it.x.load) || 0; }
      nodes.push(app.el("div", { class: "week-head" },
        app.el("span", {}, "Semana del " + fmtWeek(wk)),
        app.el("span", { class: "num" }, fmtDur(secs) + " · carga " + Math.round(load))));
      for (const it of its) nodes.push(activityRow(it));
    }
    list.replaceChildren(...nodes);
  }

  function activityRow(it) {
    if (it.kind === "local") {
      const s = it.s, st = s.stats || {};
      const metrics = s.curve
        ? [st.np ? st.np + " W NP" : (st.avgPower || 0) + " W", "TSS " + Math.round(s.load || 0)]
        : ["carga " + Math.round(s.load || 0)];
      if (st.avgHr) metrics.push(st.avgHr + " ppm");
      return app.el("button", { class: "act-row", type: "button", onclick: () => openActivity(s.id) },
        app.el("span", { class: "act-date" }, fmtDate(s.start), app.el("small", {}, fmtTimeOfDay(s.start))),
        app.el("span", { class: "act-name" }, s.name, app.el("small", {}, s.source === "app" ? "Rodillo" : s.source === "icu" ? (s.sport || "Bici") + " · intervals.icu" : "FIT importado")),
        app.el("span", { class: "act-dur num" }, fmtDur(s.timerSeconds)),
        app.el("span", { class: "act-metrics num" }, metrics.join(" · ")));
    }
    const x = it.x;
    const metrics = ["carga " + Math.round(x.load || 0)];
    if (x.avgHr) metrics.push(x.avgHr + " ppm");
    return app.el("div", { class: "act-row ext" },
      app.el("span", { class: "act-date" }, fmtDate(x.start), app.el("small", {}, fmtTimeOfDay(x.start))),
      app.el("span", { class: "act-name" }, x.name || x.type, app.el("small", {}, x.type + " · intervals.icu")),
      app.el("span", { class: "act-dur num" }, fmtDur(x.seconds)),
      app.el("span", { class: "act-metrics num" }, metrics.join(" · ")));
  }

  async function importFitFiles(files) {
    let ok = 0;
    for (const file of files) {
      try {
        const fit = P.parse(new Uint8Array(await file.arrayBuffer()));
        const samples = P.toSamples(fit);
        if (samples.length < 30) throw new Error("tiene menos de 30 s de datos");
        const ftp = app.settings.ftp;
        const stats = W.rideStats(samples, ftp);
        const hasPower = samples.some((s) => s.power > 0);
        let load = stats.tss;
        if (!hasPower) {
          stats.np = 0; stats.tss = 0; stats.if = 0;
          load = Math.round(A.trimp(samples.map((s) => s.hr), app.settings.hrRest, app.settings.hrMax) * 0.56 * 10) / 10;
        }
        const sportName = SUB_SPORTS[fit.subSport] && fit.sport !== 2 ? SUB_SPORTS[fit.subSport] : SPORTS[fit.sport] || "Actividad";
        const name = file.name.replace(/\.fit$/i, "").replace(/_/g, " ");
        await H.saveRide({
          id: "fit-" + samples[0].ts, source: "fit", name: name || sportName, sport: sportName,
          ftp, stats, load, fileName: file.name, samples,
        });
        ok++;
      } catch (e) {
        app.toast(file.name + ": " + (e.message || e), "error");
      }
    }
    if (ok) app.toast(ok === 1 ? "Actividad importada." : ok + " actividades importadas.");
    renderActivities();
  }

  // ---------- Activity detail ----------
  let current = null;

  async function openActivity(id) {
    const ride = await H.getRide(id);
    if (!ride) { app.toast("No encuentro esa actividad.", "error"); return; }
    current = ride;
    app.showView("activity");
    const s = ride.stats || {};
    $("#act-title").textContent = ride.name;
    $("#act-date").textContent = fmtDate(ride.columns.ts[0]) + " · " + fmtTimeOfDay(ride.columns.ts[0]) + " · " + (ride.source === "app" ? "Rodillo" : ride.source === "icu" ? "intervals.icu" : "FIT importado");
    const hasPower = ride.columns.power.some((p) => p > 0);
    const items = [["Tiempo", fmtDur(ride.columns.ts.length)]];
    if (hasPower) items.push(["Potencia media", s.avgPower + " W"], ["NP", s.np + " W"], ["IF", (s.if || 0).toFixed(2)], ["TSS", Math.round(s.tss || 0)], ["Trabajo", s.kj + " kJ"], ["Potencia máx.", s.maxPower + " W"]);
    else items.push(["Carga", Math.round(ride.load || 0)]);
    items.push(["Pulso medio", s.avgHr ? s.avgHr + " ppm" : "—"], ["Pulso máx.", s.maxHr ? s.maxHr + " ppm" : "—"]);
    if (s.avgCadence) items.push(["Cadencia media", s.avgCadence + " rpm"]);
    $("#act-grid").replaceChildren(...items.map(([k, v]) => app.el("div", { class: "stat" }, app.el("span", { class: "stat-k" }, k), app.el("span", { class: "stat-v" }, String(v)))));
    $("#act-power-box").hidden = !hasPower;
    $("#act-dropbox").hidden = !!ride.dropboxPath || !D.isConnected();
    renderLaps(ride);
    requestAnimationFrame(() => drawActivityCharts(ride));
  }

  /** Average consecutive samples into at most maxPoints buckets. */
  function bucket(values, maxPoints) {
    const n = values.length, size = Math.max(1, Math.ceil(n / maxPoints));
    const out = [];
    for (let i = 0; i < n; i += size) {
      let sum = 0, cnt = 0;
      for (let k = i; k < Math.min(n, i + size); k++) if (values[k] != null) { sum += values[k]; cnt++; }
      out.push([i, cnt ? sum / cnt : null]);
    }
    return out;
  }

  function timeTicks(n) {
    const step = n > 5400 ? 1800 : n > 2400 ? 600 : n > 900 ? 300 : 60;
    const ticks = [];
    for (let t = step; t < n; t += step) ticks.push({ v: t, label: Math.round(t / 60) + "′" });
    return ticks;
  }

  function drawActivityCharts(ride) {
    const c = ride.columns, n = c.ts.length;
    const maxPts = 400;
    const ftp = ride.ftp || app.settings.ftp;
    if (c.power.some((p) => p > 0)) {
      const pts = bucket(c.power, maxPts);
      const maxW = Math.max(ftp * 1.3, ...pts.map((p) => p[1] || 0)) * 1.05;
      const laps = lapRanges(c);
      C.mount($("#act-power"), {
        x: { type: "linear", min: 0, max: n, ticks: timeTicks(n) },
        y: { min: 0, max: maxW, format: (v) => Math.round(v) + "" },
        refs: [{ y: ftp, label: "FTP " + ftp + " W" }],
        lines: [{ name: "Potencia", color: css("--fg"), width: 1.5, points: pts }],
        tooltip: (x) => {
          const lap = laps.findIndex((l) => x >= l.from && x < l.to);
          const val = pts.find((p) => p[0] === x);
          return "<b>" + app.fmtTime(x) + "</b><br>" + Math.round(val[1] || 0) + " W" + (lap >= 0 ? "<br><span class=muted>Lap " + (lap + 1) + "</span>" : "");
        },
      });
    }
    if (c.hr.some((h) => h)) {
      const pts = bucket(c.hr, maxPts);
      const vals = pts.map((p) => p[1]).filter((v) => v);
      C.mount($("#act-hr"), {
        x: { type: "linear", min: 0, max: n, ticks: timeTicks(n) },
        y: { min: Math.floor((Math.min(...vals) - 10) / 10) * 10, max: Math.ceil((Math.max(...vals) + 5) / 10) * 10 },
        lines: [{ name: "Pulso", color: css("--hr"), points: pts }],
        tooltip: (x) => { const v = pts.find((p) => p[0] === x); return "<b>" + app.fmtTime(x) + "</b><br>" + Math.round(v[1] || 0) + " ppm"; },
      });
      $("#act-hr-box").hidden = false;
    } else $("#act-hr-box").hidden = true;
  }

  function lapRanges(c) {
    const laps = [];
    let from = 0;
    for (let i = 1; i <= c.ts.length; i++) {
      if (i === c.ts.length || c.lap[i] !== c.lap[i - 1]) { laps.push({ from, to: i }); from = i; }
    }
    return laps;
  }

  function renderLaps(ride) {
    const c = ride.columns;
    const laps = lapRanges(c);
    const box = $("#act-laps-box");
    if (laps.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    const avg = (arr) => { const v = arr.filter((x) => x != null && x > 0); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const ftp = ride.ftp || app.settings.ftp;
    const rows = laps.map((l, i) => {
      const p = c.power.slice(l.from, l.to), h = c.hr.slice(l.from, l.to), cad = c.cadence.slice(l.from, l.to);
      const ap = avg(p.map((x) => x || 0).concat([])) || 0;
      const zone = A.zoneIndex(ap, ftp);
      return app.el("tr", {},
        app.el("td", {}, app.el("i", { class: "zone-dot", style: "background:var(" + ZONE_VARS[zone] + ")" }), String(i + 1)),
        app.el("td", { class: "num" }, app.fmtTime(l.to - l.from)),
        app.el("td", { class: "num" }, ap ? ap + " W" : "—"),
        app.el("td", { class: "num" }, p.some((x) => x) ? Math.max(...p.map((x) => x || 0)) + " W" : "—"),
        app.el("td", { class: "num" }, avg(h) ? avg(h) + " ppm" : "—"),
        app.el("td", { class: "num" }, avg(cad) ? avg(cad) + " rpm" : "—"));
    });
    $("#act-laps").replaceChildren(...rows);
  }

  function currentFitBytes() {
    const r = current;
    const samples = H.toSamples(r.columns);
    return F.buildActivityFit(samples, [], Object.assign({ ftp: r.ftp }, r.stats));
  }

  async function shareCurrentFit() {
    if (!current) return;
    const name = current.fileName || ("rodillo_" + current.columns.ts[0] + ".fit");
    const file = new File([currentFitBytes()], name.endsWith(".fit") ? name : name + ".fit", { type: "application/octet-stream" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: file.name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = app.el("a", { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a); a.click(); a.remove();
  }

  async function uploadCurrent() {
    if (!current) return;
    try {
      const path = await D.uploadOrQueue(current.fileName || ("rodillo_" + current.columns.ts[0] + ".fit"), currentFitBytes());
      await H.updateSummary(current.id, { dropboxPath: path });
      current.dropboxPath = path;
      $("#act-dropbox").hidden = true;
      app.toast("Guardado en Dropbox: " + path);
    } catch (e) { app.toast("No se pudo subir: " + (e.message || e), "error"); }
  }

  async function deleteCurrent() {
    if (!current) return;
    await H.deleteRide(current.id);
    app.toast("Actividad borrada del iPad" + (current.dropboxPath ? " (sigue en Dropbox)." : "."));
    current = null;
    $("#confirm-delete-act").hidden = true;
    showTab("activities");
  }

  // ---------- Power ----------
  let powerRange = 8;

  function weeksBack(count) {
    const now = Math.floor(Date.now() / 1000);
    const last = A.weekStart(now);
    const weeks = [];
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(last * 1000); d.setDate(d.getDate() - 7 * i);
      weeks.push(d.getTime() / 1000);
    }
    return weeks;
  }

  async function renderPower() {
    await loadData();
    const rides = summaries.filter((s) => s.curve);
    $("#power-empty").hidden = rides.length > 0;
    $("#power-grid").hidden = rides.length === 0;
    if (!rides.length) return;
    let count = powerRange;
    if (count === 0) {
      const first = A.weekStart(Math.min(...rides.map((r) => r.start)));
      count = Math.max(4, Math.round((A.weekStart(Date.now() / 1000) - first) / 604800) + 1);
    }
    const weeks = weeksBack(count);
    const rangeStart = weeks[0];
    const inRange = rides.filter((r) => r.start >= rangeStart);
    const labels = weeks.map(fmtWeek);
    const idxOf = (ts) => weeks.indexOf(A.weekStart(ts));

    // Weekly zone seconds
    const zoneW = weeks.map(() => [0, 0, 0, 0, 0, 0]);
    const above = weeks.map(() => 0), totalSec = weeks.map(() => 0);
    for (const r of inRange) {
      const i = idxOf(r.start); if (i < 0) continue;
      r.zones.forEach((v, z) => { zoneW[i][z] += v; });
      above[i] += r.aboveFtp; totalSec[i] += r.zones.reduce((a, b) => a + b, 0);
    }

    // Aerobic vs anaerobic (% of riding time)
    const pctAbove = above.map((v, i) => totalSec[i] ? v / totalSec[i] * 100 : 0);
    const pctBelow = totalSec.map((t, i) => t ? 100 - pctAbove[i] : 0);
    C.legend($("#legend-aer"), [{ name: "Aeróbico (< FTP)", color: css("--z2") }, { name: "Anaeróbico (≥ FTP)", color: css("--z6") }]);
    C.mount($("#chart-aer"), {
      x: { type: "band", labels }, y: { min: 0, max: 100, step: 25, format: (v) => v + " %" },
      stacks: [{ name: "Aeróbico", color: css("--z2"), values: pctBelow }, { name: "Anaeróbico", color: css("--z6"), values: pctAbove }],
      tooltip: (i) => totalSec[i] ? "<b>Semana del " + labels[i] + "</b><br>Anaeróbico " + pctAbove[i].toFixed(1) + " % (" + Math.round(above[i] / 60) + " min)<br>Aeróbico " + pctBelow[i].toFixed(1) + " %<br><span class=muted>" + fmtDur(totalSec[i]) + " de bici</span>" : null,
    });

    // Time in zones (minutes)
    const zoneMin = A.ZONE_NAMES.map((name, z) => ({ name, color: css(ZONE_VARS[z]), values: zoneW.map((w) => w[z] / 60) }));
    const maxMin = Math.max(10, ...zoneW.map((w) => w.reduce((a, b) => a + b, 0) / 60));
    C.legend($("#legend-zones"), zoneMin.map((s) => ({ name: s.name.split(" ")[0], color: s.color })));
    C.mount($("#chart-zones"), {
      x: { type: "band", labels }, y: { min: 0, max: maxMin * 1.08, format: (v) => Math.round(v) + "′" },
      stacks: zoneMin,
      tooltip: (i) => totalSec[i] ? "<b>Semana del " + labels[i] + "</b><br>" + zoneMin.slice().reverse().map((s) => s.name + ": " + Math.round(s.values[i]) + " min").join("<br>") : null,
    });

    // Power curve: whole range vs last 4 weeks
    const recentStart = weeks[Math.max(0, weeks.length - 4)];
    const best = (list) => A.MMP_DURATIONS.map((d) => { const v = Math.max(0, ...list.map((r) => r.curve[d] || 0)); return [d, v || null]; });
    const curveAll = best(inRange), curveRecent = best(inRange.filter((r) => r.start >= recentStart));
    const maxP = Math.max(app.settings.ftp * 1.5, ...curveAll.map((p) => p[1] || 0)) * 1.08;
    const durTicks = [1, 5, 15, 30, 60, 300, 1200, 3600].map((v) => ({ v, label: v < 60 ? v + "s" : v / 60 + "m" }));
    C.legend($("#legend-curve"), [{ name: "Período", color: SERIES[0] }, { name: "Últimas 4 semanas", color: SERIES[3] }]);
    C.mount($("#chart-curve"), {
      x: { type: "log", min: 1, max: 3600, ticks: durTicks }, y: { min: 0, max: maxP },
      refs: [{ y: app.settings.ftp, label: "FTP" }],
      // Whole-range curve drawn wider underneath so it stays visible where both curves coincide
      lines: [{ name: "Período", color: SERIES[0], points: curveAll, width: 6 }, { name: "Últimas 4 semanas", color: SERIES[3], points: curveRecent, markers: true }],
      tooltip: (d) => {
        const a = curveAll.find((p) => p[0] === d), r = curveRecent.find((p) => p[0] === d);
        return "<b>" + fmtSecs(d) + "</b><br>Período: " + (a[1] ? a[1] + " W" : "—") + "<br>Últimas 4 sem.: " + (r[1] ? r[1] + " W" : "—");
      },
    });

    // Weekly bests over time
    const trendDurs = [5, 30, 60, 300];
    const trend = trendDurs.map((d, k) => ({
      name: d < 60 ? d + " s" : d / 60 + " min", color: SERIES[k],
      values: weeks.map((w, i) => { const v = Math.max(0, ...inRange.filter((r) => idxOf(r.start) === i).map((r) => r.curve[d] || 0)); return v || null; }),
    }));
    const maxT = Math.max(app.settings.ftp * 1.5, ...trend.flatMap((t) => t.values.filter((v) => v))) * 1.08;
    C.legend($("#legend-trend"), trend.map((t) => ({ name: t.name, color: t.color })));
    C.mount($("#chart-trend"), {
      x: { type: "band", labels }, y: { min: 0, max: maxT },
      lines: trend.map((t) => ({ name: t.name, color: t.color, values: t.values, markers: true })),
      tooltip: (i) => trend.some((t) => t.values[i]) ? "<b>Semana del " + labels[i] + "</b><br>" + trend.map((t) => "Mejor " + t.name + ": " + (t.values[i] ? t.values[i] + " W" : "—")).join("<br>") : null,
    });
  }

  // ---------- Form (PMC) ----------
  let formRange = 90;
  const intervalsCfg = () => { try { return JSON.parse(localStorage.getItem("rodillo.intervals") || "{}"); } catch (e) { return {}; } };
  const saveIntervalsCfg = (c) => { try { localStorage.setItem("rodillo.intervals", JSON.stringify(c)); } catch (e) { /* ignore */ } };

  const BIKE_TYPES = /Ride|Cycling|VirtualRide|MountainBike|GravelRide/i;

  /** Map an intervals.icu activity to {id, start, end, seconds, name, type, load, hasPower, avgHr}. */
  function mapIntervals(a) {
    // start_date is UTC ("...Z"); start_date_local has no zone and is parsed as local time
    const start = Math.floor(new Date(a.start_date || a.start_date_local).getTime() / 1000);
    const seconds = a.moving_time || a.elapsed_time || 0;
    const hasPower = (a.icu_weighted_avg_watts || a.icu_average_watts || a.average_watts || 0) > 0;
    let load;
    if (hasPower && a.power_load != null) load = a.power_load;
    else if (hasPower) load = a.icu_training_load || 0;
    else if (a.trimp != null) load = a.trimp * 0.56;
    else load = a.hr_load != null ? a.hr_load : a.icu_training_load || 0;
    return {
      id: "icu-" + a.id, start, end: start + (a.elapsed_time || seconds), seconds, name: a.name, type: a.type || "Actividad",
      load: Math.round((load || 0) * 10) / 10, hasPower, avgHr: a.average_heartrate ? Math.round(a.average_heartrate) : null,
      icuId: a.id, ftp: a.icu_ftp || null, bike: BIKE_TYPES.test(a.type || ""),
      calories: a.calories != null ? Math.round(a.calories) : null,
    };
  }

  async function syncIntervals() {
    const cfg = intervalsCfg();
    if (!cfg.apiKey) { app.toast("Pega primero tu API key de intervals.icu.", "warn"); return; }
    const status = { set textContent(t) { for (const n of document.querySelectorAll(".icu-status")) n.textContent = t; } };
    status.textContent = "Sincronizando…";
    const newest = A.dayKey(Date.now() / 1000);
    const oldestD = new Date(); oldestD.setDate(oldestD.getDate() - 400);
    const oldest = A.dayKey(oldestD.getTime() / 1000);
    const url = "https://intervals.icu/api/v1/athlete/" + encodeURIComponent(cfg.athleteId || "0") + "/activities?oldest=" + oldest + "&newest=" + newest;
    try {
      const res = await fetch(url, { headers: { Authorization: "Basic " + btoa("API_KEY:" + cfg.apiKey) } });
      if (res.status === 401 || res.status === 403) throw new Error("la API key no es válida (HTTP " + res.status + ")");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const list = (await res.json()).filter((a) => a && a.start_date_local).map(mapIntervals);
      await H.saveExternal(list);
      cfg.lastSync = Date.now(); saveIntervalsCfg(cfg);
      app.toast(list.length + " actividades de intervals.icu.");
      const got = await downloadPowerRides(list, cfg, status);
      if (got) app.toast(got === 1 ? "1 salida con potencia descargada." : got + " salidas con potencia descargadas.");
      renderForm();
    } catch (e) {
      const cors = e instanceof TypeError;
      status.textContent = cors
        ? "No se pudo conectar: intervals.icu no acepta llamadas directas desde esta página (o no hay red)."
        : "No se pudo sincronizar: " + (e.message || e);
    }
  }

  /** Pull second-by-second streams for rides with power that are not yet in the local history. */
  async function downloadPowerRides(list, cfg, status) {
    await loadData();
    const have = new Set(summaries.map((s) => s.id));
    const todo = list.filter((x) => x.hasPower && !have.has(x.id));
    let got = 0;
    for (let i = 0; i < todo.length; i++) {
      const x = todo[i];
      status.textContent = "Bajando datos de potencia " + (i + 1) + "/" + todo.length + "…";
      try {
        const url = "https://intervals.icu/api/v1/activity/" + encodeURIComponent(x.icuId) + "/streams?types=time,watts,heartrate,cadence,velocity_smooth,distance";
        const res = await fetch(url, { headers: { Authorization: "Basic " + btoa("API_KEY:" + cfg.apiKey) } });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const streams = {};
        for (const s of await res.json()) streams[s.type] = s.data;
        if (!streams.time || !streams.watts) continue;
        const samples = streamsToSamples(x.start, streams);
        if (samples.length < 60) continue;
        const ftp = x.ftp || app.settings.ftp;
        const stats = W.rideStats(samples, ftp);
        await H.saveRide({ id: x.id, source: "icu", name: x.name || x.type, sport: x.type, ftp, stats, load: x.load || stats.tss, samples });
        got++;
      } catch (e) {
        status.textContent = "No se pudo bajar " + (x.name || x.id) + ": " + (e.message || e);
      }
    }
    return got;
  }

  /** intervals.icu streams -> 1 Hz samples; gaps up to 5 s are filled, longer gaps are pauses. */
  function streamsToSamples(start, st) {
    const out = [];
    const n = st.time.length;
    for (let i = 0; i < n; i++) {
      const t = st.time[i];
      const next = i + 1 < n ? st.time[i + 1] : t + 1;
      const span = next - t > 0 && next - t <= 5 ? next - t : 1;
      for (let k = 0; k < span; k++) {
        const ts = start + t + k;
        if (out.length && ts <= out[out.length - 1].ts) continue;
        out.push({
          ts, power: st.watts[i] == null ? null : Math.round(st.watts[i]),
          hr: st.heartrate ? st.heartrate[i] || null : null,
          cadence: st.cadence ? (st.cadence[i] == null ? null : Math.round(st.cadence[i])) : null,
          speed: st.velocity_smooth ? st.velocity_smooth[i] : null,
          distance: st.distance ? st.distance[i] : null, lap: 0,
        });
      }
    }
    return out;
  }

  function ratioStatus(r) {
    if (r == null) return { cls: "neutral", icon: "–", label: "Sin datos", text: "Hacen falta unas 4 semanas de datos para calcular el ratio: sincroniza intervals.icu para traer tu historial." };
    if (r < 0.8) return { cls: "low", icon: "↓", label: "Carga baja", text: "Estás descargado: puedes meter la sesión completa." };
    if (r < 1.0) return { cls: "fresh", icon: "●", label: "Fresco", text: "Buena zona antes de un partido." };
    if (r <= 1.3) return { cls: "ok", icon: "✓", label: "En objetivo", text: "Zona objetivo del plan (1.0–1.3): sigue como está." };
    if (r <= 1.4) return { cls: "warn", icon: "!", label: "Alta", text: "Carga alta: haz la sesión pero sin extras." };
    return { cls: "bad", icon: "!!", label: "Muy alta", text: "Por encima de 1.4: sáltate la sesión C de esta semana." };
  }

  function renderIcuStatus(cfg) {
    const text = cfg.apiKey
      ? (cfg.lastSync ? "Última sincronización: " + new Date(cfg.lastSync).toLocaleString("es") + " · " + external.length + " actividades." : "Conectado, todavía sin sincronizar.")
      : "Sin conectar: pega la API key de intervals.icu en Ajustes.";
    for (const n of document.querySelectorAll(".icu-status")) n.textContent = text;
    $("#icu-sync").hidden = !cfg.apiKey;
  }

  /** Fill the intervals.icu fields of the settings dialog. */
  function fillIcuSettings() {
    const cfg = intervalsCfg();
    $("#icu-key").value = cfg.apiKey || "";
    $("#icu-athlete").value = cfg.athleteId || "";
    loadData().then(() => renderIcuStatus(cfg));
  }

  async function renderForm() {
    await loadData();
    const cfg = intervalsCfg();
    renderIcuStatus(cfg);

    const loads = dailyLoads();
    const allDays = [...loads.total.keys()].sort();
    const today = A.dayKey(Date.now() / 1000);
    if (!allDays.length) {
      $("#form-empty").hidden = false; $("#form-charts").hidden = true;
      renderStatus(null);
      return;
    }
    $("#form-empty").hidden = true; $("#form-charts").hidden = false;
    const series = A.pmc(loads.total, allDays[0], today);
    // The ratio is meaningless until CTL has built up: hide it for the first 4 weeks of data
    series.forEach((d, i) => { if (i < 28) d.ratio = null; });
    const last = series[series.length - 1];
    renderStatus(last);

    const shown = series.slice(-formRange);
    const labels = shown.map((d) => { const [, m, dd] = d.day.split("-"); return +dd + " " + MONTHS[+m - 1]; });
    const vals = shown.flatMap((d) => [d.ctl, d.atl, d.tsb]);
    const yMin = Math.min(-10, Math.floor(Math.min(...vals) / 10) * 10), yMax = Math.max(20, Math.ceil(Math.max(...vals) / 10) * 10);
    const pmcLines = [
      { name: "Forma CTL", color: SERIES[0], values: shown.map((d) => d.ctl), width: 2.5 },
      { name: "Fatiga ATL", color: SERIES[3], values: shown.map((d) => d.atl) },
      { name: "Frescura TSB", color: SERIES[2], values: shown.map((d) => d.tsb), dash: [5, 4] },
    ];
    C.legend($("#legend-pmc"), pmcLines.map((l) => ({ name: l.name, color: l.color, dash: !!l.dash })));
    C.mount($("#chart-pmc"), {
      x: { type: "band", labels }, y: { min: yMin, max: yMax },
      refs: [{ y: 0 }],
      lines: pmcLines,
      tooltip: (i) => "<b>" + labels[i] + "</b><br>CTL " + shown[i].ctl.toFixed(1) + "<br>ATL " + shown[i].atl.toFixed(1) + "<br>TSB " + shown[i].tsb.toFixed(1) + "<br><span class=muted>Carga del día " + Math.round(shown[i].load) + "</span>",
    });

    C.mount($("#chart-ratio"), {
      x: { type: "band", labels }, y: { min: 0.4, max: 2.0, ticks: [0.5, 0.8, 1.0, 1.3, 1.6, 2.0], format: (v) => v.toFixed(1) },
      bands: [
        { y0: 0.8, y1: 1.0, color: alpha(css("--z2"), 0.14) },
        { y0: 1.0, y1: 1.3, color: alpha(css("--ok"), 0.18) },
        { y0: 1.4, y1: 2.0, color: alpha(css("--bad"), 0.14) },
      ],
      lines: [{ name: "Ratio", color: css("--fg"), values: shown.map((d) => d.ratio) }],
      tooltip: (i) => shown[i].ratio == null ? null : "<b>" + labels[i] + "</b><br>Ratio " + shown[i].ratio.toFixed(2) + "<br>" + ratioStatus(shown[i].ratio).label,
    });

    const bikeVals = shown.map((d) => loads.bike.get(d.day) || 0), otherVals = shown.map((d) => loads.other.get(d.day) || 0);
    C.legend($("#legend-load"), [{ name: "Bici (TSS)", color: SERIES[0] }, { name: "Otros deportes (TRIMP × 0.56)", color: SERIES[1] }]);
    C.mount($("#chart-load"), {
      x: { type: "band", labels }, y: { min: 0, max: Math.max(50, ...shown.map((d) => d.load)) * 1.1 },
      stacks: [{ name: "Bici", color: SERIES[0], values: bikeVals }, { name: "Otros", color: SERIES[1], values: otherVals }],
      tooltip: (i) => shown[i].load ? "<b>" + labels[i] + "</b><br>Bici " + Math.round(bikeVals[i]) + "<br>Otros " + Math.round(otherVals[i]) : null,
    });
  }

  function renderStatus(last) {
    const st = ratioStatus(last ? last.ratio : null);
    const card = $("#form-status");
    card.dataset.state = st.cls;
    $("#fs-icon").textContent = st.icon;
    $("#fs-label").textContent = st.label;
    $("#fs-text").textContent = st.text;
    $("#fs-ctl").textContent = last ? last.ctl.toFixed(0) : "—";
    $("#fs-atl").textContent = last ? last.atl.toFixed(0) : "—";
    $("#fs-tsb").textContent = last ? (last.ctl - last.atl).toFixed(0) : "—";
    $("#fs-ratio").textContent = last && last.ratio != null ? last.ratio.toFixed(2) : "—";
  }

  // ---------- Wire up ----------
  function init(helpers) {
    app = helpers;
    for (const b of document.querySelectorAll(".tabs button")) b.addEventListener("click", () => showTab(b.dataset.tab));
    $("#fit-import").addEventListener("change", (e) => { importFitFiles([...e.target.files]); e.target.value = ""; });
    $("#act-back").addEventListener("click", () => showTab("activities"));
    $("#act-share").addEventListener("click", shareCurrentFit);
    $("#act-dropbox").addEventListener("click", uploadCurrent);
    $("#act-delete").addEventListener("click", () => { $("#confirm-delete-act").hidden = false; });
    $("#act-delete-yes").addEventListener("click", deleteCurrent);
    $("#act-delete-no").addEventListener("click", () => { $("#confirm-delete-act").hidden = true; });
    for (const b of document.querySelectorAll("[data-power-range]")) b.addEventListener("click", () => {
      powerRange = +b.dataset.powerRange;
      for (const o of document.querySelectorAll("[data-power-range]")) o.setAttribute("aria-pressed", o === b ? "true" : "false");
      renderPower();
    });
    for (const b of document.querySelectorAll("[data-form-range]")) b.addEventListener("click", () => {
      formRange = +b.dataset.formRange;
      for (const o of document.querySelectorAll("[data-form-range]")) o.setAttribute("aria-pressed", o === b ? "true" : "false");
      renderForm();
    });
    $("#btn-settings").addEventListener("click", fillIcuSettings);
    $("#icu-sync").addEventListener("click", syncIntervals);
    $("#icu-save").addEventListener("click", () => {
      const cfg = intervalsCfg();
      cfg.apiKey = $("#icu-key").value.trim();
      cfg.athleteId = $("#icu-athlete").value.trim();
      saveIntervalsCfg(cfg);
      syncIntervals();
    });
    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const v = document.body.dataset.view;
        if (v === "activity" && current) drawActivityCharts(current);
        else if (v !== "library" && TABS.includes(v)) render(v);
      }, 150);
    });
  }

  /**
   * Activities of one local day with their energy: kJ of mechanical work for rides with power
   * (≈ kcal burned at ~24 % efficiency), the device calories for the rest.
   */
  async function dayActivities(day) {
    await loadData();
    const out = [];
    for (const s of summaries) {
      if (A.dayKey(s.start) !== day) continue;
      const ext = external.find((x) => x.id === s.id);
      const kcal = s.stats && s.stats.kj ? s.stats.kj : ext && ext.calories ? ext.calories : null;
      out.push({ name: s.name, kcal, seconds: s.timerSeconds || (ext && ext.seconds) || 0 });
    }
    for (const x of externalOnly()) if (A.dayKey(x.start) === day) out.push({ name: x.name || x.type, kcal: x.calories, seconds: x.seconds || 0 });
    return out;
  }

  window.RodilloViews = { init, showTab, loadData, dayActivities, summariesCache: () => summaries };
})();
