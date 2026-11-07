/* Cost trade-off chart for the MOMO blog. For one chip, three panels show how wirelength, density and congestion
   change over one run of each placement program (the three MOMO rounds, or the single models when that data exists),
   with numbered callouts. Each callout has a small inset of that program's layout at that moment, with lines from
   where each block and cell cluster was at the start of the window, and the congestion map when present.
   Data: placement_tradeoff_<chip>.js, written by website/scripts/make_placement_evolution.py. No dependencies. */
(function () {
  "use strict";
  var FONT = "Helvetica, Arial, sans-serif";
  var PARTS = [["wl", "Wirelength", "total length of the wires"], ["den", "Density", "how tightly cells are packed"],
               ["cong", "Congestion", "how crowded the wiring is"]];
  var SET_LABEL = {};   // one program set per chip; the toggle hides itself when there is only one
  var RAMP = [[255, 255, 255], [253, 224, 197], [244, 165, 130], [214, 96, 77], [170, 0, 0]];

  function decode(b64, Type) {
    var s = atob(b64), n = s.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = s.charCodeAt(i);
    return Type === Uint8Array ? u8 : new Type(u8.buffer);
  }
  function el(tag, cls, parent, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function sizeCanvas(c, w, h) {
    var r = window.devicePixelRatio || 1;
    c.style.width = w + "px"; c.style.height = h + "px";
    c.width = Math.round(w * r); c.height = Math.round(h * r);
    var ctx = c.getContext("2d");
    ctx.setTransform(r, 0, 0, r, 0, 0);
    return ctx;
  }
  function rgba(hex, a) {
    var v = parseInt(hex.slice(1), 16);
    return "rgba(" + (v >> 16 & 255) + "," + (v >> 8 & 255) + "," + (v & 255) + "," + a + ")";
  }
  function niceStep(x) {
    var e = Math.pow(10, Math.floor(Math.log10(x)));
    var ms = [1, 2, 2.5, 5, 10];
    for (var i = 0; i < ms.length; i++) if (ms[i] * e >= x) return ms[i] * e;
    return 10 * e;
  }
  function interp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (var i = 1; i < xs.length; i++) if (xs[i] >= x) {
      var a = (x - xs[i - 1]) / Math.max(xs[i] - xs[i - 1], 1e-9);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * a;
    }
    return ys[ys.length - 1];
  }
  function group(parent, label, items, onPick) {
    var g = el("div", "pt-group", parent);
    g.setAttribute("role", "group"); g.setAttribute("aria-label", label);
    items.forEach(function (it, i) {
      var b = el("button", "", g, it[1]);
      b.type = "button"; b.setAttribute("data-v", it[0]); b.setAttribute("aria-pressed", i ? "false" : "true");
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(g.children, function (c) { c.setAttribute("aria-pressed", c === b ? "true" : "false"); });
        onPick(it[0]);
      });
    });
    if (items.length < 2) g.style.display = "none";
    return g;
  }

  function Chart(root) {
    this.root = root;
    this.base = root.getAttribute("data-pt-base") || "";
    this.mode = "cost"; this.set = root.getAttribute("data-pt-set") || "main";
    var self = this, bar = root.querySelector(".pt-bar");
    var chips = window.MOMO_CHIPS || ["ibm01"];
    group(bar, "Chip", chips.map(function (c) { return [c, c]; }), function (c) { self.load(c); });
    this.setGroup = el("div", "pt-setslot", bar);
    group(bar, "Units", [["cost", "change in cost"], ["pct", "% change"]], function (m) { self.mode = m; self.draw(); });
    this.zoom = true;
    group(bar, "Scale", [["zoom", "zoom to the differences"], ["full", "full range"]],
      function (m) { self.zoom = m === "zoom"; self.draw(); });
    this.legendEl = root.querySelector(".pt-legend");
    this.panelsEl = root.querySelector(".pt-panels");
    this.cardsEl = root.querySelector(".pt-cards");
    this.panels = PARTS.map(function (p) {
      var box = el("div", "pt-panel", self.panelsEl);
      var t = el("div", "pt-ptitle", box);
      el("span", "pt-pname", t, p[1]); el("span", "pt-pdesc", t, p[2]);
      var c = el("canvas", "", box);
      c.setAttribute("role", "img");
      c.setAttribute("aria-label", p[1] + " over time for each program");
      return { key: p[0], box: box, c: c };
    });
    if (window.ResizeObserver) new ResizeObserver(function () { self.draw(); }).observe(this.panelsEl);
    else window.addEventListener("resize", function () { self.draw(); });
    this.load(root.getAttribute("data-pt-chip") || chips[0]);
  }

  Chart.prototype.load = function (chip) {
    var self = this;
    this.chip = chip;
    var have = window.MOMO_PT && window.MOMO_PT[chip];
    if (have) return this.show(have);
    var s = document.createElement("script");
    s.src = this.base + "placement_tradeoff_" + chip + ".js";
    s.onload = function () { if (self.chip === chip) self.show(window.MOMO_PT[chip]); };
    document.head.appendChild(s);
  };

  Chart.prototype.show = function (d) {
    var self = this;
    this.d = d;
    var keys = Object.keys(d.sets);
    if (keys.indexOf(this.set) < 0) this.set = keys[0];
    this.setGroup.innerHTML = "";
    var g = group(this.setGroup, "Programs", keys.map(function (k) { return [k, SET_LABEL[k] || k]; }),
      function (k) { self.set = k; self.cards(); self.draw(); });
    Array.prototype.forEach.call(g.children, function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-v") === self.set ? "true" : "false"); });
    this.cards();
    this.draw();
  };

  Chart.prototype.value = function (key, v) {
    var s = this.d.start[key];
    return this.mode === "cost" ? this.d.weight[key] * (v - s) : (v / s - 1) * 100;
  };

  Chart.prototype.cards = function () {
    var d = this.d, s = d.sets[this.set], self = this;
    this.legendEl.innerHTML = "";
    s.progs.forEach(function (p) {
      var it = el("span", "", self.legendEl);
      var sw = el("i", "pt-line", it); sw.style.background = p.color;
      el("span", "", it, p.label);
    });
    this.cardsEl.innerHTML = "";
    this.insets = s.callouts.map(function (c, i) {
      var card = el("div", "pt-card", self.cardsEl);
      var head = el("div", "pt-chead", card);
      el("span", "pt-num", head, String(i + 1));
      var who = s.progs.filter(function (p) { return p.short === c.who; })[0];
      var nm = el("span", "pt-who", head, c.who); if (who) nm.style.color = who.color;
      el("span", "pt-when", head, c.inset.t0 > 0 ? ", " + Math.round(c.inset.t0) + " to " + Math.round(c.inset.t) + " s" :
        ", start to " + Math.round(c.inset.t) + " s");
      var cv = el("canvas", "pt-inset", card);
      cv.setAttribute("role", "img");
      cv.setAttribute("aria-label", c.who + " layout at " + Math.round(c.inset.t) + " s, with lines from where things were at " + Math.round(c.inset.t0) + " s");
      el("p", "pt-text", card, c.text);
      return { c: c, cv: cv, color: who ? who.color : "#000", card: card };
    });
  };

  Chart.prototype.drawInset = function (ins) {
    var d = this.d, c = ins.c.inset, w = ins.cv.parentNode.clientWidth;
    if (!w) return;
    w = Math.min(w, this.panelsEl.clientWidth < 760 ? 130 : 220);
    var h = w * d.canvas[1] / d.canvas[0], ctx = sizeCanvas(ins.cv, w, h);
    if (!c.H) {
      c.H = decode(c.hard, Uint16Array); c.H0 = decode(c.hard0, Uint16Array);
      if (c.soft) { c.S = decode(c.soft, Uint16Array); c.S0 = decode(c.soft0, Uint16Array); }
      if (c.map) c.Mv = decode(c.map.v, Uint8Array);
    }
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    if (c.Mv) {
      var mc = document.createElement("canvas"); mc.width = c.map.cols; mc.height = c.map.rows;
      var mx = mc.getContext("2d"), img = mx.createImageData(c.map.cols, c.map.rows);
      for (var row = 0; row < c.map.rows; row++) for (var col = 0; col < c.map.cols; col++) {
        var v = c.Mv[row * c.map.cols + col] / 255 * (RAMP.length - 1), k = Math.min(Math.floor(v), RAMP.length - 2), f = v - k;
        var o = ((c.map.rows - 1 - row) * c.map.cols + col) * 4;
        for (var ch = 0; ch < 3; ch++) img.data[o + ch] = RAMP[k][ch] + (RAMP[k + 1][ch] - RAMP[k][ch]) * f;
        img.data[o + 3] = 255;
      }
      mx.putImageData(img, 0, 0);
      ctx.save(); ctx.globalAlpha = 0.85; ctx.imageSmoothingEnabled = true; ctx.drawImage(mc, 0, 0, w, h); ctx.restore();
    }
    var sx = w / d.canvas[0], sy = h / d.canvas[1], Q = 65535, n, x, y, bw, bh, tr = new Path2D();
    function far(A, B, i) { var dx = (A[i] - B[i]) / Q, dy = (A[i + 1] - B[i + 1]) / Q; return dx * dx + dy * dy > 0.0025 * 0.0025; }
    if (c.S) {
      var cold = new Path2D(), hot = new Path2D(), M = c.S.length / 2;
      for (n = 0; n < M; n++) {
        x = c.S[2 * n] / Q * w; y = h - c.S[2 * n + 1] / Q * h;
        bw = d.soft_wh[2 * n] * sx; bh = d.soft_wh[2 * n + 1] * sy;
        var moved = far(c.S, c.S0, 2 * n);
        (moved ? hot : cold).rect(x - bw / 2, y - bh / 2, bw, bh);
        if (moved) { tr.moveTo(c.S0[2 * n] / Q * w, h - c.S0[2 * n + 1] / Q * h); tr.lineTo(x, y); }
      }
      ctx.fillStyle = "rgba(110,110,104,0.26)"; ctx.fill(cold);
      ctx.fillStyle = "rgba(0,0,0,0.6)"; ctx.fill(hot);
    }
    var blk = new Path2D(), N = c.H.length / 2;
    for (n = 0; n < N; n++) {
      x = c.H[2 * n] / Q * w; y = h - c.H[2 * n + 1] / Q * h;
      bw = d.wh[2 * n] * sx; bh = d.wh[2 * n + 1] * sy;
      blk.rect(x - bw / 2, y - bh / 2, bw, bh);
      if (far(c.H, c.H0, 2 * n)) { tr.moveTo(c.H0[2 * n] / Q * w, h - c.H0[2 * n + 1] / Q * h); tr.lineTo(x, y); }
    }
    ctx.fillStyle = rgba(ins.color, 0.5); ctx.fill(blk);
    ctx.lineWidth = 0.5; ctx.strokeStyle = ins.color; ctx.stroke(blk);
    ctx.lineWidth = 0.6; ctx.strokeStyle = "rgba(0,0,0,0.5)"; ctx.stroke(tr);
    ctx.lineWidth = 1; ctx.strokeStyle = "#000"; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  };

  // y range for one panel. Full range: one range for all three panels, so their sizes compare. Zoomed (the default):
  // each panel fits the data after s.zoom_t, the moment by which every program has made most of its early drop, so the
  // differences between programs are readable; earlier values may leave the panel, and the panel says so.
  Chart.prototype.range = function (s, keys) {
    var self = this, lo = Infinity, hi = -Infinity, t0 = this.zoom ? s.zoom_t : -1;
    s.progs.forEach(function (p) {
      keys.forEach(function (k) {
        p[k].forEach(function (v, i) { if (p.t[i] < t0) return; var y = self.value(k, v); if (y < lo) lo = y; if (y > hi) hi = y; });
      });
    });
    if (!this.zoom) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    var pad = (hi - lo) * 0.1 || Math.abs(hi) * 0.1 || 1e-3;
    lo -= pad; hi += pad;
    var step = niceStep((hi - lo) / 4);
    lo = Math.floor(lo / step - 1e-9) * step; hi = Math.ceil(hi / step + 1e-9) * step;
    var dec = 0;
    while (dec < 5 && Math.abs(step * Math.pow(10, dec) - Math.round(step * Math.pow(10, dec))) > 1e-6) dec++;
    return { lo: lo, hi: hi, step: step, dec: dec };
  };

  Chart.prototype.draw = function () {
    if (!this.d) return;
    var d = this.d, s = d.sets[this.set], self = this, T = s.T;
    var shared = this.zoom ? null : this.range(s, PARTS.map(function (p) { return p[0]; }));
    var narrow = this.panelsEl.clientWidth < 560;
    this.panels.forEach(function (pn, j) {
      var w = pn.box.clientWidth;
      if (!w) return;
      var rg = shared || self.range(s, [pn.key]), lo = rg.lo, hi = rg.hi, step = rg.step, dec = rg.dec;
      var h = narrow ? 150 : 190, ctx = sizeCanvas(pn.c, w, h);
      var fs = 11, L = 54, R = 8, Tp = 8, B = 20, pw = w - L - R, ph = h - Tp - B;
      function X(t) { return L + t / T * pw; }
      function Y(v) { return Tp + (hi - v) / (hi - lo) * ph; }
      ctx.clearRect(0, 0, w, h);
      ctx.font = fs + "px " + FONT; ctx.fillStyle = "#000";
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      for (var v = lo; v <= hi + step / 2; v += step) {
        var yy = Math.round(Y(v)) + 0.5, zero = Math.abs(v) < step / 2;
        ctx.strokeStyle = zero ? "#9b9b93" : "#e7e4dc"; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + pw, yy); ctx.stroke();
        var lab = zero ? "0" : (v > 0 ? "+" : "−") + Math.abs(v).toFixed(dec) + (self.mode === "pct" ? "%" : "");
        ctx.fillText(lab, L - 4, yy);
      }
      ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
      [0, 100, 200, 300].forEach(function (t) { if (t <= T + 1) ctx.fillText(t + " s", Math.min(X(t), L + pw - 10), h - 4); });
      // zoomed: did anything leave the panel? Shade that stretch of time and say so
      var off = false;
      s.progs.forEach(function (p) { p[pn.key].forEach(function (v) { var y = self.value(pn.key, v); if (y > hi || y < lo) off = true; }); });
      if (off) {
        var xz = X(s.zoom_t);
        ctx.fillStyle = "rgba(0,0,0,0.05)"; ctx.fillRect(L, Tp, xz - L, ph);
        ctx.fillStyle = "#3a3a37"; ctx.font = "10px " + FONT; ctx.textAlign = "left"; ctx.textBaseline = "top";
        ctx.fillText("first " + Math.round(s.zoom_t) + " s off scale", xz + 4, Tp + 2);
        ctx.font = fs + "px " + FONT;
      }
      ctx.strokeStyle = "#000"; ctx.beginPath(); ctx.moveTo(L + 0.5, Tp); ctx.lineTo(L + 0.5, Tp + ph); ctx.lineTo(L + pw, Tp + ph + 0.5); ctx.stroke();
      // callout moments: a dashed line in every panel, the number on the panel the callout is about
      ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(0,0,0,0.35)";
      s.callouts.forEach(function (c) { var xx = Math.round(X(c.t)) + 0.5; ctx.beginPath(); ctx.moveTo(xx, Tp); ctx.lineTo(xx, Tp + ph); ctx.stroke(); });
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(L, Tp - 1, pw, ph + 2); ctx.clip();
      s.progs.forEach(function (p) {
        ctx.strokeStyle = p.color; ctx.lineWidth = 1.6; ctx.lineJoin = "round"; ctx.beginPath();
        for (var i = 0; i < p.t.length; i++) { var xx = X(p.t[i]), yy = Y(self.value(pn.key, p[pn.key][i])); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
        ctx.stroke();
      });
      ctx.restore();
      s.callouts.forEach(function (c, i) {
        if (c.panel !== pn.key) return;
        var p = s.progs.filter(function (q) { return q.short === c.who; })[0];
        var yy = Y(self.value(pn.key, interp(p.t, p[pn.key], c.t))), xx = X(c.t);
        yy += (yy > Tp + ph / 2 ? -14 : 14);   // beside the line, not on it
        yy = Math.min(Math.max(yy, Tp + 9), Tp + ph - 9); xx = Math.min(Math.max(xx, L + 9), L + pw - 9);
        ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(xx, yy, 8, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#000"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "11px " + FONT;
        ctx.fillText(String(i + 1), xx, yy + 0.5);
      });
      if (j === 0 || narrow || self.zoom) {
        ctx.save(); ctx.translate(10, Tp + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = "10px " + FONT; ctx.fillStyle = "#3a3a37";
        ctx.fillText(self.mode === "cost" ? "change in cost" : "change from start", 0, 0); ctx.restore();
      }
    });
    (this.insets || []).forEach(function (ins) { self.drawInset(ins); });
  };

  function init() {
    Array.prototype.slice.call(document.querySelectorAll(".pt")).forEach(function (r) { r.classList.add("js"); new Chart(r); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
