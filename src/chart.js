/* Small canvas chart helper: stacked bars, lines, bands and reference lines on one y axis, with tap/hover tooltips. */
(function (root) {
  "use strict";

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  function roundedTop(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, Math.abs(h));
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
  }

  /**
   * spec:
   *  x: {type: "band", labels: [...]} | {type: "linear"|"log", min, max, ticks: [{v, label}]}
   *  y: {min, max, format(v), ticks?}
   *  stacks: [{name, color, values: [] per band}]   (band x only)
   *  lines: [{name, color, values: [] per band | points: [[x, y]], width, dash}]
   *  bands: [{y0, y1, color}]  horizontal shaded ranges
   *  refs: [{y, label}]        dashed reference lines
   *  tooltip(i | {x}) -> html  (i = band index; for numeric x, the nearest point of the first line)
   */
  function draw(canvas, spec) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(10, rect.width), H = Math.max(10, rect.height);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const colors = { grid: css("--line") || "#2a333d", muted: css("--muted") || "#8a97a5", fg: css("--fg") || "#eef2f5", surface: css("--panel") || "#161c22" };
    const yFmt = spec.y.format || ((v) => String(Math.round(v)));
    ctx.font = "12px " + (css("--font-ui") || "system-ui");

    // Y scale and ticks
    let yMin = spec.y.min, yMax = spec.y.max;
    if (yMax <= yMin) yMax = yMin + 1;
    const step = spec.y.step || niceStep(yMax - yMin, Math.max(2, Math.floor(H / 48)));
    const yTicks = spec.y.ticks || [];
    if (!spec.y.ticks) for (let v = Math.ceil(yMin / step) * step; v <= yMax + 1e-9; v += step) yTicks.push(v);
    const labelW = Math.max(...yTicks.map((v) => ctx.measureText(yFmt(v)).width), 10);
    const m = { l: Math.ceil(labelW) + 10, r: 10, t: 8, b: 22 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const ys = (v) => m.t + ph - (v - yMin) / (yMax - yMin) * ph;

    // X scale
    const band = spec.x.type === "band";
    const n = band ? spec.x.labels.length : 0;
    const bw = band ? pw / Math.max(1, n) : 0;
    const xs = band ? (i) => m.l + bw * (i + 0.5)
      : spec.x.type === "log" ? (v) => m.l + (Math.log(v) - Math.log(spec.x.min)) / (Math.log(spec.x.max) - Math.log(spec.x.min)) * pw
      : (v) => m.l + (v - spec.x.min) / (spec.x.max - spec.x.min) * pw;

    // Bands and grid
    for (const b of spec.bands || []) {
      ctx.fillStyle = b.color;
      const y0 = ys(Math.min(yMax, b.y1)), y1 = ys(Math.max(yMin, b.y0));
      ctx.fillRect(m.l, y0, pw, y1 - y0);
    }
    ctx.strokeStyle = colors.grid; ctx.lineWidth = 1; ctx.fillStyle = colors.muted;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (const v of yTicks) {
      const y = Math.round(ys(v)) + 0.5;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(W - m.r, y); ctx.stroke();
      ctx.fillText(yFmt(v), m.l - 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    if (band) {
      const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 52))));
      spec.x.labels.forEach((lab, i) => { if ((n - 1 - i) % every === 0) ctx.fillText(lab, xs(i), H - m.b + 6); });
    } else {
      for (const t of spec.x.ticks || []) ctx.fillText(t.label, xs(t.v), H - m.b + 6);
    }

    // Stacked bars (2px surface gap between segments, rounded data end)
    if (band && spec.stacks) {
      const barW = Math.max(2, Math.min(36, bw * 0.62));
      for (let i = 0; i < n; i++) {
        let acc = 0;
        const segs = spec.stacks.map((s) => ({ s, v: s.values[i] || 0 })).filter((x) => x.v > 0);
        segs.forEach((seg, k) => {
          const yBottom = ys(acc), yTop = ys(acc + seg.v);
          acc += seg.v;
          const last = k === segs.length - 1;
          const top = last ? yTop : yTop + 2; // 2px surface gap above every lower segment
          const h = yBottom - top;
          if (h <= 0.5) return;
          ctx.fillStyle = seg.s.color;
          if (last) { roundedTop(ctx, xs(i) - barW / 2, top, barW, h, 4); ctx.fill(); }
          else ctx.fillRect(xs(i) - barW / 2, top, barW, h);
        });
      }
    }

    // Reference lines
    ctx.setLineDash([4, 4]); ctx.strokeStyle = colors.muted; ctx.lineWidth = 1;
    for (const r of spec.refs || []) {
      const y = Math.round(ys(r.y)) + 0.5;
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(W - m.r, y); ctx.stroke();
      if (r.label) { ctx.textAlign = "left"; ctx.textBaseline = "bottom"; ctx.fillStyle = colors.muted; ctx.fillText(r.label, m.l + 4, y - 2); }
    }
    ctx.setLineDash([]);

    // Lines
    for (const l of spec.lines || []) {
      ctx.strokeStyle = l.color; ctx.lineWidth = l.width || 2; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.setLineDash(l.dash || []);
      ctx.beginPath();
      let started = false;
      const pts = l.points || l.values.map((v, i) => [i, v]);
      for (const [x, y] of pts) {
        if (y == null || Number.isNaN(y)) { started = false; continue; }
        const px = band ? xs(x) : xs(x), py = ys(Math.max(yMin, Math.min(yMax, y)));
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (l.markers) {
        for (const [x, y] of pts) {
          if (y == null) continue;
          ctx.beginPath(); ctx.arc(xs(x), ys(y), 4, 0, Math.PI * 2);
          ctx.fillStyle = l.color; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = colors.surface; ctx.stroke();
        }
      }
    }

    // Crosshair for the active item
    if (spec.active != null) {
      const ax = band ? xs(spec.active) : xs(spec.active);
      ctx.strokeStyle = colors.fg; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(ax) + 0.5, m.t); ctx.lineTo(Math.round(ax) + 0.5, m.t + ph); ctx.stroke();
      ctx.globalAlpha = 1;
    }

    return { m, pw, ph, xs, ys, bw, n, band };
  }

  /** Draw and attach a tooltip; returns a redraw function. */
  function mount(canvas, spec) {
    const holder = canvas.parentElement;
    let tip = holder.querySelector(".chart-tip");
    if (!tip) { tip = document.createElement("div"); tip.className = "chart-tip"; tip.hidden = true; holder.append(tip); }
    let geo = draw(canvas, spec);
    const xValues = () => {
      const l = (spec.lines || [])[0];
      return l && l.points ? l.points.map((p) => p[0]) : [];
    };
    function pick(ev) {
      const r = canvas.getBoundingClientRect();
      const px = ev.clientX - r.left;
      if (px < geo.m.l || px > r.width - geo.m.r) return null;
      if (geo.band) return Math.max(0, Math.min(geo.n - 1, Math.floor((px - geo.m.l) / geo.bw)));
      let best = null, bestD = Infinity;
      for (const x of xValues()) { const d = Math.abs(geo.xs(x) - px); if (d < bestD) { bestD = d; best = x; } }
      return best;
    }
    function show(ev) {
      if (!spec.tooltip) return;
      const idx = pick(ev);
      if (idx == null) { hide(); return; }
      const html = spec.tooltip(idx);
      if (!html) { hide(); return; }
      spec.active = idx; geo = draw(canvas, spec);
      tip.innerHTML = html; tip.hidden = false;
      const r = canvas.getBoundingClientRect(), hr = holder.getBoundingClientRect();
      const x = geo.xs(idx) + (r.left - hr.left);
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(4, Math.min(hr.width - tw - 4, x + 12 > hr.width - tw ? x - tw - 12 : x + 12)) + "px";
      tip.style.top = (r.top - hr.top + 6) + "px";
    }
    function hide() { tip.hidden = true; if (spec.active != null) { spec.active = null; geo = draw(canvas, spec); } }
    canvas.onpointermove = show; canvas.onpointerdown = show; canvas.onpointerleave = (e) => { if (e.pointerType === "mouse") hide(); };
    return () => { geo = draw(canvas, spec); };
  }

  function legend(container, items) {
    container.replaceChildren(...items.map((it) => {
      const s = document.createElement("span"); s.className = "legend-item";
      const sw = document.createElement("i"); sw.style.background = it.color; if (it.dash) sw.className = "dash";
      s.append(sw, document.createTextNode(it.name));
      return s;
    }));
  }

  root.RodilloChart = { draw, mount, legend, niceStep };
})(typeof window !== "undefined" ? window : globalThis);
