/* Food log: daily entries from a food database or free values, energy balance, weekly summary, Excel import/export. */
(function () {
  "use strict";

  const C = window.RodilloChart;
  const X = window.RodilloXlsx;
  const D = window.RodilloDropbox;
  const FOODS_KEY = "rodillo.foods";
  const LOG_KEY = "rodillo.foodlog";
  const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
  const MACROS = [["protein", "Proteína", 4], ["carbs", "Carbohidratos", 4], ["fat", "Grasa", 9]];
  let app = null;
  let day = null; // "YYYY-MM-DD" shown
  let editing = null; // {type: "item"|"libre"|"food", index|name}

  const $ = (s) => document.querySelector(s);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const num = (s) => { const v = parseFloat(String(s == null ? "" : s).replace(",", ".")); return Number.isFinite(v) ? v : null; };
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;
  const fmt0 = (v) => v == null || !Number.isFinite(v) ? "—" : Math.round(v).toLocaleString("es-CH");
  const fmt1 = (v) => v == null || !Number.isFinite(v) ? "—" : (Math.round(v * 10) / 10).toFixed(1).replace(".", ",");
  const keyOf = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const dateOf = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (k, n) => { const d = dateOf(k); d.setDate(d.getDate() + n); return keyOf(d); };
  const fmtDay = (k) => { const d = dateOf(k); return WEEKDAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()]; };
  const norm = (s) => String(s || "").trim().toLowerCase();

  // ---------- Storage ----------
  const loadJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key) || "null") || fallback; } catch (e) { return fallback; } };
  const saveJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { app.toast("No se pudo guardar en el iPad: " + e.message, "error"); return false; } };
  const foods = () => loadJson(FOODS_KEY, []);
  const log = () => loadJson(LOG_KEY, {});
  function saveFoods(list) { list.sort((a, b) => norm(a.name).localeCompare(norm(b.name), "es")); saveJson(FOODS_KEY, list); backup(); }
  function saveDay(k, entry) {
    const all = log();
    if (!entry || (!entry.items.length && entry.exercise == null)) delete all[k]; else all[k] = entry;
    saveJson(LOG_KEY, all); backup();
  }
  const dayEntry = (k) => log()[k] || { items: [], exercise: null };

  // ---------- Calculations ----------
  function findFood(name, list) { const n = norm(name); return (list || foods()).find((f) => norm(f.name) === n) || null; }

  /** Energy and macros of one entry: database food x quantity, or free values. */
  function itemValues(item, list) {
    if (item.libre) return Object.assign({ missing: false }, item.libre);
    const f = findFood(item.food, list);
    if (!f) return { kcal: null, protein: null, carbs: null, fat: null, fiber: null, missing: true };
    const q = item.qty || 0;
    return { kcal: f.kcal * q, protein: f.protein * q, carbs: f.carbs * q, fat: f.fat * q, fiber: (f.fiber || 0) * q, missing: false, unit: f.unit };
  }

  /** Latest measurement on or before a date (the spreadsheet's XLOOKUP(..., -1)). */
  function measureAt(k, after) {
    const list = window.RodilloMeasures.load();
    if (after) return list.find((m) => m.date >= k && m.weight) || null;
    let best = null;
    for (const m of list) if (m.date <= k && m.weight) best = m;
    return best;
  }
  function fatAt(k) {
    const list = window.RodilloMeasures.load();
    let best = null;
    for (const m of list) if (m.date <= k && m.fatPct != null) best = m.fatPct;
    return best;
  }

  /** Base expenditure without exercise: min(Mifflin, Katch-McArdle, Harris-Benedict) x 1.2, as in the spreadsheet. */
  function baseKcal(k) {
    const s = app.settings;
    const m = measureAt(k);
    if (!m || !s.height || !s.birthDate) return null;
    const w = m.weight, h = s.height;
    const age = (dateOf(k) - dateOf(s.birthDate)) / (365.2425 * 86400000);
    const values = [10 * w + 6.25 * h - 5 * age + 5, 13.397 * w + 4.799 * h - 5.677 * age + 88.362];
    const fat = fatAt(k);
    if (fat != null) values.push(370 + 21.6 * w * (1 - fat / 100));
    return Math.min(...values) * 1.2;
  }

  async function daySummary(k, entry) {
    entry = entry || dayEntry(k);
    const list = foods();
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    for (const it of entry.items) {
      const v = itemValues(it, list);
      for (const key of Object.keys(t)) t[key] += v[key] || 0;
    }
    const acts = await window.RodilloViews.dayActivities(k).catch(() => []);
    const autoExercise = acts.reduce((a, x) => a + (x.kcal || 0), 0);
    const exercise = entry.exercise != null ? entry.exercise : autoExercise;
    const base = baseKcal(k);
    const m = measureAt(k), fat = fatAt(k);
    return {
      day: k, items: entry.items.length, totals: t, acts, autoExercise, exercise, base,
      balance: entry.items.length && base != null ? t.kcal - base - exercise : null,
      weight: m ? m.weight : null,
      // Net carbs as in the spreadsheet: fibre is stored negative in the food base
      netCarbs: t.carbs + t.fiber,
      perKg: m ? { protein: fat != null ? t.protein / (m.weight * (1 - fat / 100)) : null, carbs: (t.carbs + t.fiber) / m.weight, fat: t.fat / m.weight } : null,
    };
  }

  /** Sunday that starts the spreadsheet week containing k. */
  const weekStart = (k) => addDays(k, -dateOf(k).getDay());

  // ---------- Render ----------
  async function render() {
    if (!day) day = keyOf(new Date());
    const hasFoods = foods().length > 0, hasLog = Object.keys(log()).length > 0;
    $("#fd-empty").hidden = hasFoods || hasLog;
    $("#fd-content").hidden = !(hasFoods || hasLog);
    $("#fd-backup").textContent = D.isConnected() ? "Cada cambio se copia a Dropbox (carpeta datos)." : "Conecta Dropbox en Ajustes para tener una copia y usar tus datos en otros dispositivos.";
    if ($("#fd-content").hidden) return;
    $("#fd-date").value = day;
    $("#fd-day-label").textContent = fmtDay(day) + (day === keyOf(new Date()) ? " · hoy" : "");
    const datalist = $("#fd-foodlist");
    datalist.replaceChildren(...foods().map((f) => app.el("option", { value: f.name })));
    renderItems();
    await renderDay();
    await renderWeek();
  }

  function renderItems() {
    const entry = dayEntry(day);
    const list = foods();
    $("#fd-copy").hidden = entry.items.length > 0;
    const rows = entry.items.map((it, i) => {
      const v = itemValues(it, list);
      const f = it.libre ? null : findFood(it.food, list);
      return app.el("tr", { onclick: () => openItem(i) },
        app.el("td", {}, it.libre ? (it.libre.name || "Libre") : it.food, it.libre ? app.el("span", { class: "tag" }, "libre") : null, v.missing ? app.el("span", { class: "tag warn" }, "no está en la base") : null),
        app.el("td", { class: "num" }, it.libre ? "—" : fmt1(it.qty).replace(",0", "") + " " + (f ? f.unit || "" : "")),
        app.el("td", { class: "num" }, fmt0(v.kcal)),
        app.el("td", { class: "num" }, fmt1(v.protein)),
        app.el("td", { class: "num" }, fmt1(v.carbs)),
        app.el("td", { class: "num" }, fmt1(v.fat)));
    });
    $("#fd-rows").replaceChildren(...rows);
    $("#fd-noitems").hidden = rows.length > 0;
  }

  async function renderDay() {
    const s = await daySummary(day);
    const bal = $("#fd-balance");
    bal.textContent = s.balance == null ? "—" : (s.balance > 0 ? "+" : "−") + fmt0(Math.abs(s.balance));
    bal.dataset.state = s.balance == null ? "" : s.balance > 0 ? "surplus" : "deficit";
    $("#fd-balance-label").textContent = s.balance == null
      ? (s.base == null ? "Faltan altura y fecha de nacimiento (Ajustes) o una medida de peso" : "Sin comidas registradas")
      : s.balance > 0 ? "kcal de superávit" : "kcal de déficit";
    $("#fd-in").textContent = fmt0(s.totals.kcal);
    $("#fd-base").textContent = fmt0(s.base);
    const ex = $("#fd-exercise");
    ex.value = dayEntry(day).exercise != null ? dayEntry(day).exercise : "";
    ex.placeholder = s.autoExercise ? String(Math.round(s.autoExercise)) : "0";
    $("#fd-acts").textContent = s.acts.length
      ? "Automático: " + s.acts.map((a) => a.name + (a.kcal ? " " + Math.round(a.kcal) : " (sin dato)")).join(" · ")
      : "Sin actividades registradas este día.";
    // Macros: grams, share of energy, grams per kg
    const kcalMacros = MACROS.reduce((a, [k, , f]) => a + s.totals[k] * f, 0);
    const grams = { protein: s.totals.protein, carbs: s.netCarbs, fat: s.totals.fat };
    $("#fd-macros").replaceChildren(...MACROS.map(([k, label, f]) => {
      const pct = s.totals.kcal ? s.totals[k] * f / s.totals.kcal * 100 : 0;
      const share = kcalMacros ? s.totals[k] * f / kcalMacros * 100 : 0;
      return app.el("div", { class: "macro" },
        app.el("div", { class: "macro-head" }, app.el("span", {}, label), app.el("span", { class: "num" }, fmt0(grams[k]) + " g · " + fmt0(pct) + " %")),
        app.el("div", { class: "macro-bar" }, app.el("i", { class: "m-" + k, style: "width:" + Math.min(100, share) + "%" })),
        app.el("div", { class: "muted small num" }, s.perKg && s.perKg[k] != null ? fmt1(s.perKg[k]) + " g/kg" + (k === "protein" ? " de masa magra" : "") : ""));
    }));
  }

  async function renderWeek() {
    const ws = weekStart(day);
    const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
    const sums = [];
    for (const k of days) sums.push(await daySummary(k));
    const logged = sums.filter((s) => s.items > 0 && s.balance != null);
    const net = logged.reduce((a, s) => a + s.balance, 0);
    // Weigh-in of this week minus the weigh-in of the previous week
    const inRange = (from, to) => { let best = null; for (const m of window.RodilloMeasures.load()) if (m.weight && m.date >= from && m.date <= to) best = m; return best; };
    const post = inRange(ws, days[6]), pre = inRange(addDays(ws, -7), addDays(ws, -1)) || measureAt(addDays(ws, -1));
    const real = pre && post && post.date > pre.date ? (post.weight - pre.weight) * 1000 : null;
    $("#fd-week-title").textContent = "Semana del " + fmtDay(ws) + " al " + fmtDay(days[6]);
    $("#fd-week-rows").replaceChildren(...sums.map((s) => app.el("tr", { class: s.day === day ? "sel" : "", onclick: () => { day = s.day; render(); } },
      app.el("td", {}, fmtDay(s.day)),
      app.el("td", { class: "num" }, s.items ? fmt0(s.totals.kcal) : "—"),
      app.el("td", { class: "num" }, s.base != null ? fmt0(s.base + s.exercise) : "—"),
      app.el("td", { class: "num bal " + (s.balance == null || !s.items ? "" : s.balance > 0 ? "surplus" : "deficit") }, s.items && s.balance != null ? (s.balance > 0 ? "+" : "−") + fmt0(Math.abs(s.balance)) : "—"))));
    $("#fd-week-net").textContent = logged.length ? (net > 0 ? "+" : "−") + fmt0(Math.abs(net)) + " kcal (" + logged.length + " días)" : "—";
    $("#fd-week-theory").textContent = logged.length ? (net > 0 ? "+" : "−") + fmt0(Math.abs(net / 7700 * 1000)) + " g" : "—";
    $("#fd-week-real").textContent = real != null ? (real > 0 ? "+" : "−") + fmt0(Math.abs(real)) + " g (" + pre.date.slice(5).split("-").reverse().join(".") + " → " + post.date.slice(5).split("-").reverse().join(".") + ")" : "—";

    // Daily balance, last 28 days
    const end = day > keyOf(new Date()) ? day : keyOf(new Date());
    const last = Array.from({ length: 28 }, (_, i) => addDays(end, i - 27));
    const bals = [];
    for (const k of last) { const s = await daySummary(k); bals.push(s.items && s.balance != null ? s.balance : null); }
    const vals = bals.filter((v) => v != null);
    const lim = Math.max(500, ...vals.map(Math.abs)) * 1.1;
    const labels = last.map((k) => { const d = dateOf(k); return d.getDate() + " " + MONTHS[d.getMonth()]; });
    C.legend($("#fd-legend"), [{ name: "Déficit", color: css("--z2") }, { name: "Superávit", color: css("--z5") }]);
    C.mount($("#fd-chart"), {
      x: { type: "band", labels }, y: { min: -lim, max: lim, format: (v) => (v > 0 ? "+" : "") + Math.round(v) },
      refs: [{ y: 0 }],
      stacks: [
        { name: "Superávit", color: css("--z5"), values: bals.map((v) => v != null && v > 0 ? v : 0) },
        { name: "Déficit", color: css("--z2"), values: bals.map((v) => v != null && v < 0 ? v : 0) },
      ],
      tooltip: (i) => bals[i] == null ? null : "<b>" + fmtDay(last[i]) + "</b><br>" + (bals[i] > 0 ? "Superávit +" : "Déficit −") + fmt0(Math.abs(bals[i])) + " kcal",
    });
  }

  // ---------- Entry editing ----------
  function addFromBar(ev) {
    ev.preventDefault();
    const name = $("#fd-food").value.trim();
    const qty = num($("#fd-qty").value);
    if (!name) { $("#fd-food").focus(); return; }
    const f = findFood(name);
    if (!f) { app.toast("“" + name + "” no está en la base: añádelo en Base de alimentos o usa Libre.", "warn"); return; }
    if (qty == null || qty <= 0) { app.toast("Pon la cantidad (" + (f.unit || "unidades") + ").", "warn"); $("#fd-qty").focus(); return; }
    const entry = dayEntry(day);
    entry.items.push({ food: f.name, qty });
    saveDay(day, entry);
    $("#fd-food").value = ""; $("#fd-qty").value = ""; $("#fd-unit").textContent = "";
    $("#fd-food").focus();
    render();
  }

  function openItem(i) {
    const it = dayEntry(day).items[i];
    editing = { type: "item", index: i };
    if (it.libre) { openLibre(it.libre, i); return; }
    $("#fd-item-title").textContent = it.food;
    const f = findFood(it.food);
    $("#fd-item-qty-label").textContent = "Cantidad" + (f && f.unit ? " [" + f.unit + "]" : "");
    $("#fd-item-qty").value = it.qty;
    $("#fd-item").hidden = false;
  }

  function saveItem(ev) {
    ev.preventDefault();
    const qty = num($("#fd-item-qty").value);
    if (qty == null || qty < 0) { app.toast("Cantidad no válida.", "error"); return; }
    const entry = dayEntry(day);
    entry.items[editing.index].qty = qty;
    saveDay(day, entry);
    $("#fd-item").hidden = true;
    render();
  }

  function deleteItem() {
    const entry = dayEntry(day);
    entry.items.splice(editing.index, 1);
    saveDay(day, entry);
    $("#fd-item").hidden = true; $("#fd-libre").hidden = true;
    render();
  }

  function openLibre(values, index) {
    editing = index == null ? { type: "libre" } : { type: "item", index };
    $("#fd-libre-title").textContent = index == null ? "Añadir valores libres" : "Editar valores libres";
    $("#fd-libre-name").value = values ? values.name || "" : "";
    for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) $("#fd-libre-" + k).value = values && values[k] != null ? values[k] : "";
    $("#fd-libre-delete").hidden = index == null;
    $("#fd-libre").hidden = false;
    $("#fd-libre-kcal").focus();
  }

  function saveLibre(ev) {
    ev.preventDefault();
    const libre = { name: $("#fd-libre-name").value.trim() };
    for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) libre[k] = r1(num($("#fd-libre-" + k).value));
    if (libre.kcal == null) { app.toast("Pon al menos las kcal.", "error"); return; }
    const entry = dayEntry(day);
    if (editing.type === "item") entry.items[editing.index] = { libre }; else entry.items.push({ libre });
    saveDay(day, entry);
    $("#fd-libre").hidden = true;
    render();
  }

  function setExercise() {
    const entry = dayEntry(day);
    const v = num($("#fd-exercise").value);
    entry.exercise = $("#fd-exercise").value.trim() === "" ? null : v;
    saveDay(day, entry);
    renderDay(); renderWeek();
  }

  function copyPreviousDay() {
    const all = log();
    const prev = Object.keys(all).filter((k) => k < day && all[k].items.length).sort().pop();
    if (!prev) { app.toast("No hay días anteriores con comidas.", "warn"); return; }
    saveDay(day, { items: JSON.parse(JSON.stringify(all[prev].items)), exercise: null });
    app.toast("Copiado del " + fmtDay(prev) + ". Ajusta lo que cambie.");
    render();
  }

  // ---------- Food database ----------
  function renderFoodDb() {
    const q = norm($("#fd-db-search").value);
    const list = foods().filter((f) => !q || norm(f.name).includes(q));
    $("#fd-db-rows").replaceChildren(...list.map((f) => app.el("tr", { onclick: () => openFood(f) },
      app.el("td", {}, f.name), app.el("td", {}, f.unit || ""),
      ...["kcal", "protein", "carbs", "fat", "fiber"].map((k) => app.el("td", { class: "num" }, f[k] == null ? "—" : String(Math.round(f[k] * 1000) / 1000).replace(".", ","))))));
    $("#fd-db-count").textContent = list.length + " de " + foods().length + " alimentos · valores por unidad";
  }

  function openFood(f) {
    editing = { type: "food", name: f ? f.name : null };
    $("#fd-food-title").textContent = f ? "Editar alimento" : "Nuevo alimento";
    $("#fd-f-name").value = f ? f.name : $("#fd-db-search").value.trim();
    $("#fd-f-unit").value = f ? f.unit || "" : "gr";
    for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) $("#fd-f-" + k).value = f && f[k] != null ? f[k] : "";
    $("#fd-f-delete").hidden = !f;
    $("#fd-foodform").hidden = false;
  }

  function saveFood(ev) {
    ev.preventDefault();
    const f = { name: $("#fd-f-name").value.trim(), unit: $("#fd-f-unit").value.trim() };
    for (const k of ["kcal", "protein", "carbs", "fat", "fiber"]) f[k] = num($("#fd-f-" + k).value);
    if (!f.name || f.kcal == null) { app.toast("Hacen falta el nombre y las kcal por unidad.", "error"); return; }
    let list = foods().filter((x) => norm(x.name) !== norm(editing.name || f.name) && norm(x.name) !== norm(f.name));
    list.push(f);
    // Renaming a food keeps the log entries pointing at it
    if (editing.name && norm(editing.name) !== norm(f.name)) {
      const all = log();
      for (const k of Object.keys(all)) for (const it of all[k].items) if (!it.libre && norm(it.food) === norm(editing.name)) it.food = f.name;
      saveJson(LOG_KEY, all);
    }
    saveFoods(list);
    $("#fd-foodform").hidden = true;
    renderFoodDb(); render();
  }

  function deleteFood() {
    saveFoods(foods().filter((x) => norm(x.name) !== norm(editing.name)));
    $("#fd-foodform").hidden = true;
    renderFoodDb(); render();
  }

  // ---------- Import / export ----------
  async function importExcel(file) {
    try {
      const sheets = await X.read(await file.arrayBuffer());
      let nFoods = 0, nDays = 0;
      const val = (row, c) => row && row[c] ? row[c].v : null;
      // Food base
      const db = sheets.find((s) => /^db$/i.test(s.name));
      if (db) {
        const list = foods();
        for (let r = 1; r < db.rows.length; r++) {
          const row = db.rows[r];
          const name = val(row, 0);
          if (!name || /^libre$/i.test(String(name).trim()) || typeof val(row, 2) !== "number") continue;
          const f = { name: String(name).trim(), unit: val(row, 1) ? String(val(row, 1)) : "", kcal: val(row, 2), protein: val(row, 3), carbs: val(row, 4), fat: val(row, 5), fiber: val(row, 6) };
          const i = list.findIndex((x) => norm(x.name) === norm(f.name));
          if (i >= 0) list[i] = f; else list.push(f);
          nFoods++;
        }
        saveFoods(list);
      }
      // Latest year sheet (named like 2026)
      const year = sheets.filter((s) => /^\d{4}$/.test(s.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
      if (year) {
        const all = log();
        const list = foods();
        let cur = null, curKey = null;
        for (let r = 1; r < year.rows.length; r++) {
          const row = year.rows[r];
          if (!row) continue;
          const a = val(row, 0), b = val(row, 1);
          if (typeof a === "number" && a > 30000 && /alimento/i.test(String(b || ""))) {
            curKey = keyOf(X.serialToDate(a)); cur = { items: [], exercise: null };
          }
          if (!cur) continue;
          if (/^calor/i.test(String(b || ""))) {
            const ex = val(row, 10);
            cur.exercise = typeof ex === "number" ? ex : null;
            // Height and birth date come from the base-calorie formula, if not set yet
            const fj = row[9] && row[9].f;
            if (fj) {
              const dm = fj.match(/DATE\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})\)/), hm = fj.match(/height,\s*([\d.]+)/);
              if (dm && !app.settings.birthDate) app.settings.birthDate = dm[1] + "-" + dm[2].padStart(2, "0") + "-" + dm[3].padStart(2, "0");
              if (hm && !app.settings.height) app.settings.height = +hm[1];
              app.store.set("settings", app.settings);
            }
            if (cur.items.length) { all[curKey] = cur; nDays++; }
            cur = null;
            continue;
          }
          const name = val(row, 3);
          if (!name) continue;
          if (/^libre$/i.test(String(name).trim())) {
            if (typeof val(row, 4) === "number") cur.items.push({ libre: { name: "", kcal: r1(val(row, 4)), protein: r1(val(row, 5)), carbs: r1(val(row, 6)), fat: r1(val(row, 7)), fiber: r1(val(row, 8)) } });
            continue;
          }
          const qty = val(row, 2);
          if (typeof qty !== "number" || qty <= 0) continue;
          if (findFood(name, list)) cur.items.push({ food: findFood(name, list).name, qty: Math.round(qty * 1000) / 1000 });
          else if (typeof val(row, 4) === "number") cur.items.push({ libre: { name: String(name), kcal: r1(val(row, 4)), protein: r1(val(row, 5)), carbs: r1(val(row, 6)), fat: r1(val(row, 7)), fiber: r1(val(row, 8)) } });
        }
        saveJson(LOG_KEY, all);
        backup();
      }
      if (!db && !year) throw new Error("no encuentro la hoja DB ni una hoja de año (p. ej. 2026)");
      app.toast(nFoods + " alimentos y " + nDays + " días importados.");
      const days = Object.keys(log()).sort();
      if (days.length && !log()[day]) day = days[days.length - 1];
      render();
    } catch (e) {
      app.toast(file.name + ": " + (e.message || e), "error");
    }
  }

  function buildExcel() {
    const list = foods(), all = log();
    const keys = Object.keys(all).sort();
    const entryRows = [];
    for (const k of keys) for (const it of all[k].items) {
      const v = itemValues(it, list);
      const f = it.libre ? null : findFood(it.food, list);
      entryRows.push([dateOf(k), it.libre ? "libre" : "alimento", it.libre ? it.libre.name || "Libre" : it.food, it.libre ? null : it.qty, f ? f.unit : null,
        r1(v.kcal), r1(v.protein), r1(v.carbs), r1(v.fat), r1(v.fiber)]);
    }
    const dayRows = keys.map((k) => {
      const e = all[k];
      let kcal = 0;
      for (const it of e.items) kcal += itemValues(it, list).kcal || 0;
      const base = baseKcal(k);
      return [dateOf(k), r1(kcal), base != null ? Math.round(base) : null, e.exercise, base != null && e.exercise != null ? { formula: "B{r}-C{r}-D{r}", value: Math.round(kcal - base - e.exercise) } : null];
    });
    return X.write([
      { name: "comidas", columns: [{ header: "fecha", type: "date" }, { header: "tipo" }, { header: "alimento", width: 24 }, { header: "cantidad", decimals: 1 }, { header: "unidad" },
        { header: "calorias", decimals: 1 }, { header: "gr proteina", decimals: 1 }, { header: "gr carbs", decimals: 1 }, { header: "gr grasa", decimals: 1 }, { header: "gr fibra", decimals: 1 }], rows: entryRows },
      { name: "dias", columns: [{ header: "fecha", type: "date" }, { header: "calorias", decimals: 1 }, { header: "calorias sin ejercicio" , width: 20 }, { header: "calorias ejercicio", width: 18 }, { header: "balance" }], rows: dayRows },
      { name: "DB", columns: [{ header: "Alimento", width: 24 }, { header: "und" }, { header: "calorias" }, { header: "gr proteina" }, { header: "gr carbs" }, { header: "gr grasa" }, { header: "gr fibra" }],
        rows: list.map((f) => [f.name, f.unit, f.kcal, f.protein, f.carbs, f.fat, f.fiber]) },
    ]);
  }

  async function exportExcel() {
    const blob = buildExcel();
    const name = "comidas_" + keyOf(new Date()) + ".xlsx";
    const file = new File([blob], name, { type: blob.type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === "AbortError") return; }
    const a = app.el("a", { href: URL.createObjectURL(file), download: name });
    document.body.append(a); a.click(); a.remove();
  }

  let backupTimer = null;
  function backup() {
    if (!D.isConnected()) return;
    clearTimeout(backupTimer);
    backupTimer = setTimeout(async () => {
      try {
        await D.upload("datos/comidas.xlsx", new Uint8Array(await buildExcel().arrayBuffer()), { overwrite: true });
        $("#fd-backup").textContent = "Copia en Dropbox actualizada " + new Date().toLocaleTimeString("es").slice(0, 5) + ".";
      } catch (e) { $("#fd-backup").textContent = "No se pudo copiar a Dropbox: " + (e.message || e); }
    }, 2500);
  }

  // ---------- Wire up ----------
  function init(helpers) {
    app = helpers;
    $("#fd-add").addEventListener("submit", addFromBar);
    $("#fd-food").addEventListener("input", () => { const f = findFood($("#fd-food").value); $("#fd-unit").textContent = f ? f.unit || "" : ""; });
    $("#fd-prev").addEventListener("click", () => { day = addDays(day, -1); render(); });
    $("#fd-next").addEventListener("click", () => { day = addDays(day, 1); render(); });
    $("#fd-today").addEventListener("click", () => { day = keyOf(new Date()); render(); });
    $("#fd-date").addEventListener("change", () => { if ($("#fd-date").value) { day = $("#fd-date").value; render(); } });
    $("#fd-libre-open").addEventListener("click", () => openLibre(null, null));
    $("#fd-libre-form").addEventListener("submit", saveLibre);
    $("#fd-libre-cancel").addEventListener("click", () => { $("#fd-libre").hidden = true; });
    $("#fd-libre-delete").addEventListener("click", deleteItem);
    $("#fd-item-form").addEventListener("submit", saveItem);
    $("#fd-item-cancel").addEventListener("click", () => { $("#fd-item").hidden = true; });
    $("#fd-item-delete").addEventListener("click", deleteItem);
    $("#fd-exercise").addEventListener("change", setExercise);
    $("#fd-copy").addEventListener("click", copyPreviousDay);
    $("#fd-db-open").addEventListener("click", () => { $("#fd-db-search").value = ""; renderFoodDb(); $("#fd-db").hidden = false; });
    $("#fd-db-close").addEventListener("click", () => { $("#fd-db").hidden = true; });
    $("#fd-db-search").addEventListener("input", renderFoodDb);
    $("#fd-db-new").addEventListener("click", () => openFood(null));
    $("#fd-food-form").addEventListener("submit", saveFood);
    $("#fd-f-cancel").addEventListener("click", () => { $("#fd-foodform").hidden = true; });
    $("#fd-f-delete").addEventListener("click", deleteFood);
    for (const id of ["#fd-import", "#fd-import-empty"]) $(id).addEventListener("change", (e) => { if (e.target.files[0]) importExcel(e.target.files[0]); e.target.value = ""; });
    $("#fd-export").addEventListener("click", exportExcel);
  }

  window.RodilloFood = { init, render, baseKcal };
})();
