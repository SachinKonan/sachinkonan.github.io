/* Placement evolution widget for the MOMO blog. Three panels (Gemma alone, Qwen alone, Gemma → Qwen) replay one run of each
   placement program in sync. If the data has a prologue, it first shows the shared start layout being built (the same
   in all panels), then each program's search from that start. Blocks and cell clusters are drawn at true size and true
   position. A thin line joins each one to where it was when the search began, clusters that moved in the last few
   seconds of the run are dark, and the routing congestion map, when present, is drawn underneath.
   Data: placement_evolution_<chip>.js, written by website/scripts/make_placement_evolution.py. No dependencies. */
(function () {
  "use strict";
  var SEARCH_MS = 12000, PROLOGUE_MS = 3500, HOLD = 1500;  // playback lengths, and a pause on the final layout
  var WARP = 2;            // run time = T * v^WARP: playback is slower at the start, where most of the change happens
  var RECENT = 9;          // seconds of run time for "moved recently"
  var TRAIL_MIN = 0.0025;  // draw a line from the start once something has moved this far (fraction of the chip)
  var FONT = "Helvetica, Arial, sans-serif";
  var SOFT = "rgba(110,110,104,0.26)", SOFT_HOT = "rgba(0,0,0,0.6)", TRAIL = "rgba(0,0,0,0.42)";
  // congestion color ramp, white to red (hotspots in red, as in Figure 8)
  var RAMP = [[255, 255, 255], [253, 224, 197], [244, 165, 130], [214, 96, 77], [170, 0, 0]];

  function decode(b64, Type) {
    var s = atob(b64), n = s.length, u8 = new Uint8Array(n);
    for (var i = 0; i < n; i++) u8[i] = s.charCodeAt(i);
    return Type === Uint8Array ? u8 : Type === Int8Array ? new Int8Array(u8.buffer) : new Type(u8.buffer);
  }
  function locate(ku, u) {   // k with ku[k] <= u < ku[k+1], and the blend weight toward k+1
    var lo = 0, hi = ku.length - 1;
    if (u >= ku[hi]) return [hi, 0];
    if (u <= ku[0]) return [0, 0];
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
  function ramp(x) {
    x = Math.min(Math.max(x, 0), 1) * (RAMP.length - 1);
    var i = Math.min(Math.floor(x), RAMP.length - 2), f = x - i, a = RAMP[i], b = RAMP[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
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

  // positions as Float32Array per keyframe, x and y in 0..1 (y up)
  function unpackMoves(m, start, K, n) {
    var d = decode(m.d, Int8Array), out = [];
    var far = m.far || [], farP = far.length ? decode(m.farP, Uint16Array) : null, E = far.length;
    for (var k = 0; k < K; k++) {
      var f = new Float32Array(2 * n), o = k * n * 2;
      for (var i = 0; i < 2 * n; i++) f[i] = start[i] + d[o + i] * m.step;
      for (var e = 0; e < E; e++) {
        f[2 * far[e]] = farP[(k * E + e) * 2] / 65535;
        f[2 * far[e] + 1] = farP[(k * E + e) * 2 + 1] / 65535;
      }
      out.push(f);
    }
    return out;
  }
  function unpackAbs(b64, Type, scale, K, n) {
    var a = decode(b64, Type), out = [];
    for (var k = 0; k < K; k++) {
      var f = new Float32Array(2 * n);
      for (var i = 0; i < 2 * n; i++) f[i] = a[k * n * 2 + i] / scale;
      out.push(f);
    }
    return out;
  }
  function toFloat(b64) {
    var a = decode(b64, Uint16Array), f = new Float32Array(a.length);
    for (var i = 0; i < a.length; i++) f[i] = a[i] / 65535;
    return f;
  }
  function prepare(d) {
    if (d._ready) return d;
    d.N = d.wh.length / 2;
    d.M = d.soft_wh ? d.soft_wh.length / 2 : 0;
    var h0 = toFloat(d.start), s0 = d.M ? toFloat(d.soft_start) : null;
    d.rounds.forEach(function (r) {
      var K = r.ku.length;
      r.H = unpackMoves(r.hard, h0, K, d.N);
      if (r.soft) r.S = unpackMoves(r.soft, s0, K, d.M);
      r.start = r.best[0];
      if (r.map) {
        var v = decode(r.map.v, Uint8Array), n = r.map.rows * r.map.cols;
        r.map.F = [];
        for (var k = 0; k < r.map.ku.length; k++) r.map.F.push(v.subarray(k * n, (k + 1) * n));
      }
    });
    if (d.prologue) {
      var p = d.prologue;
      p.H = unpackAbs(p.hard, Uint16Array, 65535, p.n, d.N);
      if (p.soft) p.S = unpackAbs(p.soft, Uint8Array, 255, p.n, d.M);
    }
    d.H0 = h0; d.S0 = s0;
    d._ready = true;
    return d;
  }
  // blend keyframes k and k+1 into out
  function blend(F, k, a, out) {
    var A = F[k], B = F[Math.min(k + 1, F.length - 1)], n = out.length;
    if (!a) { out.set(A); return out; }
    for (var i = 0; i < n; i++) out[i] = A[i] + (B[i] - A[i]) * a;
    return out;
  }

  function Widget(root) {
    this.root = root;
    this.base = root.getAttribute("data-pe-base") || "";
    this.s = 0; this.playing = false; this.userPaused = false; this.visible = false;
    this.reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.btn = root.querySelector(".pe-play");
    this.scrub = root.querySelector(".pe-scrub");
    this.timeLbl = root.querySelector(".pe-time");
    this.panelsEl = root.querySelector(".pe-panels");
    this.legendEl = root.querySelector(".pe-legend");
    var chipsEl = root.querySelector(".pe-chips"), self = this;
    if (chipsEl && !chipsEl.children.length) {
      (window.MOMO_CHIPS || ["ibm01"]).forEach(function (c, i) {
        var b = el("button", "", chipsEl);
        b.type = "button"; b.textContent = c; b.setAttribute("data-chip", c);
        b.setAttribute("aria-pressed", i ? "false" : "true");
      });
      if (chipsEl.children.length < 2) chipsEl.style.display = "none";
    }
    this.chipBtns = Array.prototype.slice.call(root.querySelectorAll("[data-chip]"));
    this.btn.addEventListener("click", function () {
      if (self.playing) { self.userPaused = true; self.pause(); }
      else { self.userPaused = false; if (self.s >= 1) self.s = 0; self.play(); }
    });
    this.scrub.addEventListener("input", function () {
      self.userPaused = true; self.pause();
      self.s = +self.scrub.value / +self.scrub.max; self.draw();
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
    if (this.reduce) this.s = 1;   // reduced motion: start paused on the final layouts
    var q = root.getAttribute("data-pe-start");   // for static renders: data-pe-start="0.4" fixes the playback position
    if (q !== null) { this.s = +q; this.reduce = true; }
    var first = root.getAttribute("data-pe-chip") || (this.chipBtns.length ? this.chipBtns[0].getAttribute("data-chip") : "ibm01");
    this.load(first);
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

  // playback position s (0..1) -> stage and run time
  Widget.prototype.clock = function () {
    var d = this.d, P = d.prologue ? PROLOGUE_MS / (PROLOGUE_MS + SEARCH_MS) : 0, s = this.s;
    if (d.prologue && s < P) return { pro: true, f: s / P, u: 0 };
    var v = P < 1 ? (s - P) / (1 - P) : 1;
    return { pro: false, f: 1, u: Math.pow(Math.min(Math.max(v, 0), 1), WARP) };
  };

  Widget.prototype.show = function (d) {
    this.d = d;
    this.panelsEl.innerHTML = "";
    this.panels = d.rounds.map(function (r, i) {
      var p = { r: r, H: new Float32Array(2 * d.N), Hr: new Float32Array(2 * d.N) };
      if (d.M) { p.S = new Float32Array(2 * d.M); p.Sr = new Float32Array(2 * d.M); }
      p.el = el("div", "pe-panel", this.panelsEl);
      var t = el("div", "pe-title", p.el);
      var lin = el("span", "pe-lineage", t);
      lin.textContent = r.title; lin.style.color = r.color;
      el("span", "pe-round", t).textContent = r.sub || " ";   // "MOMO" under the handed-over program
      p.chipC = el("canvas", "pe-chip", p.el);
      p.chipC.setAttribute("role", "img");
      p.chipC.setAttribute("aria-label", r.title + (r.sub ? " (" + r.sub + ")" : "") + " placement");
      var rd = el("div", "pe-read", p.el);
      p.costV = el("span", "pe-cost-v", rd);
      p.costD = el("span", "pe-cost-d", rd);
      p.costC = el("canvas", "pe-cost", p.el);
      p.costC.setAttribute("aria-hidden", "true");
      if (r.map) {
        p.mapC = document.createElement("canvas");
        p.mapC.width = r.map.cols; p.mapC.height = r.map.rows;
        p.mapCtx = p.mapC.getContext("2d");
        p.mapImg = p.mapCtx.createImageData(r.map.cols, r.map.rows);
      }
      return p;
    }, this);
    this.legend();
    this.layout();
  };

  Widget.prototype.legend = function () {
    if (!this.legendEl) return;
    var d = this.d, h = "";
    h += '<span><i class="pe-sw pe-sw-block"></i>blocks</span>';
    if (d.M) {
      h += '<span><i class="pe-sw pe-sw-soft"></i>cell clusters</span>';
      h += '<span><i class="pe-sw pe-sw-hot"></i>moved in the last ' + RECENT + ' s</span>';
      h += '<span><i class="pe-sw pe-sw-trail"></i>path from its start</span>';
    }
    if (d.rounds.some(function (r) { return r.map; })) {
      h += '<span><i class="pe-sw pe-sw-map"></i>congestion, how crowded the wiring is (low to high)</span>';
      if (d.map_standin) h += '<span class="pe-synth">stand-in map, not congestion</span>';
    }
    this.legendEl.innerHTML = h;
  };

  Widget.prototype.layout = function () {
    if (!this.panels) return;
    var d = this.d;
    this.panels.forEach(function (p) {
      var w = p.el.clientWidth;
      if (!w) return;
      p.w = w; p.h = w * d.canvas[1] / d.canvas[0];
      p.cctx = sizeCanvas(p.chipC, w, p.h);
      p.small = w < 150;
      p.ch = p.small ? 46 : 64;
      p.kctx = sizeCanvas(p.costC, w, p.ch);
    });
    this.draw();
  };

  // positions at the current moment (and RECENT seconds earlier) into p.H, p.S, p.Hr, p.Sr; returns the reference
  // (start-of-search) positions for the lines, or null during the prologue
  Widget.prototype.positions = function (p, c) {
    var d = this.d, r = p.r;
    if (c.pro) {
      var pr = d.prologue, x = c.f * (pr.n - 1), k = Math.min(Math.floor(x), pr.n - 1), a = x - k;
      var xr = Math.max(x - 1.2, 0), kr = Math.min(Math.floor(xr), pr.n - 1), ar = xr - kr;
      blend(pr.H, k, a, p.H); blend(pr.H, kr, ar, p.Hr);
      if (pr.S && p.S) { blend(pr.S, k, a, p.S); blend(pr.S, kr, ar, p.Sr); }
      else if (p.S) { p.S.set(d.S0); p.Sr.set(d.S0); }
      return null;
    }
    var ur = Math.max(c.u - RECENT / d.T, 0), k1 = locate(r.ku, c.u), k2 = locate(r.ku, ur);
    blend(r.H, k1[0], k1[1], p.H); blend(r.H, k2[0], k2[1], p.Hr);
    if (r.S) { blend(r.S, k1[0], k1[1], p.S); blend(r.S, k2[0], k2[1], p.Sr); }
    return true;
  };

  Widget.prototype.drawMap = function (p, u) {
    var r = p.r, m = r.map, ctx = p.cctx;
    var k = locate(m.ku, u), A = m.F[k[0]], B = m.F[Math.min(k[0] + 1, m.F.length - 1)], a = k[1];
    var img = p.mapImg.data, R = m.rows, C = m.cols;
    for (var row = 0; row < R; row++) {
      for (var col = 0; col < C; col++) {
        var i = row * C + col, v = (A[i] + (B[i] - A[i]) * a) / 255, rgb = ramp(v);
        var o = ((R - 1 - row) * C + col) * 4;   // map row 0 is the bottom of the chip
        img[o] = rgb[0]; img[o + 1] = rgb[1]; img[o + 2] = rgb[2]; img[o + 3] = 255;
      }
    }
    p.mapCtx.putImageData(p.mapImg, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.globalAlpha = 0.85;
    ctx.drawImage(p.mapC, 0, 0, p.w, p.h);
    ctx.restore();
  };

  Widget.prototype.drawChip = function (p, c) {
    var d = this.d, r = p.r, ctx = p.cctx, w = p.w, h = p.h;
    if (!ctx) return;
    var ref = this.positions(p, c), H = p.H, S = p.S, H0 = d.H0, S0 = d.S0;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    if (r.map && !c.pro) this.drawMap(p, c.u);
    var sx = w / d.canvas[0], sy = h / d.canvas[1], moveMin = 0.0012, n, x, y, bw, bh;
    if (S) {   // cell clusters at true size; dark if they moved in the last few seconds
      var cold = new Path2D(), hot = new Path2D(), trail = new Path2D();
      for (n = 0; n < d.M; n++) {
        x = S[2 * n] * w; y = h - S[2 * n + 1] * h;
        bw = d.soft_wh[2 * n] * sx; bh = d.soft_wh[2 * n + 1] * sy;
        var dx = S[2 * n] - p.Sr[2 * n], dy = S[2 * n + 1] - p.Sr[2 * n + 1];
        ((dx * dx + dy * dy > moveMin * moveMin) ? hot : cold).rect(x - bw / 2, y - bh / 2, bw, bh);
        if (ref) {
          var ex = S[2 * n] - S0[2 * n], ey = S[2 * n + 1] - S0[2 * n + 1];
          if (ex * ex + ey * ey > TRAIL_MIN * TRAIL_MIN) { trail.moveTo(S0[2 * n] * w, h - S0[2 * n + 1] * h); trail.lineTo(x, y); }
        }
      }
      ctx.fillStyle = SOFT; ctx.fill(cold);
      ctx.fillStyle = SOFT_HOT; ctx.fill(hot);
    }
    var mov = new Path2D(), hotB = new Path2D(), ghost = new Path2D();
    for (n = 0; n < d.N; n++) {
      x = H[2 * n] * w; y = h - H[2 * n + 1] * h;
      bw = d.wh[2 * n] * sx; bh = d.wh[2 * n + 1] * sy;
      mov.rect(x - bw / 2, y - bh / 2, bw, bh);
      var hx = H[2 * n] - p.Hr[2 * n], hy = H[2 * n + 1] - p.Hr[2 * n + 1];
      if (ref && hx * hx + hy * hy > moveMin * moveMin) hotB.rect(x - bw / 2, y - bh / 2, bw, bh);
      if (ref) {
        var gx = H[2 * n] - H0[2 * n], gy = H[2 * n + 1] - H0[2 * n + 1];
        if (gx * gx + gy * gy > TRAIL_MIN * TRAIL_MIN) {
          ghost.rect(H0[2 * n] * w - bw / 2, h - H0[2 * n + 1] * h - bh / 2, bw, bh);
          if (trail) { trail.moveTo(H0[2 * n] * w, h - H0[2 * n + 1] * h); trail.lineTo(x, y); }
        }
      }
    }
    ctx.fillStyle = rgba(r.color, 0.5); ctx.fill(mov);
    ctx.lineWidth = 0.5; ctx.strokeStyle = r.color; ctx.stroke(mov);
    if (ref) {   // where moved blocks started: dashed outlines
      ctx.save(); ctx.setLineDash([2, 2]); ctx.lineWidth = 0.7; ctx.strokeStyle = "rgba(0,0,0,0.55)"; ctx.stroke(ghost); ctx.restore();
    }
    if (trail) { ctx.lineWidth = p.small ? 0.5 : 0.7; ctx.strokeStyle = TRAIL; ctx.stroke(trail); }
    ctx.lineWidth = 1.4; ctx.strokeStyle = "#000"; ctx.stroke(hotB);
    ctx.lineWidth = 1; ctx.strokeStyle = "#000"; ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  };

  Widget.prototype.drawCost = function (p, c) {
    var d = this.d, r = p.r, ctx = p.kctx, w = p.w, h = p.ch, u = c.u;
    if (!ctx) return;
    var fs = p.small ? 9 : 10, L = p.small ? 26 : 34, R = 4, T = 4, B = fs + 5;
    var pw = w - L - R, ph = h - T - B, y0 = d.y[0], y1 = d.y[1];
    function X(v) { return L + v * pw; }
    function Y(v) { return T + (1 - (Math.min(Math.max(v, y0), y1) - y0) / (y1 - y0)) * ph; }
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
    function line(ys, style, lw, upto) {
      ctx.strokeStyle = style; ctx.lineWidth = lw; ctx.beginPath();
      for (var i = 0; i < r.cu.length && r.cu[i] <= upto; i++) { var xx = X(r.cu[i]), yy = Y(ys[i]); i ? ctx.lineTo(xx, yy) : ctx.moveTo(xx, yy); }
      if (upto < 1) ctx.lineTo(X(upto), Y(lerpSeries(r.cu, ys, upto)));
      ctx.stroke();
    }
    line(r.cost, "rgba(155,155,147,0.55)", 1, 1);
    line(r.best, rgba(r.color, 0.25), 1.6, 1);
    line(r.best, r.color, 1.8, u);   // drawn up to now, so the line grows with the playback
    var cx = X(u), cy = Y(lerpSeries(r.cu, r.best, u));
    ctx.restore();
    ctx.fillStyle = r.color; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = "#000"; ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left"; ctx.fillText("0 s", L, h - 1);
    ctx.textAlign = "right"; ctx.fillText(Math.round(d.T) + " s", L + pw, h - 1);
  };

  Widget.prototype.draw = function () {
    if (!this.panels) return;
    var self = this, c = this.clock(), d = this.d;
    this.scrub.value = Math.round(this.s * +this.scrub.max);
    var pr = d.prologue, sub = "";
    if (c.pro && pr.legal) sub = pr.legal[Math.min(Math.round(c.f * (pr.n - 1)), pr.n - 1)] ? ", removing overlaps" : ", spreading blocks out";
    this.timeLbl.textContent = c.pro ? "building a start layout" + sub :
      "each program's search, " + Math.round(c.u * d.T) + " s of " + Math.round(d.T);
    this.panels.forEach(function (p) {
      self.drawChip(p, c); self.drawCost(p, c);
      var r = p.r;
      if (c.pro) { p.costV.textContent = c.f >= 1 ? "cost " + r.start.toFixed(4) : ""; p.costD.textContent = c.f >= 1 ? "start layout" : "not scored yet"; return; }
      var v = lerpSeries(r.cu, r.best, c.u), pct = (1 - v / r.start) * 100;
      p.costV.textContent = "cost " + v.toFixed(4);
      p.costD.textContent = pct >= 0.05 ? "−" + pct.toFixed(1) + "% from start" : "start layout";
    });
  };

  Widget.prototype.play = function () {
    if (this.playing) return;
    this.playing = true; this.btn.setAttribute("aria-label", "Pause"); this.btn.classList.add("on");
    var self = this, last = null, hold = 0;
    var total = (this.d && this.d.prologue ? PROLOGUE_MS : 0) + SEARCH_MS;
    function tick(ts) {
      if (!self.playing) return;
      if (last !== null) {
        var dt = Math.min(ts - last, 100);
        if (self.s >= 1) { hold += dt; if (hold > HOLD) { self.s = 0; hold = 0; } }
        else self.s = Math.min(1, self.s + dt / total);
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
