/* Placement evolution widget for the MOMO blog. Three panels (one per MOMO round) replay how each round's placement
   program moves the chip's blocks during one run, in sync on a shared time axis (0 to 100% of each run), with the
   best cost so far under each panel. Data: placement_evolution_<chip>.js, written by
   website/scripts/make_placement_evolution.py. No dependencies. */
(function () {
  "use strict";
  var DURATION = 9000, HOLD = 1400;           // ms for one pass, pause on the final layout before looping
  var FONT = "Helvetica, Arial, sans-serif";
  var SOFT = "rgba(111,111,105,0.22)", FIXED = "#b0b0b0";

  function decode(b64, Type) {
    var s = atob(b64), n = s.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = s.charCodeAt(i);
    return Type === Uint8Array ? u8 : new Type(u8.buffer);
  }
  // index k with ku[k] <= u < ku[k+1], and the blend weight toward k+1
  function locate(ku, u) {
    var lo = 0, hi = ku.length - 1;
    if (u >= ku[hi]) return [hi, 0];
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (ku[m] <= u) lo = m; else hi = m; }
    var d = ku[lo + 1] - ku[lo];
    return [lo, d > 0 ? (u - ku[lo]) / d : 0];
  }
  function lerpSeries(xs, ys, u) {
    var k = locate(xs, u);
    return k[1] ? ys[k[0]] * (1 - k[1]) + ys[k[0] + 1] * k[1] : ys[k[0]];
  }
  function rgba(hex, a) {
    var v = parseInt(hex.slice(1), 16);
    return "rgba(" + (v >> 16 & 255) + "," + (v >> 8 & 255) + "," + (v & 255) + "," + a + ")";
  }
  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
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

  function prepare(d) {
    if (d._ready) return d;
    var N = d.wh.length / 2;
    d.N = N;
    d.isFixed = new Uint8Array(N);
    d.fixed.forEach(function (i) { d.isFixed[i] = 1; });
    d.rounds.forEach(function (r) {
      r.P = decode(r.pos, Uint16Array);
      if (r.soft) r.soft.P = decode(r.soft.pos, Uint8Array);
      r.start = r.best[0];
    });
    d._ready = true;
    return d;
  }

  function Widget(root) {
    this.root = root;
    this.base = root.getAttribute("data-pe-base") || "";
    this.u = 0; this.playing = false; this.userPaused = false; this.visible = false;
    this.reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.btn = root.querySelector(".pe-play");
    this.scrub = root.querySelector(".pe-scrub");
    this.timeLbl = root.querySelector(".pe-time");
    this.panelsEl = root.querySelector(".pe-panels");
    this.chipBtns = Array.prototype.slice.call(root.querySelectorAll("[data-chip]"));
    var self = this;
    this.btn.addEventListener("click", function () {
      if (self.playing) { self.userPaused = true; self.pause(); }
      else { self.userPaused = false; if (self.u >= 1) self.u = 0; self.play(); }
    });
    this.scrub.addEventListener("input", function () {
      self.userPaused = true; self.pause();
      self.u = +self.scrub.value / +self.scrub.max; self.draw();
    });
    this.chipBtns.forEach(function (b) {
      b.addEventListener("click", function () { self.load(b.getAttribute("data-chip")); });
    });
    if (window.ResizeObserver) new ResizeObserver(function () { self.layout(); }).observe(this.panelsEl);
    else window.addEventListener("resize", function () { self.layout(); });
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (es) {
        self.visible = es[0].isIntersecting;
        if (!self.visible) self.pause();
        else if (!self.userPaused && !self.reduce) self.play();
      }, { threshold: 0.35 }).observe(root);
    } else this.visible = true;
    if (this.reduce) this.u = 1;   // reduced motion: start paused on the final layouts
    this.load(this.chipBtns.length ? this.chipBtns[0].getAttribute("data-chip") : "ibm01");
  }

  Widget.prototype.load = function (chip) {
    var self = this;
    this.chipBtns.forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-chip") === chip ? "true" : "false"); });
    this.chip = chip;
    var have = window.MOMO_PE && window.MOMO_PE[chip];
    if (have) return this.show(prepare(have));
    var s = document.createElement("script");
    s.src = this.base + "placement_evolution_" + chip + ".js";
    s.onload = function () { if (self.chip === chip && window.MOMO_PE && window.MOMO_PE[chip]) self.show(prepare(window.MOMO_PE[chip])); };
    document.head.appendChild(s);
  };

  Widget.prototype.show = function (d) {
    this.d = d;
    this.panelsEl.innerHTML = "";
    this.panels = d.rounds.map(function (r, i) {
      var p = { r: r };
      p.el = el("div", "pe-panel", this.panelsEl);
      var t = el("div", "pe-title", p.el);
      el("span", "pe-round", t).textContent = "Round " + (i + 1);
      var lin = el("span", "pe-lineage", t);
      lin.textContent = r.title; lin.style.color = r.color;
      if (r.synthetic) el("span", "pe-synth", t).textContent = "synthetic data";
      p.chipC = el("canvas", "pe-chip", p.el);
      p.chipC.setAttribute("role", "img");
      p.chipC.setAttribute("aria-label", "Round " + (i + 1) + " placement, " + r.title);
      p.costC = el("canvas", "pe-cost", p.el);
      p.costC.setAttribute("aria-hidden", "true");
      p.read = el("div", "pe-read", p.el);
      p.phase = el("div", "pe-phase", p.el);
      return p;
    }, this);
    this.layout();
  };

  Widget.prototype.layout = function () {
    if (!this.panels) return;
    var d = this.d;
    this.panels.forEach(function (p) {
      var w = p.el.clientWidth;
      if (!w) return;
      p.w = w; p.h = w * d.canvas[1] / d.canvas[0];
      p.cctx = sizeCanvas(p.chipC, w, p.h);
      p.ch = w < 150 ? 52 : 72;
      p.kctx = sizeCanvas(p.costC, w, p.ch);
      p.small = w < 150;
    });
    this.draw();
  };

  Widget.prototype.drawChip = function (p) {
    var d = this.d, r = p.r, ctx = p.cctx, w = p.w, h = p.h, u = this.u;
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    if (r.soft) {   // soft blocks: faint dots
      var s = r.soft, ks = locate(s.ku, u), a = ks[1], o0 = ks[0] * s.n * 2, o1 = Math.min(ks[0] + 1, s.ku.length - 1) * s.n * 2;
      var dot = Math.max(1, (d.soft_size || 0.01) * w * 0.6);
      ctx.fillStyle = SOFT;
      for (var j = 0; j < s.n; j++) {
        var sx = (s.P[o0 + 2 * j] * (1 - a) + s.P[o1 + 2 * j] * a) / 255 * w;
        var sy = h - (s.P[o0 + 2 * j + 1] * (1 - a) + s.P[o1 + 2 * j + 1] * a) / 255 * h;
        ctx.fillRect(sx - dot / 2, sy - dot / 2, dot, dot);
      }
    }
    var k = locate(r.ku, u), b = k[1], N = d.N, q0 = k[0] * N * 2, q1 = Math.min(k[0] + 1, r.ku.length - 1) * N * 2;
    var sxw = w / d.canvas[0], syh = h / d.canvas[1];
    var mov = new Path2D(), fix = new Path2D();
    for (var n = 0; n < N; n++) {
      var x = (r.P[q0 + 2 * n] * (1 - b) + r.P[q1 + 2 * n] * b) / 65535 * w;
      var y = h - (r.P[q0 + 2 * n + 1] * (1 - b) + r.P[q1 + 2 * n + 1] * b) / 65535 * h;
      var bw = d.wh[2 * n] * sxw, bh = d.wh[2 * n + 1] * syh;
      (d.isFixed[n] ? fix : mov).rect(x - bw / 2, y - bh / 2, bw, bh);
    }
    ctx.fillStyle = FIXED; ctx.fill(fix);
    ctx.fillStyle = rgba(r.color, 0.55); ctx.fill(mov);
    ctx.lineWidth = 0.5; ctx.strokeStyle = r.color; ctx.stroke(mov);
    ctx.lineWidth = 1; ctx.strokeStyle = "#000"; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  };

  Widget.prototype.drawCost = function (p, first) {
    var d = this.d, r = p.r, ctx = p.kctx, w = p.w, h = p.ch, u = this.u;
    if (!ctx) return;
    var fs = p.small ? 9 : 10, L = p.small ? 26 : 34, R = 4, T = 4, B = fs + 5;
    var pw = w - L - R, ph = h - T - B, y0 = d.y[0], y1 = d.y[1];
    function X(v) { return L + v * pw; }
    function Y(c) { return T + (1 - (Math.min(Math.max(c, y0), y1) - y0) / (y1 - y0)) * ph; }
    ctx.clearRect(0, 0, w, h);
    ctx.font = fs + "px " + FONT; ctx.textBaseline = "middle"; ctx.textAlign = "right";
    var ticks = d.yticks, step = ticks.length > 1 ? ticks[1] - ticks[0] : 1, dec = 0;
    while (dec < 5 && Math.abs(step * Math.pow(10, dec) - Math.round(step * Math.pow(10, dec))) > 1e-6) dec++;
    ctx.strokeStyle = "#e7e4dc"; ctx.lineWidth = 1; ctx.fillStyle = "#000";
    ticks.forEach(function (t) {
      var yy = Math.round(Y(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(L + pw, yy); ctx.stroke();
      ctx.fillText(t.toFixed(dec), L - 3, yy);
    });
    ctx.strokeStyle = "#000"; ctx.beginPath(); ctx.moveTo(L + 0.5, T); ctx.lineTo(L + 0.5, T + ph); ctx.lineTo(L + pw, T + ph + 0.5); ctx.stroke();
    ctx.save(); ctx.beginPath(); ctx.rect(L, T - 2, pw, ph + 4); ctx.clip();
    function line(ys, style, lw) {
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.beginPath();
      for (var i = 0; i < r.cu.length; i++) { var xx = X(r.cu[i]), yy = Y(ys[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
      ctx.stroke();
    }
    line(r.cost, "rgba(155,155,147,0.55)", 1);
    line(r.best, r.color, 1.6);
    var cx = X(u), cy = Y(lerpSeries(r.cu, r.best, u));
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(cx) + 0.5, T); ctx.lineTo(Math.round(cx) + 0.5, T + ph); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = r.color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#000"; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("0 s", L, h - 1);
    ctx.textAlign = "right"; ctx.fillText(Math.round(r.tmax) + " s", L + pw, h - 1);
  };

  Widget.prototype.draw = function () {
    if (!this.panels) return;
    var u = this.u, self = this;
    this.scrub.value = Math.round(u * +this.scrub.max);
    this.timeLbl.textContent = u <= 0 ? "start" : u >= 1 ? "end of each run" : Math.round(u * 100) + "% of each run";
    this.panels.forEach(function (p, i) {
      self.drawChip(p); self.drawCost(p, i === 0);
      var r = p.r, c = lerpSeries(r.cu, r.best, u), pct = (1 - c / r.start) * 100;
      p.read.textContent = "cost " + c.toFixed(4) + (pct >= 0.05 ? ", " + pct.toFixed(1) + "% below start" : "");
      var ph = "";
      for (var k = 0; k < r.phases.length && r.phases[k][0] <= u; k++) ph = r.phases[k][1];
      p.phase.textContent = "";  /* internal phase names are not shown */
    });
  };

  Widget.prototype.play = function () {
    if (this.playing) return;
    this.playing = true; this.btn.setAttribute("aria-label", "Pause"); this.btn.classList.add("on");
    var self = this, last = null, hold = 0;
    function tick(ts) {
      if (!self.playing) return;
      if (last !== null) {
        var dt = ts - last;
        if (self.u >= 1) { hold += dt; if (hold > HOLD) { self.u = 0; hold = 0; } }
        else self.u = Math.min(1, self.u + dt / DURATION);
        self.draw();
      }
      last = ts;
      self.raf = requestAnimationFrame(tick);
    }
    this.raf = requestAnimationFrame(tick);
  };
  Widget.prototype.pause = function () {
    this.playing = false; this.btn.setAttribute("aria-label", "Play"); this.btn.classList.remove("on");
    if (this.raf) cancelAnimationFrame(this.raf);
  };

  function init() {
    Array.prototype.slice.call(document.querySelectorAll(".pe")).forEach(function (r) { r.classList.add("js"); new Widget(r); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
