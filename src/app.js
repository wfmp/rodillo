/* Rodillo app: workout library, live ERG session, recording and FIT export. */
(function () {
  "use strict";

  const W = window.RodilloWorkouts;
  const F = window.RodilloFit;
  const B = window.RodilloBle;
  const PLAN = window.RODILLO_PLAN || [];

  const ZONE_VARS = ["--z1", "--z2", "--z3", "--z4", "--z5", "--z6"];
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  };

  // ---------- Storage helpers (best effort) ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("rodillo." + key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem("rodillo." + key, JSON.stringify(value)); } catch (e) { /* ignore */ } },
    remove(key) { try { localStorage.removeItem("rodillo." + key); } catch (e) { /* ignore */ } },
  };

  const settings = Object.assign({ ftp: 165, weight: 72, simulator: false, sounds: true, autoPause: true },
    store.get("settings", {}));

  // ---------- State ----------
  const live = { power: null, cadence: null, speedKmh: null, hr: null, powerAt: 0, hrAt: 0, power3s: [] };
  const devices = { trainer: null, hr: null };
  let ride = null; // active session
  let lastSummary = null;
  let toastTimer = null;

  // ---------- Formatting ----------
  const fmtTime = (s) => {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(sec).padStart(2, "0");
  };

  /** Turn "2026-10-26_W1_B_VO2_4x3" into display parts. */
  function describeWorkout(w) {
    const m = w.name.match(/^(\d{4})-(\d{2})-(\d{2})_W(\d)_([A-Z]+)_(.+)$/);
    if (!m) return { date: null, week: null, kind: null, title: w.name.replace(/_/g, " ") };
    const kindNames = { A: "Anaeróbica", B: "VO2max", C: "Sweet spot", FTP: "Test" };
    const title = m[6].replace(/_/g, " ").replace(/(\d)x(\d)/g, "$1×$2")
      .replace(/^Anaerobic/, "Anaeróbica").replace(/^Repeated/, "Repetidos").replace(/^SweetSpot/, "Sweet spot")
      .replace(/Sprints/, "+ sprints").replace(/Short/, "corta").replace(/^Test/, "Test FTP").replace(/^VO2/, "VO2max");
    return {
      date: new Date(+m[1], +m[2] - 1, +m[3]), week: +m[4], kind: m[5], kindName: kindNames[m[5]] || m[5], title,
    };
  }

  function estimateTss(w) {
    const samples = [];
    const total = W.totalDuration(w);
    for (let t = 0; t < total; t++) samples.push({ power: W.targetWattsAt(w, t, settings.ftp, 1) });
    return W.rideStats(samples, settings.ftp).tss;
  }

  function zoneColor(pct) { return css(ZONE_VARS[W.zoneForPct(pct) - 1]); }

  // ---------- Toast ----------
  function toast(msg, kind) {
    const t = $("#toast");
    t.textContent = msg;
    t.dataset.kind = kind || "info";
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
  }

  // ---------- Profile drawing ----------
  function drawProfile(canvas, w, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(10, rect.width), height = Math.max(10, rect.height);
    canvas.width = width * dpr; canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const total = W.totalDuration(w);
    const ftp = settings.ftp;
    const intensity = opts.intensity || 1;
    let maxW = ftp * 1.6;
    for (const seg of w.segments) for (const v of W.segmentWatts(w, seg, ftp)) maxW = Math.max(maxW, v * intensity * 1.1);
    if (opts.samples) for (const s of opts.samples) if (s.power) maxW = Math.max(maxW, s.power * 1.05);
    const padTop = opts.compact ? 2 : 8, padBottom = opts.compact ? 0 : 16;
    const plotH = height - padTop - padBottom;
    const x = (t) => (t / total) * width;
    const y = (watts) => padTop + plotH - (watts / maxW) * plotH;

    if (!opts.compact) {
      // FTP reference line and label
      ctx.strokeStyle = css("--grid"); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(0, y(ftp)); ctx.lineTo(width, y(ftp)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--font-ui");
      ctx.fillText("FTP " + ftp + " W", 4, y(ftp) - 4);
    }

    // Target blocks colored by zone
    let acc = 0;
    for (const seg of w.segments) {
      const [w0, w1] = W.segmentWatts(w, seg, ftp).map((v) => v * intensity);
      const pctMid = ((w0 + w1) / 2) / ftp * 100;
      ctx.fillStyle = zoneColor(pctMid);
      ctx.globalAlpha = opts.samples ? 0.38 : 0.9;
      ctx.beginPath();
      ctx.moveTo(x(acc), y(0)); ctx.lineTo(x(acc), y(w0)); ctx.lineTo(x(acc + seg[0]), y(w1)); ctx.lineTo(x(acc + seg[0]), y(0));
      ctx.closePath(); ctx.fill();
      acc += seg[0];
    }
    ctx.globalAlpha = 1;

    if (opts.samples && opts.samples.length) {
      // Heart rate trace on its own scale (50-200 bpm)
      const hrY = (hr) => padTop + plotH - ((hr - 50) / 150) * plotH;
      ctx.strokeStyle = css("--hr"); ctx.lineWidth = 1.5; ctx.beginPath();
      let started = false;
      opts.samples.forEach((s, i) => {
        if (!s.hr) return;
        if (!started) { ctx.moveTo(x(s.t ?? i), hrY(s.hr)); started = true; } else ctx.lineTo(x(s.t ?? i), hrY(s.hr));
      });
      ctx.stroke();
      // Power trace (3 s smoothed)
      ctx.strokeStyle = css("--fg"); ctx.lineWidth = 1.6; ctx.beginPath();
      let win = [];
      opts.samples.forEach((s, i) => {
        win.push(s.power || 0); if (win.length > 3) win.shift();
        const p = win.reduce((a, b) => a + b, 0) / win.length;
        if (i === 0) ctx.moveTo(x(s.t ?? i), y(p)); else ctx.lineTo(x(s.t ?? i), y(p));
      });
      ctx.stroke();
    }

    if (opts.cursor != null) {
      ctx.strokeStyle = css("--fg"); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x(opts.cursor), padTop); ctx.lineTo(x(opts.cursor), y(0)); ctx.stroke();
    }

    if (!opts.compact) {
      ctx.fillStyle = css("--muted"); ctx.font = "11px " + css("--font-ui");
      const step = total > 3600 ? 900 : 600;
      for (let t = step; t < total; t += step) ctx.fillText(Math.round(t / 60) + "′", x(t) - 8, height - 3);
    }
  }

  // ---------- Library ----------
  function allWorkouts() {
    const imported = store.get("imported", []);
    return PLAN.map((w) => Object.assign({ unit: "pct", source: "plan" }, w))
      .concat(imported.map((w) => Object.assign({ source: "import" }, w)));
  }

  function renderLibrary() {
    const list = $("#workout-list");
    list.replaceChildren();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const workouts = allWorkouts();
    let nextMarked = false;
    for (const w of workouts) {
      const d = describeWorkout(w);
      const total = W.totalDuration(w);
      let badge = null, state = "";
      if (d.date) {
        if (d.date.getTime() === today.getTime()) { badge = "Hoy"; state = "today"; nextMarked = true; }
        else if (d.date < today) state = "past";
        else if (!nextMarked) { badge = "Próxima"; state = "next"; nextMarked = true; }
      }
      const canvas = el("canvas", { class: "mini-profile", "aria-hidden": "true" });
      const meta = el("div", { class: "card-meta" },
        el("span", {}, fmtTime(total)),
        el("span", {}, "TSS ≈ " + Math.round(estimateTss(w))),
        w.unit === "watts" ? el("span", {}, "vatios fijos") : el("span", {}, "% FTP"));
      const dateLabel = d.date
        ? d.date.toLocaleDateString("es-CH", { weekday: "short", day: "numeric", month: "short" }) + " · Semana " + d.week
        : (w.source === "import" ? "Importado" : "");
      const actions = el("div", { class: "card-actions" },
        el("button", { class: "btn primary", onclick: () => startRide(w) }, "Empezar"));
      if (w.source === "import") {
        actions.append(el("button", { class: "btn ghost", onclick: () => removeImported(w.id) }, "Quitar"));
      }
      const card = el("article", { class: "workout-card " + state },
        el("div", { class: "card-head" },
          el("div", { class: "card-date" }, dateLabel, badge ? el("span", { class: "badge" }, badge) : null),
          d.kind ? el("span", { class: "kind kind-" + d.kind }, d.kindName) : null),
        el("h3", {}, d.title),
        w.description ? el("p", { class: "card-desc" }, w.description) : null,
        canvas, meta, actions);
      list.append(card);
      requestAnimationFrame(() => drawProfile(canvas, w, { compact: true }));
      if (state === "today" || state === "next") card.dataset.focus = "1";
    }
    const focus = list.querySelector('[data-focus="1"]');
    if (focus) setTimeout(() => focus.scrollIntoView({ block: "nearest", inline: "start" }), 50);
  }

  function removeImported(id) {
    store.set("imported", store.get("imported", []).filter((w) => w.id !== id));
    renderLibrary();
  }

  async function importFiles(files) {
    const imported = store.get("imported", []);
    let ok = 0;
    for (const file of files) {
      try {
        const w = W.parseWorkoutFile(file.name, await file.text());
        const i = imported.findIndex((x) => x.id === w.id);
        if (i >= 0) imported[i] = w; else imported.push(w);
        ok++;
      } catch (e) {
        toast(file.name + ": " + e.message, "error");
      }
    }
    store.set("imported", imported);
    if (ok) toast(ok === 1 ? "Entreno importado." : ok + " entrenos importados.");
    renderLibrary();
  }

  function manualErgWorkout() {
    return { id: "manual-erg", name: "ERG manual", description: "Potencia fija que ajustas con − y +.",
      unit: "watts", segments: [[4 * 3600, Math.round(settings.ftp * 0.6), Math.round(settings.ftp * 0.6)]], manual: true };
  }

  // ---------- Devices ----------
  function setChip(kind, state, label) {
    const chip = $("#chip-" + kind);
    chip.dataset.state = state;
    chip.querySelector(".chip-label").textContent = label;
  }

  function wireTrainer(dev) {
    dev.on("connected", (info) => {
      setChip("trainer", "on", info.name + (info.canControl ? " · ERG" : " · solo lectura"));
      if (ride && ride.target != null) dev.setTargetPower(ride.target);
    });
    dev.on("disconnected", () => setChip("trainer", "warn", "Reconectando…"));
    dev.on("warning", (msg) => toast(msg, "warn"));
    dev.on("data", (d) => {
      const now = Date.now();
      if (d.power != null) { live.power = d.power; live.powerAt = now; }
      if (d.cadence != null) live.cadence = d.cadence;
      if (d.speedKmh != null) live.speedKmh = d.speedKmh;
      if (d.hr && (!devices.hr || now - live.hrAt > 3000)) { live.hr = d.hr; live.hrAt = now; }
      updateLiveReadouts();
    });
  }

  async function connectTrainer() {
    try {
      if (settings.simulator) {
        if (devices.trainer) devices.trainer.disconnect();
        const sim = new B.SimulatedRig(settings.ftp);
        devices.trainer = sim; wireTrainer(sim);
        await sim.connect();
        return;
      }
      if (!B.bluetoothAvailable()) {
        toast("Este navegador no tiene Bluetooth. En el Mac abre la página en Chrome (Safari no sirve); en iPhone o iPad, en Bluefy.", "error");
        return;
      }
      setChip("trainer", "warn", "Buscando…");
      const t = new B.Trainer();
      wireTrainer(t);
      await t.connect();
      devices.trainer = t;
    } catch (e) {
      setChip("trainer", "off", "Rodillo");
      if (e && e.name !== "NotFoundError") toast("No se pudo conectar el rodillo: " + e.message, "error");
    }
  }

  async function connectHr() {
    try {
      if (!B.bluetoothAvailable()) {
        toast("Este navegador no tiene Bluetooth. En el Mac abre la página en Chrome (Safari no sirve); en iPhone o iPad, en Bluefy.", "error");
        return;
      }
      setChip("hr", "warn", "Buscando…");
      const h = new B.HeartRateSensor();
      h.on("connected", (info) => setChip("hr", "on", info.name));
      h.on("disconnected", () => setChip("hr", "warn", "Reconectando…"));
      h.on("data", (d) => { live.hr = d.hr; live.hrAt = Date.now(); updateLiveReadouts(); });
      await h.connect();
      devices.hr = h;
    } catch (e) {
      setChip("hr", "off", "Pulso");
      if (e && e.name !== "NotFoundError") toast("No se pudo conectar el pulso: " + e.message, "error");
    }
  }

  function setTarget(watts) {
    if (!ride) return;
    ride.target = watts;
    if (devices.trainer && watts != null) devices.trainer.setTargetPower(watts);
  }

  // ---------- Sound cues ----------
  let audioCtx = null;
  function beep(freq, ms) {
    if (!settings.sounds) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
      osc.frequency.value = freq; osc.connect(gain); gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + ms / 1000);
      osc.start(); osc.stop(audioCtx.currentTime + ms / 1000);
    } catch (e) { /* audio is optional */ }
  }

  // ---------- Wake lock ----------
  let wakeLock = null;
  async function keepAwake() {
    try { if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen"); } catch (e) { /* optional */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ride && !ride.finished) keepAwake();
  });

  // ---------- Ride session ----------
  function showView(name) {
    for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== "view-" + name;
    document.body.dataset.view = name;
  }

  function startRide(workout, resumeData) {
    if (!devices.trainer && !resumeData) {
      toast("Conecta primero el rodillo (o activa el simulador en Ajustes).", "warn");
      return;
    }
    if (audioCtx == null && settings.sounds) beep(660, 1); // unlock audio from this tap
    ride = Object.assign({
      workout, t: 0, intensity: 1, paused: true, started: false, samples: [], pauses: [],
      startedAt: null, target: null, lastSegment: -1, autoPaused: false, idleSeconds: 0, finished: false,
      distance: 0, manualWatts: workout.manual ? workout.segments[0][1] : null,
    }, resumeData || {});
    ride.workout = workout;
    $("#ride-title").textContent = describeWorkout(workout).title;
    showView("ride");
    keepAwake();
    updateRideUi();
    setTarget(currentTarget());
    if (!ride.timer) ride.timer = setInterval(rideTick, 1000);
  }

  function currentTarget() {
    if (!ride) return null;
    if (ride.workout.manual) return ride.manualWatts;
    const tw = W.targetWattsAt(ride.workout, Math.min(ride.t, W.totalDuration(ride.workout) - 1), settings.ftp, ride.intensity);
    return tw;
  }

  function togglePause() {
    if (!ride) return;
    if (ride.paused) {
      if (!ride.started) { ride.started = true; ride.startedAt = Date.now() / 1000; beep(880, 150); }
      else if (ride.pauseStart) { ride.pauses.push({ start: ride.pauseStart, end: Date.now() / 1000 }); ride.pauseStart = null; }
      ride.paused = false; ride.autoPaused = false;
    } else {
      ride.paused = true; ride.pauseStart = Date.now() / 1000;
    }
    updateRideUi();
  }

  function rideTick() {
    if (!ride || ride.finished) return;
    const now = Date.now();
    const total = W.totalDuration(ride.workout);
    const powerFresh = now - live.powerAt < 3000;
    const pedaling = powerFresh && ((live.cadence || 0) > 15 || (live.power || 0) > 20);

    // Auto-pause / auto-resume once the session has started
    if (ride.started && settings.autoPause) {
      if (!ride.paused && !pedaling) {
        ride.idleSeconds++;
        if (ride.idleSeconds >= 5) { ride.paused = true; ride.autoPaused = true; ride.pauseStart = now / 1000 - 5; toast("Pausa automática: no detecto pedaleo."); }
      } else if (ride.paused && ride.autoPaused && pedaling) {
        ride.pauses.push({ start: ride.pauseStart, end: now / 1000 }); ride.pauseStart = null;
        ride.paused = false; ride.autoPaused = false; ride.idleSeconds = 0;
      } else if (pedaling) ride.idleSeconds = 0;
    }

    if (!ride.paused) {
      const speed = live.speedKmh != null && powerFresh ? live.speedKmh / 3.6 : 0;
      ride.distance += speed;
      ride.samples.push({
        t: ride.t, ts: Math.floor(now / 1000),
        power: powerFresh ? Math.max(0, Math.round(live.power || 0)) : 0,
        hr: now - live.hrAt < 5000 ? live.hr : null,
        cadence: powerFresh && live.cadence != null ? Math.round(live.cadence) : null,
        speed, distance: ride.distance, target: ride.target,
      });
      ride.t++;
      // Countdown beeps before an interval change
      const loc = W.segmentAt(ride.workout, ride.t);
      if (loc && !ride.workout.manual) {
        const remaining = loc.segEnd - ride.t;
        if (remaining <= 3 && remaining >= 1) beep(remaining === 1 ? 990 : 660, 120);
        if (loc.index !== ride.lastSegment) { ride.lastSegment = loc.index; }
      }
      if (!ride.workout.manual && ride.t >= total) { finishRide(); return; }
      if (ride.t % 15 === 0) autosave();
    }
    setTarget(currentTarget());
    updateRideUi();
  }

  function adjustIntensity(deltaPct) {
    if (!ride) return;
    if (ride.workout.manual) {
      ride.manualWatts = Math.max(30, ride.manualWatts + (deltaPct > 0 ? 5 : -5));
    } else {
      ride.intensity = Math.max(0.5, Math.min(1.5, Math.round((ride.intensity + deltaPct / 100) * 100) / 100));
    }
    setTarget(currentTarget());
    updateRideUi();
  }

  function skipSegment() {
    if (!ride || ride.workout.manual) return;
    const loc = W.segmentAt(ride.workout, ride.t);
    if (!loc) return;
    // Move the workout clock to the next segment; recorded samples stay untouched
    ride.t = loc.segEnd;
    if (ride.t >= W.totalDuration(ride.workout)) { finishRide(); return; }
    setTarget(currentTarget());
    updateRideUi();
  }

  function updateLiveReadouts() {
    if (!ride) return;
    const now = Date.now();
    live.power3s.push({ at: now, p: live.power || 0 });
    while (live.power3s.length && now - live.power3s[0].at > 3000) live.power3s.shift();
  }

  function updateRideUi() {
    if (!ride) return;
    const w = ride.workout;
    const total = w.manual ? null : W.totalDuration(w);
    const now = Date.now();
    const powerFresh = now - live.powerAt < 3000;
    const p3 = live.power3s.length ? Math.round(live.power3s.reduce((a, b) => a + b.p, 0) / live.power3s.length) : null;
    const target = ride.target;

    $("#m-power").textContent = powerFresh && p3 != null ? p3 : "—";
    $("#m-target").textContent = target != null ? target : "—";
    $("#m-hr").textContent = now - live.hrAt < 5000 && live.hr ? live.hr : "—";
    $("#m-cadence").textContent = powerFresh && live.cadence != null ? Math.round(live.cadence) : "—";

    const pct = target ? target / settings.ftp * 100 : 0;
    document.documentElement.style.setProperty("--zone", zoneColor(pct || 50));
    $("#m-target-pct").textContent = target ? Math.round(pct) + " % FTP" : "";
    const diff = powerFresh && p3 != null && target ? p3 - target : null;
    const powerBox = $("#box-power");
    powerBox.dataset.delta = diff == null ? "" : Math.abs(diff) <= Math.max(10, target * 0.05) ? "ok" : diff > 0 ? "high" : "low";

    $("#m-elapsed").textContent = fmtTime(ride.samples.length);
    $("#m-intensity").textContent = w.manual ? ride.manualWatts + " W" : Math.round(ride.intensity * 100) + " %";

    if (!w.manual) {
      const loc = W.segmentAt(w, Math.min(ride.t, total - 1));
      const seg = w.segments[loc.index];
      const [w0, w1] = W.segmentWatts(w, seg, settings.ftp).map((v) => Math.round(v * ride.intensity));
      $("#seg-countdown").textContent = fmtTime(loc.segEnd - ride.t);
      $("#seg-label").textContent = "Bloque " + (loc.index + 1) + "/" + w.segments.length + " · " + (w0 === w1 ? w0 + " W" : w0 + "→" + w1 + " W");
      const next = w.segments[loc.index + 1];
      if (next) {
        const [n0, n1] = W.segmentWatts(w, next, settings.ftp).map((v) => Math.round(v * ride.intensity));
        $("#seg-next").textContent = "Después: " + fmtTime(next[0]) + " a " + (n0 === n1 ? n0 + " W" : n0 + "→" + n1 + " W");
      } else $("#seg-next").textContent = "Último bloque";
      $("#m-remaining").textContent = fmtTime(total - ride.t);
    } else {
      $("#seg-countdown").textContent = fmtTime(ride.samples.length);
      $("#seg-label").textContent = "ERG manual";
      $("#seg-next").textContent = "Ajusta la potencia con − y +";
      $("#m-remaining").textContent = "—";
    }

    const stats = W.rideStats(ride.samples, settings.ftp);
    $("#m-np").textContent = ride.samples.length >= 30 ? stats.np : "—";
    $("#m-kj").textContent = stats.kj;
    $("#m-tss").textContent = stats.tss.toFixed(0);

    const btn = $("#btn-pause");
    btn.textContent = !ride.started ? "Empezar" : ride.paused ? "Seguir" : "Pausa";
    btn.classList.toggle("primary", ride.paused);
    $("#ride-status").textContent = !ride.started ? "Listo para empezar: pulsa Empezar y pedalea."
      : ride.autoPaused ? "Pausa automática: empieza a pedalear para seguir."
      : ride.paused ? "En pausa" : "";

    if (!w.manual) drawProfile($("#ride-profile"), w, { samples: ride.samples, cursor: ride.t, intensity: ride.intensity });
  }

  function autosave() {
    if (!ride || !ride.samples.length) return;
    store.set("recovery", {
      workout: ride.workout, t: ride.t, intensity: ride.intensity, samples: ride.samples, pauses: ride.pauses,
      started: true, startedAt: ride.startedAt, distance: ride.distance, manualWatts: ride.manualWatts, savedAt: Date.now(),
    });
  }

  function finishRide() {
    if (!ride) return;
    clearInterval(ride.timer); ride.timer = null;
    ride.finished = true;
    if (ride.pauseStart) { ride.pauses.push({ start: ride.pauseStart, end: null }); ride.pauseStart = null; }
    if (devices.trainer) devices.trainer.setTargetPower(Math.round(settings.ftp * 0.4));
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    if (!ride.samples.length) { ride = null; store.remove("recovery"); showView("library"); return; }
    autosave();
    lastSummary = buildSummary(ride);
    renderSummary(lastSummary);
    showView("summary");
  }

  function buildSummary(r) {
    const stats = W.rideStats(r.samples, settings.ftp);
    const startTs = r.samples[0].ts;
    const d = new Date(startTs * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "_" + pad(d.getHours()) + pad(d.getMinutes());
    const shortName = r.workout.name.replace(/^\d{4}-\d{2}-\d{2}_/, "").replace(/[^\w.-]+/g, "_");
    return { ride: r, stats, fileName: stamp + "_" + shortName + ".fit" };
  }

  function renderSummary(sum) {
    const s = sum.stats;
    const grid = $("#summary-grid");
    grid.replaceChildren();
    const items = [
      ["Tiempo", fmtTime(s.timerSeconds)], ["Potencia media", s.avgPower + " W"], ["NP", s.np + " W"],
      ["IF", s.if.toFixed(2)], ["TSS", s.tss.toFixed(0)], ["Trabajo", s.kj + " kJ"],
      ["Pulso medio", s.avgHr ? s.avgHr + " ppm" : "—"], ["Pulso máx.", s.maxHr ? s.maxHr + " ppm" : "—"],
      ["Cadencia media", s.avgCadence ? s.avgCadence + " rpm" : "—"], ["Potencia máx.", s.maxPower + " W"],
    ];
    for (const [k, v] of items) grid.append(el("div", { class: "stat" }, el("span", { class: "stat-k" }, k), el("span", { class: "stat-v" }, v)));
    $("#summary-title").textContent = describeWorkout(sum.ride.workout).title;
    $("#summary-file").textContent = sum.fileName;
    if (!sum.ride.workout.manual) {
      requestAnimationFrame(() => drawProfile($("#summary-profile"), sum.ride.workout,
        { samples: sum.ride.samples, intensity: sum.ride.intensity }));
    }
  }

  async function saveFit() {
    if (!lastSummary) return;
    const r = lastSummary.ride;
    const bytes = F.buildActivityFit(r.samples.map((s) => s), r.pauses,
      Object.assign({ ftp: settings.ftp }, lastSummary.stats));
    const blob = new Blob([bytes], { type: "application/vnd.ant.fit" });
    const file = new File([blob], lastSummary.fileName, { type: "application/octet-stream" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: lastSummary.fileName });
        toast("Archivo listo. Guárdalo en Dropbox o en Archivos.");
        return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;
    }
    const a = el("a", { href: URL.createObjectURL(blob), download: lastSummary.fileName });
    document.body.append(a); a.click(); a.remove();
    toast("Archivo descargado: " + lastSummary.fileName);
  }

  function discardRide() {
    store.remove("recovery");
    ride = null; lastSummary = null;
    showView("library");
    renderLibrary();
  }

  // ---------- Settings ----------
  function openSettings() {
    $("#set-ftp").value = settings.ftp;
    $("#set-weight").value = settings.weight;
    $("#set-sim").checked = settings.simulator;
    $("#set-sounds").checked = settings.sounds;
    $("#set-autopause").checked = settings.autoPause;
    $("#settings").hidden = false;
  }
  function saveSettings(ev) {
    ev.preventDefault();
    const ftp = parseInt($("#set-ftp").value, 10);
    if (!(ftp >= 50 && ftp <= 600)) { toast("El FTP tiene que estar entre 50 y 600 W.", "error"); return; }
    settings.ftp = ftp;
    settings.weight = parseFloat($("#set-weight").value) || settings.weight;
    settings.simulator = $("#set-sim").checked;
    settings.sounds = $("#set-sounds").checked;
    settings.autoPause = $("#set-autopause").checked;
    store.set("settings", settings);
    $("#settings").hidden = true;
    $("#ftp-label").textContent = "FTP " + settings.ftp + " W";
    renderLibrary();
    toast("Ajustes guardados.");
  }

  // ---------- Recovery ----------
  function checkRecovery() {
    const rec = store.get("recovery", null);
    if (!rec || !rec.samples || !rec.samples.length) return;
    const ago = Math.round((Date.now() - rec.savedAt) / 60000);
    const banner = $("#recovery");
    $("#recovery-text").textContent = "Hay una sesión sin guardar de " + describeWorkout(rec.workout).title +
      " (" + fmtTime(rec.samples.length) + ", hace " + ago + " min).";
    banner.hidden = false;
    $("#recovery-summary").onclick = () => {
      banner.hidden = true;
      ride = Object.assign({ finished: true }, rec);
      lastSummary = buildSummary(ride);
      renderSummary(lastSummary);
      showView("summary");
    };
    $("#recovery-resume").onclick = () => {
      banner.hidden = true;
      startRide(rec.workout, Object.assign({}, rec, { paused: true, started: true, pauseStart: Date.now() / 1000 }));
    };
    $("#recovery-discard").onclick = () => { banner.hidden = true; store.remove("recovery"); };
  }

  // ---------- Wire up ----------
  function init() {
    $("#ftp-label").textContent = "FTP " + settings.ftp + " W";
    $("#chip-trainer").addEventListener("click", connectTrainer);
    $("#chip-hr").addEventListener("click", connectHr);
    $("#btn-settings").addEventListener("click", openSettings);
    $("#settings-form").addEventListener("submit", saveSettings);
    $("#settings-cancel").addEventListener("click", () => { $("#settings").hidden = true; });
    $("#import-input").addEventListener("change", (e) => { importFiles([...e.target.files]); e.target.value = ""; });
    $("#btn-manual").addEventListener("click", () => startRide(manualErgWorkout()));
    $("#btn-pause").addEventListener("click", togglePause);
    $("#btn-minus").addEventListener("click", () => adjustIntensity(-5));
    $("#btn-plus").addEventListener("click", () => adjustIntensity(5));
    $("#btn-skip").addEventListener("click", skipSegment);
    $("#btn-finish").addEventListener("click", () => {
      const c = $("#confirm-finish");
      c.hidden = !c.hidden;
    });
    $("#btn-finish-yes").addEventListener("click", () => { $("#confirm-finish").hidden = true; finishRide(); });
    $("#btn-finish-no").addEventListener("click", () => { $("#confirm-finish").hidden = true; });
    $("#btn-save").addEventListener("click", saveFit);
    $("#btn-discard").addEventListener("click", () => { $("#confirm-discard").hidden = false; });
    $("#btn-discard-yes").addEventListener("click", discardRide);
    $("#btn-discard-no").addEventListener("click", () => { $("#confirm-discard").hidden = true; });
    $("#btn-done").addEventListener("click", () => { store.remove("recovery"); ride = null; showView("library"); renderLibrary(); });
    $("#toast").addEventListener("click", () => { $("#toast").hidden = true; });
    window.addEventListener("resize", () => {
      if (document.body.dataset.view === "library") renderLibrary();
      else if (ride) updateRideUi();
    });
    if (!B.bluetoothAvailable()) $("#bt-hint").hidden = false;
    showView("library");
    renderLibrary();
    checkRecovery();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
