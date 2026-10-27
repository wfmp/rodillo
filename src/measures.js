/* Body measurements tab: entries kept on the device, charts, edit form, Excel import/export and Dropbox backup. */
(function () {
  "use strict";

  const C = window.RodilloChart;
  const X = window.RodilloXlsx;
  const D = window.RodilloDropbox;
  const KEY = "rodillo.medidas";
  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const SERIES = ["#3f8cff", "#27b37f", "#f2c94c", "#e63971"];
  let app = null;
  let range = 365;
  let editingId = null;

  // Field definitions: key, label, unit, decimals
  const FIELDS = [
    ["weight", "Peso", "kg", 1], ["fatPct", "Grasa", "%", 1], ["musclePct", "Músculo", "%", 1], ["waterPct", "Agua", "%", 1],
    ["boneKg", "Hueso", "kg", 1], ["waist", "Cintura", "cm", 1], ["neck", "Cuello", "cm", 1],
  ];

  const $ = (s) => document.querySelector(s);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const round1 = (v) => v == null ? null : Math.round(v * 10) / 10;
  const fmt = (v, d) => v == null ? "—" : v.toFixed(d == null ? 1 : d).replace(".", ",");
  const dateKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const parseKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (k) => { const d = parseKey(k); return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear(); };
  const dayNum = (k) => parseKey(k).getTime() / 86400000;

  /** Waist-based body-fat estimate used in the spreadsheet before the scale existed. */
  const estimateFat = (waist) => waist ? round1(0.4868 * waist - 18.987) : null;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { return []; }
  }
  function save(list) {
    list.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) { app.toast("No se pudo guardar en el iPad: " + e.message, "error"); }
    // The latest weight feeds W/kg and the app settings
    const last = [...list].reverse().find((m) => m.weight);
    if (last && app.settings.weight !== last.weight) { app.settings.weight = last.weight; app.store.set("settings", app.settings); }
  }

  /** Entry with derived values: fat % (measured or estimated), fat and muscle mass. */
  function derive(m) {
    // Only the old spreadsheet rows use the waist estimate; new entries without a scale reading stay empty
    const fatPct = m.fatPct != null ? m.fatPct : m.fatEstimated ? estimateFat(m.waist) : null;
    const fatEstimated = m.fatPct == null && fatPct != null;
    return Object.assign({}, m, {
      fat: fatPct, fatEstimated,
      fatKg: m.weight && fatPct != null ? round1(m.weight * fatPct / 100) : null,
      muscleKg: m.weight && m.musclePct != null ? round1(m.weight * m.musclePct / 100) : null,
    });
  }

  // ---------- Import / export ----------
  const HEADER_MAP = [
    [/^fecha/, "date"], [/^peso/, "weight"], [/^cintura/, "waist"], [/^cuello/, "neck"],
    [/%\s*grasa|grasa\s*\[%\]/, "fatPct"], [/^agua/, "waterPct"], [/^m[uú]sculo\s*\[%\]/, "musclePct"], [/^hueso/, "boneKg"],
  ];

  async function importExcel(file) {
    try {
      const sheets = await X.read(await file.arrayBuffer());
      const sheet = sheets.find((s) => /^medidas$/i.test(s.name))
        || sheets.find((s) => s.rows[0] && s.rows[0].some((c) => c && /fecha/i.test(String(c.v))) && s.rows[0].some((c) => c && /peso/i.test(String(c.v))));
      if (!sheet) throw new Error("no encuentro una hoja 'medidas' con columnas fecha y peso");
      const cols = {};
      (sheet.rows[0] || []).forEach((c, i) => {
        if (!c || c.v == null) return;
        const h = String(c.v).trim().toLowerCase();
        for (const [re, key] of HEADER_MAP) if (re.test(h) && cols[key] == null) cols[key] = i;
      });
      if (cols.date == null || cols.weight == null) throw new Error("faltan las columnas fecha o peso");
      const byDate = new Map(load().map((m) => [m.date, m]));
      let n = 0;
      for (let r = 1; r < sheet.rows.length; r++) {
        const row = sheet.rows[r];
        if (!row || !row[cols.date] || typeof row[cols.date].v !== "number") continue;
        const entry = { date: dateKey(X.serialToDate(row[cols.date].v)) };
        for (const [key, idx] of Object.entries(cols)) {
          if (key === "date") continue;
          const cell = row[idx];
          entry[key] = cell && typeof cell.v === "number" && Number.isFinite(cell.v) ? round1(cell.v) : null;
        }
        // Old rows: fat % is the waist formula, not a scale reading
        const fatCell = cols.fatPct != null ? row[cols.fatPct] : null;
        if (fatCell && fatCell.f && /0\.4868/.test(fatCell.f)) { entry.fatPct = null; entry.fatEstimated = true; }
        if (entry.weight == null && entry.waist == null) continue;
        entry.id = entry.date;
        byDate.set(entry.date, entry);
        n++;
      }
      save([...byDate.values()]);
      app.toast(n + " medidas importadas.");
      render();
      backupToDropbox();
    } catch (e) {
      app.toast(file.name + ": " + (e.message || e), "error");
    }
  }

  function buildExcel() {
    const list = load();
    const columns = [
      { header: "fecha", type: "date", width: 12 }, { header: "peso [kg]", decimals: 1 }, { header: "% grasa", decimals: 1 },
      { header: "musculo [%]", decimals: 1 }, { header: "agua [%]", decimals: 1 }, { header: "hueso [kg]", decimals: 1 },
      { header: "cintura [cm]", decimals: 1 }, { header: "cuello [cm]", decimals: 1 },
      { header: "grasa [kg]", decimals: 1 }, { header: "musculo [kg]", decimals: 1 },
    ];
    const rows = list.map((m) => {
      const d = derive(m);
      // Estimated fat stays a formula so a later re-import recognises it
      const fat = m.fatPct != null ? m.fatPct : m.fatEstimated && m.waist ? { formula: 'IF(G{r}<>"",0.4868*G{r}-18.987,"")', value: d.fat } : null;
      return [parseKey(m.date), m.weight, fat, m.musclePct, m.waterPct, m.boneKg, m.waist, m.neck,
        d.fat != null && m.weight ? { formula: "B{r}*C{r}/100", value: d.fatKg } : null,
        m.musclePct != null && m.weight ? { formula: "B{r}*D{r}/100", value: d.muscleKg } : null];
    });
    return X.write("medidas", columns, rows);
  }

  async function exportExcel() {
    const blob = buildExcel();
    const name = "medidas_" + dateKey(new Date()) + ".xlsx";
    const file = new File([blob], name, { type: blob.type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = app.el("a", { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
  }

  /** Keep an up-to-date copy in Dropbox (overwritten on each change). */
  let backupTimer = null;
  function backupToDropbox() {
    if (!D.isConnected()) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
      try {
        const bytes = new Uint8Array(await buildExcel().arrayBuffer());
        await D.upload("datos/medidas.xlsx", bytes, { overwrite: true });
        $("#ms-backup").textContent = "Copia en Dropbox actualizada " + new Date().toLocaleTimeString("es").slice(0, 5) + ".";
      } catch (e) {
        $("#ms-backup").textContent = "No se pudo copiar a Dropbox: " + (e.message || e);
      }
    }, 1500);
  }

  // ---------- Form ----------
  function openForm(entry) {
    editingId = entry ? entry.id : null;
    $("#ms-form-title").textContent = entry ? "Editar medida" : "Nueva medida";
    $("#ms-date").value = entry ? entry.date : dateKey(new Date());
    for (const [key] of FIELDS) $("#ms-" + key).value = entry && entry[key] != null ? entry[key] : "";
    $("#ms-delete").hidden = !entry;
    $("#ms-dialog").hidden = false;
    $("#ms-weight").focus();
  }

  function submitForm(ev) {
    ev.preventDefault();
    const date = $("#ms-date").value;
    if (!date) { app.toast("Falta la fecha.", "error"); return; }
    const entry = { id: date, date };
    for (const [key] of FIELDS) {
      const raw = $("#ms-" + key).value.replace(",", ".").trim();
      entry[key] = raw === "" ? null : round1(parseFloat(raw));
      if (raw !== "" && !Number.isFinite(entry[key])) { app.toast("Valor no válido en " + key + ".", "error"); return; }
    }
    if (entry.weight == null && entry.waist == null) { app.toast("Pon al menos el peso o la cintura.", "error"); return; }
    const before = editingId ? load().find((m) => m.id === editingId) : null;
    if (before && before.fatEstimated && entry.fatPct == null) entry.fatEstimated = true;
    const list = load().filter((m) => m.id !== editingId && m.id !== entry.id);
    list.push(entry);
    save(list);
    $("#ms-dialog").hidden = true;
    app.toast("Medida guardada.");
    render();
    backupToDropbox();
  }

  function deleteEntry() {
    if (!editingId) return;
    save(load().filter((m) => m.id !== editingId));
    $("#ms-dialog").hidden = true;
    app.toast("Medida borrada.");
    render();
    backupToDropbox();
  }

  // ---------- Render ----------
  function yearTicks(minDay, maxDay) {
    const span = maxDay - minDay;
    const ticks = [];
    const start = new Date(minDay * 86400000), end = new Date(maxDay * 86400000);
    if (span > 900) {
      for (let y = start.getFullYear() + 1; y <= end.getFullYear(); y++) ticks.push({ v: new Date(y, 0, 1).getTime() / 86400000, label: String(y) });
    } else {
      const step = span > 400 ? 3 : span > 120 ? 1 : 1;
      const d = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      while (d <= end) {
        if (d.getMonth() % step === 0) ticks.push({ v: d.getTime() / 86400000, label: MONTHS[d.getMonth()] + (d.getMonth() === 0 ? " " + String(d.getFullYear()).slice(2) : "") });
        d.setMonth(d.getMonth() + 1);
      }
      if (span <= 120) ticks.splice(0, ticks.length, ...ticks); // monthly ticks are enough for short ranges
    }
    return ticks;
  }

  function bounds(values, pad, step) {
    const v = values.filter((x) => x != null);
    if (!v.length) return { min: 0, max: 1 };
    return { min: Math.floor((Math.min(...v) - pad) / step) * step, max: Math.ceil((Math.max(...v) + pad) / step) * step };
  }

  function render() {
    const all = load().map(derive);
    $("#ms-empty").hidden = all.length > 0;
    $("#ms-content").hidden = all.length === 0;
    $("#ms-backup").textContent = D.isConnected() ? "Cada cambio se copia a Dropbox (carpeta datos)." : "Conecta Dropbox en Ajustes para tener una copia fuera del iPad.";
    if (!all.length) return;

    renderCards(all);
    renderTable(all);

    const lastDay = dayNum(all[all.length - 1].date);
    const shown = range ? all.filter((m) => dayNum(m.date) >= lastDay - range) : all;
    if (!shown.length) return;
    const minDay = dayNum(shown[0].date), maxDay = Math.max(lastDay, minDay + 30);
    const x = { type: "linear", min: minDay - 3, max: maxDay + 3, ticks: yearTicks(minDay, maxDay) };
    const gap = 90; // days without measurements before a line is broken
    const pts = (key, filter) => shown.filter((m) => m[key] != null && (!filter || filter(m))).map((m) => [dayNum(m.date), m[key]]);
    const byDay = new Map(shown.map((m) => [dayNum(m.date), m]));
    const tipFor = (lines) => (day) => {
      const m = byDay.get(day);
      if (!m) return null;
      return "<b>" + fmtDate(m.date) + "</b><br>" + lines.map(([k, label, unit]) => label + ": " + fmt(m[k]) + " " + unit).join("<br>") + (m.fatEstimated && lines.some((l) => l[0] === "fat") ? "<br><span class=muted>grasa estimada por cintura</span>" : "");
    };
    const dense = shown.length > 80;

    // Weight
    const w = pts("weight");
    C.mount($("#ms-chart-weight"), {
      x, gap, y: Object.assign(bounds(w.map((p) => p[1]), 0.5, 1), { format: (v) => v + "" }),
      lines: [{ name: "Peso", color: SERIES[0], points: w, markers: !dense }],
      tooltip: tipFor([["weight", "Peso", "kg"], ["fat", "Grasa", "%"]]),
    });

    // Body fat: scale readings vs waist estimate
    const fatScale = pts("fat", (m) => !m.fatEstimated), fatEst = pts("fat", (m) => m.fatEstimated);
    const fatLines = [];
    if (fatEst.length) fatLines.push({ name: "Estimada por cintura", color: SERIES[2], points: fatEst, dash: [5, 4], markers: !dense });
    if (fatScale.length) fatLines.push({ name: "Báscula", color: SERIES[3], points: fatScale, markers: !dense });
    C.legend($("#ms-legend-fat"), fatLines.map((l) => ({ name: l.name, color: l.color, dash: !!l.dash })));
    C.mount($("#ms-chart-fat"), {
      x, gap, y: Object.assign(bounds([...fatScale, ...fatEst].map((p) => p[1]), 0.5, 1), { format: (v) => v + " %" }),
      lines: fatLines, pickAll: true,
      tooltip: tipFor([["fat", "Grasa", "%"], ["waist", "Cintura", "cm"]]),
    });

    // Fat and muscle mass
    const fk = pts("fatKg"), mk = pts("muscleKg");
    C.legend($("#ms-legend-mass"), [{ name: "Músculo [kg]", color: SERIES[1] }, { name: "Grasa [kg]", color: SERIES[3] }]);
    C.mount($("#ms-chart-mass"), {
      x, gap, y: Object.assign(bounds([...fk, ...mk].map((p) => p[1]), 1, 2), { format: (v) => v + "" }),
      lines: [{ name: "Músculo", color: SERIES[1], points: mk, markers: !dense }, { name: "Grasa", color: SERIES[3], points: fk, markers: !dense }],
      pickAll: true,
      tooltip: tipFor([["muscleKg", "Músculo", "kg"], ["fatKg", "Grasa", "kg"], ["weight", "Peso", "kg"]]),
    });

    // Waist vs weight and waist vs fat (scatter, recent 8 weeks highlighted)
    const recentFrom = lastDay - 56;
    const scatter = (xKey, yKey) => {
      const older = shown.filter((m) => m[xKey] != null && m[yKey] != null && dayNum(m.date) < recentFrom).map((m) => [m[xKey], m[yKey], m]);
      const recent = shown.filter((m) => m[xKey] != null && m[yKey] != null && dayNum(m.date) >= recentFrom).map((m) => [m[xKey], m[yKey], m]);
      return { older, recent };
    };
    C.legend($("#ms-legend-scatter"), [{ name: "Anteriores", color: css("--z1") }, { name: "Últimas 8 semanas", color: SERIES[0] }]);
    const drawScatter = (canvasSel, xKey, yKey, xLabel, yLabel, xUnit, yUnit) => {
      const s = scatter(xKey, yKey);
      const xs = bounds([...s.older, ...s.recent].map((p) => p[0]), 0.5, 1), ys = bounds([...s.older, ...s.recent].map((p) => p[1]), 0.5, 1);
      const ticks = [];
      const step = C.niceStep(xs.max - xs.min, 6);
      for (let v = Math.ceil(xs.min / step) * step; v <= xs.max; v += step) ticks.push({ v, label: String(Math.round(v * 10) / 10) });
      C.mount($(canvasSel), {
        x: { type: "linear", min: xs.min, max: xs.max, ticks }, y: Object.assign(ys, { format: (v) => v + "" }),
        lines: [
          { name: "Anteriores", color: css("--z1"), points: s.older, markers: true, noLine: true, markerSize: 3 },
          { name: "Últimas 8 semanas", color: SERIES[0], points: s.recent, markers: true, noLine: true, markerSize: 4.5 },
        ],
        pickXY: true,
        tooltip: (hit) => {
          const m = hit && hit.point && hit.point[2];
          return m ? "<b>" + fmtDate(m.date) + "</b><br>" + xLabel + ": " + fmt(m[xKey]) + " " + xUnit + "<br>" + yLabel + ": " + fmt(m[yKey]) + " " + yUnit : null;
        },
      });
    };
    drawScatter("#ms-chart-wv", "weight", "waist", "Peso", "Cintura", "kg", "cm");
    drawScatter("#ms-chart-wf", "waist", "fat", "Cintura", "Grasa", "cm", "%");
  }

  function renderCards(all) {
    const last = all[all.length - 1];
    const lastDay = dayNum(last.date);
    // Reference entry: the closest one to 4 weeks before the latest
    const ref = all.filter((m) => dayNum(m.date) <= lastDay - 21).pop();
    const cards = [["weight", "Peso", "kg"], ["fat", "Grasa", "%"], ["waist", "Cintura", "cm"], ["fatKg", "Grasa", "kg"], ["muscleKg", "Músculo", "kg"]];
    $("#ms-cards").replaceChildren(...cards.map(([k, label, unit]) => {
      const v = last[k];
      const prev = ref ? ref[k] : null;
      const delta = v != null && prev != null ? round1(v - prev) : null;
      return app.el("div", { class: "stat" },
        app.el("span", { class: "stat-k" }, label + " [" + unit + "]"),
        app.el("span", { class: "stat-v" }, fmt(v)),
        app.el("span", { class: "stat-d" }, delta == null ? "" : (delta > 0 ? "+" : delta < 0 ? "−" : "±") + fmt(Math.abs(delta)) + " desde " + fmtDate(ref.date).replace(/ \d{4}$/, "")));
    }));
    $("#ms-last").textContent = "Última medida: " + fmtDate(last.date);
  }

  function renderTable(all) {
    const rows = [...all].reverse().map((m) => app.el("tr", { onclick: () => openForm(load().find((x) => x.id === m.id)) },
      app.el("td", {}, fmtDate(m.date)),
      app.el("td", { class: "num" }, fmt(m.weight)),
      app.el("td", { class: "num" + (m.fatEstimated ? " est" : "") }, fmt(m.fat) + (m.fatEstimated ? "*" : "")),
      ...["musclePct", "waterPct", "boneKg", "waist", "neck", "fatKg", "muscleKg"].map((k) => app.el("td", { class: "num" }, fmt(m[k])))));
    $("#ms-rows").replaceChildren(...rows);
  }

  // ---------- Wire up ----------
  function init(helpers) {
    app = helpers;
    $("#ms-add").addEventListener("click", () => openForm(null));
    $("#ms-form").addEventListener("submit", submitForm);
    $("#ms-cancel").addEventListener("click", () => { $("#ms-dialog").hidden = true; });
    $("#ms-delete").addEventListener("click", deleteEntry);
    $("#ms-import").addEventListener("change", (e) => { if (e.target.files[0]) importExcel(e.target.files[0]); e.target.value = ""; });
    $("#ms-import-empty").addEventListener("change", (e) => { if (e.target.files[0]) importExcel(e.target.files[0]); e.target.value = ""; });
    $("#ms-export").addEventListener("click", exportExcel);
    for (const b of document.querySelectorAll("[data-ms-range]")) b.addEventListener("click", () => {
      range = +b.dataset.msRange;
      for (const o of document.querySelectorAll("[data-ms-range]")) o.setAttribute("aria-pressed", o === b ? "true" : "false");
      render();
    });
  }

  window.RodilloMeasures = { init, render, load };
})();
