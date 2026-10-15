/* Navitals — the live trail map behind every page.
   Generates a map for the window (fields, forests, a lake with a footpath, ponds, a stream, a hamlet and a
   network of roads and trails), then keeps planning a random route from one edge to the opposite one,
   finds the shortest way along the network, and lets the heart ride it.

   Usage: <canvas class="trail-map" data-trail-map aria-hidden="true"></canvas> anywhere in <body>, plus this
   script. Every visit gets a new map and new routes. Options as data attributes on the canvas:
   data-seed (pins one map, e.g. for screenshots), data-density (road spacing, px), data-speed (px/s).
   Day or night follows the system appearance. No dependencies. */
(function () {
  "use strict";

  class TrailMap {
    constructor(getProps) { this.getProps = getProps; }
    get props() { return this.getProps(); }

    // A map of its own for each visit: the same on every page while the tab is open (sessionStorage),
    // through resizes and day/night switches, and a new one on the next visit.
    visitSeed() {
      if (this._visitSeed) return this._visitSeed;
      let seed = 0;
      try { seed = Number(window.sessionStorage.getItem('navitals-map-seed')) || 0; } catch (e) { /* storage blocked */ }
      if (!seed) {
        seed = 1 + Math.floor(Math.random() * 2147483645);
        try { window.sessionStorage.setItem('navitals-map-seed', String(seed)); } catch (e) { /* storage blocked */ }
      }
      this._visitSeed = seed;
      return seed;
    }

    palette(night) {
      if (night) return {
        night: true, base: '#0E1A10', fields: ['#101D12', '#122014', '#0F1C11', '#13221A', '#112016', '#152418'],
        res: '#1B231C', bld: '#2A322B', bldEdge: '#343D35',
        forest: '#091309', dense: '#060D06', crownA: '#040904', crownB: '#122214', crownOp: 0.6,
        contour: '#5E9A48', contourOp: 0.12, indexOp: 0.2,
        water: '#0B2740', shore: '#123A5C', river: 12,
        track: '#C9D3C2', trackOp: 0.34, path: '#D7E0D0', pathOp: 0.3, cycle: '#7A63D6', cycleOp: 0.45,
        roadCase: '#2B2108', road: '#5E4A16', minorCase: '#1E241E', minor: '#384036',
        red: '#FB2A2A', redCase: '#5E0A07', glow: 'rgba(255,59,48,0.22)'
      };
      return {
        night: false, base: '#93CC3E', fields: ['#9CD33A', '#A6D84B', '#B0DC5E', '#97CF3C', '#A9D953', '#BBE06C'],
        res: '#D9E2B6', bld: '#C9CDB4', bldEdge: '#B4B99C',
        forest: '#6FB937', dense: '#5FAF0D', crownA: '#58A21E', crownB: '#7FC341', crownOp: 0.55,
        contour: '#3F7A12', contourOp: 0.2, indexOp: 0.32,
        water: '#5DBDF0', shore: '#3FA6DE', river: 12,
        track: '#FFF9E3', trackOp: 0.95, path: '#FFFFFF', pathOp: 0.92, cycle: '#8A6CF0', cycleOp: 0.5,
        roadCase: '#E3A72A', road: '#FFD94D', minorCase: '#C9C7B4', minor: '#FFFDF4',
        red: '#FB2A2A', redCase: '#A8130E', glow: ''
      };
    }

    start(canvas) {
      const ctx = canvas.getContext('2d');
      const base = document.createElement('canvas');
      const bctx = base.getContext('2d');
      const heart = new Path2D('M12 21s-7.5-4.6-9.6-9.2C.9 8.3 3 4.5 6.6 4.5c2.1 0 3.6 1.1 4.4 2.6.8-1.5 2.3-2.6 4.4-2.6 3.6 0 5.7 3.8 4.2 7.3C19.5 16.4 12 21 12 21z');
      const reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
      const st = { w: 0, h: 0, dpr: 1, wd: null, route: null, phase: 'plan', t0: 0, raf: 0, sides: null, pal: null };
      let rs = 1 + Math.floor(Math.random() * 2147483645);
      const rr = () => { rs = (rs * 16807) % 2147483647; return (rs - 1) / 2147483646; };

      const newRoute = (now) => {
        const g = st.wd.graph;
        const pairs = [['L', 'R'], ['R', 'L'], ['T', 'B'], ['B', 'T']];
        for (let k = 0; k < 16; k++) {
          const pr = pairs[Math.floor(rr() * pairs.length)];
          const A = st.sides[pr[0]], B = st.sides[pr[1]];
          if (!A.length || !B.length) continue;
          const pts = this.shortestRoute(g, A[Math.floor(rr() * A.length)], B[Math.floor(rr() * B.length)]);
          if (!pts || pts.length < 2) continue;
          const cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
          st.route = { pts, cum, L: cum[cum.length - 1] };
          st.phase = 'plan'; st.t0 = now;
          return;
        }
        st.route = null;
      };

      const build = () => {
        const r = canvas.getBoundingClientRect();
        if (!r.width || !r.height) return;
        st.w = r.width; st.h = r.height;
        st.dpr = Math.min(2, window.devicePixelRatio || 1, Math.sqrt(9e6 / (st.w * st.h)));
        canvas.width = base.width = Math.round(st.w * st.dpr);
        canvas.height = base.height = Math.round(st.h * st.dpr);
        st.pal = this.palette((this.props.style ?? 'Day') === 'Night');
        st.wd = this.genWorld(st.w, st.h, this.props.seed || this.visitSeed(), this.props.density ?? 175);
        bctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
        this.drawWorld(bctx, st.wd, st.pal, st.w, st.h);
        st.sides = { L: [], R: [], T: [], B: [] };
        st.wd.graph.nodes.forEach((n, i) => { if (st.sides[n.side]) st.sides[n.side].push(i); });
        newRoute(performance.now());
      };

      const at = (d) => {
        const { pts, cum, L } = st.route; d = Math.max(0, Math.min(L, d));
        let lo = 0, hi = cum.length - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m; else hi = m; }
        const t = (d - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
        return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * t, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * t];
      };
      const routePath = (d) => {
        const { pts, cum } = st.route;
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
        let i = 1;
        for (; i < pts.length && cum[i] <= d; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        if (i < pts.length) { const p = at(d); ctx.lineTo(p[0], p[1]); }
      };

      const frame = (now) => {
        st.raf = requestAnimationFrame(frame);
        if (!st.wd) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(base, 0, 0);
        ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
        if (!st.route) return;
        const pal = st.pal, speed = this.props.speed ?? 140;
        const t = (now - st.t0) / 1000, L = st.route.L;
        let alpha = 1, puck = null, reveal = L;
        if (reduce) { puck = at(L * 0.5); }
        else if (st.phase === 'plan') {
          const dur = Math.min(1.8, Math.max(0.9, L / 1500)), k = Math.min(1, t / dur);
          reveal = L * (1 - Math.pow(1 - k, 3));
          if (k >= 1) { st.phase = 'ride'; st.t0 = now; }
        } else if (st.phase === 'ride') {
          const d = t * speed; puck = at(d);
          if (d >= L) { st.phase = 'fade'; st.t0 = now; }
        } else {
          const k = Math.min(1, t / 0.9); alpha = 1 - k;
          if (k >= 1) { newRoute(now); return; }
        }
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = alpha;
        routePath(reveal);
        if (pal.glow) { ctx.strokeStyle = pal.glow; ctx.lineWidth = 38; ctx.stroke(); }
        ctx.strokeStyle = pal.redCase; ctx.lineWidth = 17; ctx.stroke();
        ctx.strokeStyle = pal.red; ctx.lineWidth = 11; ctx.stroke();
        ctx.globalAlpha = 1;
        if (puck) {
          const b = ((now / 1000) % 1.05) / 1.05;
          const s = 1 + (b < 0.14 ? b / 0.14 * 0.14 : b < 0.28 ? (0.28 - b) / 0.14 * 0.14 : b < 0.42 ? (b - 0.28) / 0.14 * 0.08 : b < 0.56 ? (0.56 - b) / 0.14 * 0.08 : 0);
          if (!reduce) { ctx.globalAlpha = 0.5 * (1 - b); ctx.fillStyle = pal.red; ctx.beginPath(); ctx.arc(puck[0], puck[1], 22 * (1 + b * 1.7), 0, 6.2832); ctx.fill(); ctx.globalAlpha = 1; }
          if (pal.night) { ctx.shadowColor = 'rgba(255,59,48,0.85)'; ctx.shadowBlur = 24; } else { ctx.shadowColor = 'rgba(30,10,0,0.35)'; ctx.shadowBlur = 14; ctx.shadowOffsetY = 5; }
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(puck[0], puck[1], 22 * s, 0, 6.2832); ctx.fill();
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
          ctx.fillStyle = pal.red; ctx.beginPath(); ctx.arc(puck[0], puck[1], 18 * s, 0, 6.2832); ctx.fill();
          ctx.save(); ctx.translate(puck[0], puck[1]); const hs = 20 * s / 24; ctx.scale(hs, hs); ctx.translate(-12, -12.6);
          ctx.fillStyle = '#ffffff'; ctx.fill(heart); ctx.restore();
        }
      };

      let tmr = 0;
      const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { clearTimeout(tmr); tmr = setTimeout(build, 120); }) : null;
      if (ro) ro.observe(canvas);
      tmr = setTimeout(build, 30); // let the page paint first
      st.raf = requestAnimationFrame(frame);
      return {
        stop: () => { cancelAnimationFrame(st.raf); clearTimeout(tmr); if (ro) ro.disconnect(); },
        rebuild: build
      };
    }

    // ---------- the map: land cover from noise, water placed on purpose, then a road network grown around it ----------
    genWorld(W, H, seed, cell) {
      let s = (seed >>> 0) || 1;
      const rnd = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
      const makeNoise = () => {
        const perm = []; for (let i = 0; i < 256; i++) perm.push(i);
        for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp; }
        const p = new Uint8Array(512); for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
        const gxs = new Float64Array(256), gys = new Float64Array(256);
        for (let i = 0; i < 256; i++) { const a = rnd() * Math.PI * 2; gxs[i] = Math.cos(a); gys[i] = Math.sin(a); }
        return (x, y) => {
          const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
          const h00 = p[p[X] + Y], h10 = p[p[X + 1] + Y], h01 = p[p[X] + Y + 1], h11 = p[p[X + 1] + Y + 1];
          const d00 = gxs[h00] * xf + gys[h00] * yf, d10 = gxs[h10] * (xf - 1) + gys[h10] * yf;
          const d01 = gxs[h01] * xf + gys[h01] * (yf - 1), d11 = gxs[h11] * (xf - 1) + gys[h11] * (yf - 1);
          const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
          const a = d00 + (d10 - d00) * u, b = d01 + (d11 - d01) * u;
          return (a + (b - a) * v) * 1.4;
        };
      };
      const fbm = (n, x, y, oct, pers) => { let sum = 0, amp = 1, f = 1, norm = 0; for (let o = 0; o < oct; o++) { sum += amp * n(x * f, y * f); norm += amp; amp *= pers; f *= 2.03; } return sum / norm; };
      const nF = makeNoise(), nW = makeNoise(), nH = makeNoise(), nV = makeNoise();

      const chaikin = (pts, closed, iter) => {
        for (let it = 0; it < iter; it++) {
          const o = [], n = pts.length;
          if (!closed) o.push(pts[0]);
          for (let i = 0; i < (closed ? n : n - 1); i++) { const a = pts[i], b = pts[(i + 1) % n]; o.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]); }
          if (!closed) o.push(pts[n - 1]);
          pts = o;
        }
        return pts;
      };
      const rdp = (pts, eps) => {
        if (pts.length < 3) return pts;
        const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
        const stack = [[0, pts.length - 1]];
        while (stack.length) {
          const [a, b] = stack.pop(); let md = 0, mi = -1;
          const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
          for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / L; if (d > md) { md = d; mi = i; } }
          if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
        }
        return pts.filter((_, i) => keep[i]);
      };
      const resample = (pts, step) => {
        const out = [pts[0]]; let carry = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          let d = step - carry;
          while (d <= L) { out.push([a[0] + (b[0] - a[0]) * d / L, a[1] + (b[1] - a[1]) * d / L]); d += step; }
          carry = L - (d - step);
        }
        return out;
      };
      const inside = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > pt[1]) !== (b[1] > pt[1]) && pt[0] < (b[0] - a[0]) * (pt[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };

      // water: one lake per ~2.4 Mpx², ponds per ~0.5 Mpx²
      const area = W * H, k = Math.min(1.2, Math.max(0.6, Math.min(W, H) / 900));
      const water = [];
      const clear = (x, y, d) => water.every((b) => Math.hypot(b.x - x, b.y - y) > d + Math.max(b.rx, b.ry));
      const nLake = Math.max(1, Math.round(area / 2.4e6));
      for (let i = 0, tries = 0; i < nLake && tries < 80; tries++) {
        const x = W * (0.12 + 0.76 * rnd()), y = H * (0.14 + 0.72 * rnd()), rx = (125 + 70 * rnd()) * k, ry = (80 + 40 * rnd()) * k;
        if (!clear(x, y, Math.max(rx, ry) + 300)) continue;
        water.push({ x, y, rx, ry, a: 1.25, lake: true }); i++;
      }
      const nPond = Math.max(2, Math.round(area / 0.5e6));
      for (let i = 0, tries = 0; i < nPond && tries < 200; tries++) {
        const x = W * (0.06 + 0.88 * rnd()), y = H * (0.06 + 0.88 * rnd()), r = (24 + 22 * rnd()) * k;
        if (!clear(x, y, r + 190)) continue;
        water.push({ x, y, rx: r * (0.8 + 0.4 * rnd()), ry: r * (0.8 + 0.4 * rnd()), a: 1.55, lake: false }); i++;
      }

      // scalar fields on an 8 px grid (padded so every contour closes off-screen)
      const S = 8, PAD = 3, GX = Math.ceil(W / S) + 1 + 2 * PAD, GY = Math.ceil(H / S) + 1 + 2 * PAD;
      const gxp = (i) => (i - PAD) * S, gyp = (j) => (j - PAD) * S;
      const field = (fn) => { const a = new Float32Array(GX * GY); for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) a[j * GX + i] = fn(gxp(i), gyp(j)); return a; };
      const sample = (F, x, y) => { const i = Math.round(x / S) + PAD, j = Math.round(y / S) + PAD; if (i < 0 || j < 0 || i >= GX || j >= GY) return -1; return F[j * GX + i]; };
      const bump = (x, y, b) => { const d = ((x - b.x) / b.rx) ** 2 + ((y - b.y) / b.ry) ** 2; return d > 9 ? 0 : b.a * Math.exp(-d * 1.3); };
      const Wf = field((x, y) => { let v = -0.62 + fbm(nW, x / 170, y / 170, 3, 0.5) * 0.7 + fbm(nW, x / 48 + 31, y / 48, 2, 0.5) * 0.16; for (const b of water) v += bump(x, y, b); return v; });
      const waterAt = (x, y) => sample(Wf, x, y);
      const Hf = field((x, y) => fbm(nH, x / 1000, y / 1000, 4, 0.5) + 0.25 * fbm(nF, x / 400 + 9, y / 400, 2, 0.5));

      // marching squares -> closed rings
      const rings = (F, t) => {
        const val = (i, j) => (i <= 0 || j <= 0 || i >= GX - 1 || j >= GY - 1) ? -1e9 : F[j * GX + i];
        const pt = (id) => {
          const c = id >> 1, i = c % GX, j = (c - i) / GX;
          if (!(id & 1)) { const a = val(i, j), b = val(i + 1, j), u = (t - a) / (b - a); return [gxp(i) + u * S, gyp(j)]; }
          const a = val(i, j), b = val(i, j + 1), u = (t - a) / (b - a); return [gxp(i), gyp(j) + u * S];
        };
        const sa = [], sb = [], adj = new Map();
        const add = (e1, e2) => { const n = sa.length; sa.push(e1); sb.push(e2); for (const e of [e1, e2]) { const l = adj.get(e); if (l) l.push(n); else adj.set(e, [n]); } };
        for (let j = 0; j < GY - 1; j++) for (let i = 0; i < GX - 1; i++) {
          const v00 = val(i, j), v10 = val(i + 1, j), v11 = val(i + 1, j + 1), v01 = val(i, j + 1);
          const c = (v00 > t ? 8 : 0) | (v10 > t ? 4 : 0) | (v11 > t ? 2 : 0) | (v01 > t ? 1 : 0);
          if (c === 0 || c === 15) continue;
          const T = (j * GX + i) * 2, B = ((j + 1) * GX + i) * 2, Lf = (j * GX + i) * 2 + 1, R = (j * GX + i + 1) * 2 + 1;
          const center = (v00 + v10 + v11 + v01) / 4 > t;
          switch (c) {
            case 1: case 14: add(Lf, B); break;
            case 2: case 13: add(B, R); break;
            case 3: case 12: add(Lf, R); break;
            case 4: case 11: add(T, R); break;
            case 6: case 9: add(T, B); break;
            case 7: case 8: add(Lf, T); break;
            case 5: if (center) { add(Lf, T); add(B, R); } else { add(T, R); add(Lf, B); } break;
            case 10: if (center) { add(T, R); add(Lf, B); } else { add(Lf, T); add(B, R); } break;
          }
        }
        const used = new Uint8Array(sa.length), out = [];
        for (let s0 = 0; s0 < sa.length; s0++) {
          if (used[s0]) continue; used[s0] = 1;
          const start = sa[s0]; let cur = sb[s0]; const ring = [pt(start), pt(cur)];
          for (let g = 0; cur !== start && g < 1e6; g++) {
            const l = adj.get(cur); let nx = -1;
            for (const n of l) if (!used[n]) { nx = n; break; }
            if (nx < 0) break;
            used[nx] = 1; cur = sa[nx] === cur ? sb[nx] : sa[nx]; ring.push(pt(cur));
          }
          if (ring.length > 4) out.push(ring);
        }
        return out;
      };
      const smooth = (rs, eps, minLen) => rs.filter((r) => r.length * S >= (minLen || 0)).map((r) => rdp(chaikin(r, true, 2), eps));

      // ---------- road network (crack growth), kept out of the water ----------
      const M = 36, STEP = 6, GS = 48;
      const minX = -M, minY = -M, maxX = W + M, maxY = H + M;
      const roads = [], nodes = [], grid = new Map();
      const key = (i, j) => i * 100003 + j;
      const cellsOf = (a, b) => { const out = []; const i0 = Math.floor(Math.min(a[0], b[0]) / GS), i1 = Math.floor(Math.max(a[0], b[0]) / GS), j0 = Math.floor(Math.min(a[1], b[1]) / GS), j1 = Math.floor(Math.max(a[1], b[1]) / GS); for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.push(key(i, j)); return out; };
      const addSeg = (ri, si) => { const r = roads[ri]; for (const kk of cellsOf(r.pts[si], r.pts[si + 1])) { let c = grid.get(kk); if (!c) grid.set(kk, c = []); c.push(ri * 65536 + si); } };
      const segInter = (p, q, a, b) => { const rx = q[0] - p[0], ry = q[1] - p[1], sx = b[0] - a[0], sy = b[1] - a[1]; const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-9) return null; const u = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / den, t = ((a[0] - p[0]) * ry - (a[1] - p[1]) * rx) / den; if (u < 0 || u > 1 || t < 0 || t > 1) return null; return { u, t, cos: Math.abs((rx * sx + ry * sy) / (Math.hypot(rx, ry) * Math.hypot(sx, sy))) }; };
      const firstHit = (p, q, skipRoad) => {
        let best = null; const seen = new Set();
        for (const kk of cellsOf(p, q)) { const c = grid.get(kk); if (!c) continue; for (const id of c) { if (seen.has(id)) continue; seen.add(id); const ri = id >> 16, si = id & 65535; if (ri === skipRoad) continue; const r = roads[ri]; const h = segInter(p, q, r.pts[si], r.pts[si + 1]); if (h && h.u > 1e-6 && (!best || h.u < best.u)) best = { u: h.u, t: h.t, cos: h.cos, ri, si }; } }
        return best;
      };
      const distSeg = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l2 = dx * dx + dy * dy || 1; let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2; t = Math.max(0, Math.min(1, t)); return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
      const nearest = (p, R) => { let best = 1e9; const i0 = Math.floor((p[0] - R) / GS), i1 = Math.floor((p[0] + R) / GS), j0 = Math.floor((p[1] - R) / GS), j1 = Math.floor((p[1] + R) / GS); for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const c = grid.get(key(i, j)); if (!c) continue; for (const id of c) { const r = roads[id >> 16], si = id & 65535; const d = distSeg(p, r.pts[si], r.pts[si + 1]); if (d < best) best = d; } } return best; };
      const sideOf = (q) => q[0] < 0 ? 'L' : q[0] > W ? 'R' : q[1] < 0 ? 'T' : q[1] > H ? 'B' : '';
      const outside = (q) => q[0] < minX || q[0] > maxX || q[1] < minY || q[1] > maxY;
      const newNode = (x, y, side) => { nodes.push({ x, y, side: side || '' }); return nodes.length - 1; };
      const nodeNear = (p, R) => nodes.some((n) => Math.hypot(n.x - p[0], n.y - p[1]) < R);

      const trace = (start, ang, parentRoad, crossProb, maxLen) => {
        const pts = [start], events = []; let a = ang, curv = (rnd() - 0.5) * 0.0016, len = 0, skipCross = -1;
        for (let i = 0; i < 4000; i++) {
          curv = curv * 0.985 + (rnd() - 0.5) * 0.0003; curv = Math.max(-0.0012, Math.min(0.0012, curv)); a += curv * STEP; if (rnd() < 0.006) a += (rnd() - 0.5) * 0.5;
          const p = pts[pts.length - 1], q = [p[0] + Math.cos(a) * STEP, p[1] + Math.sin(a) * STEP];
          const h = firstHit(p, q, i < 2 ? parentRoad : skipCross);
          skipCross = -1;
          if (h) {
            if (h.cos > 0.87) return null;
            const hp = [p[0] + (q[0] - p[0]) * h.u, p[1] + (q[1] - p[1]) * h.u];
            len += Math.hypot(hp[0] - p[0], hp[1] - p[1]); pts.push(hp);
            events.push({ ri: h.ri, si: h.si, t: h.t, s: len, x: hp[0], y: hp[1] });
            const ahead = [hp[0] + Math.cos(a) * 26, hp[1] + Math.sin(a) * 26];
            if (rnd() < crossProb && waterAt(ahead[0], ahead[1]) < -0.3) { skipCross = h.ri; continue; }
            return { pts, len, events, end: 'hit' };
          }
          if (waterAt(q[0], q[1]) > -0.16) return null; // never into a lake or pond
          len += STEP; pts.push(q);
          if (outside(q)) return { pts, len, events, end: sideOf(q) };
          if (len > maxLen) return { pts, len, events, end: 'dead' };
        }
        return null;
      };
      const acceptable = (c, gap, minLen) => {
        if (!c || c.len < minLen) return false;
        const marks = [0].concat(c.events.map((e) => e.s));
        if (c.end === 'hit') marks.push(c.len);
        let acc = 0;
        for (let i = 1; i < c.pts.length; i++) {
          acc += Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]);
          if (marks.some((m) => Math.abs(acc - m) < gap * 1.05)) continue;
          const p = c.pts[i]; if (p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H) continue;
          if (nearest(p, gap) < gap) return false;
        }
        for (const e of c.events) if (nodeNear([e.x, e.y], gap * 0.45)) return false;
        return true;
      };
      const commit = (c, startNode, parentCut, cls) => {
        const ri = roads.length; const cum = [0];
        for (let i = 1; i < c.pts.length; i++) cum.push(cum[i - 1] + Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]));
        const r = { pts: c.pts, cum, cuts: [], cls }; roads.push(r);
        for (let si = 0; si < c.pts.length - 1; si++) addSeg(ri, si);
        r.cuts.push({ s: 0, n: startNode });
        if (parentCut) roads[parentCut.ri].cuts.push({ s: parentCut.s, n: startNode });
        for (const e of c.events) { const hr = roads[e.ri]; const n = newNode(e.x, e.y); hr.cuts.push({ s: hr.cum[e.si] + e.t * (hr.cum[e.si + 1] - hr.cum[e.si]), n }); r.cuts.push({ s: e.s, n }); }
        if (c.end !== 'hit') { const q = c.pts[c.pts.length - 1]; r.cuts.push({ s: cum[cum.length - 1], n: newNode(q[0], q[1], c.end === 'dead' ? '' : c.end) }); }
        return ri;
      };

      // a footpath around each lake, first, so other roads end on it
      const lakeRingLevel = rings(Wf, -0.34);
      for (const b of water) {
        if (!b.lake) continue;
        let best = null, bestLen = 1e9;
        for (const r of lakeRingLevel) { if (r.length < 20 || !inside([b.x, b.y], r)) continue; if (r.length < bestLen) { best = r; bestLen = r.length; } }
        if (!best) continue;
        let ring = chaikin(best, true, 2); ring.push(ring[0]); ring = resample(ring, 6);
        if (Math.hypot(ring[ring.length - 1][0] - ring[0][0], ring[ring.length - 1][1] - ring[0][1]) > 0.5) ring.push(ring[0].slice());
        const ri = roads.length; const cum = [0];
        for (let i = 1; i < ring.length; i++) cum.push(cum[i - 1] + Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]));
        const n0 = newNode(ring[0][0], ring[0][1]);
        roads.push({ pts: ring, cum, cuts: [{ s: 0, n: n0 }, { s: cum[cum.length - 1], n: n0 }], cls: 'path' });
        for (let si = 0; si < ring.length - 1; si++) addSeg(ri, si);
      }

      const inward = (side) => side === 0 ? 0 : side === 1 ? Math.PI : side === 2 ? Math.PI / 2 : -Math.PI / 2;
      const seeds = Math.max(3, Math.round((W + H) / (cell * 4.5)));
      for (let kk = 0, tries = 0; kk < seeds && tries < 300; tries++) {
        const side = kk % 4;
        const p = side < 2 ? [side === 0 ? minX + 1 : maxX - 1, H * (0.12 + 0.76 * rnd())] : [W * (0.12 + 0.76 * rnd()), side === 2 ? minY + 1 : maxY - 1];
        const c = trace(p, inward(side) + (rnd() - 0.5) * 0.9, -1, 1, 1e9);
        if (!c || c.end === 'dead' || c.end === 'hit' || !acceptable(c, cell * 0.55, cell)) continue; // through-roads run edge to edge
        commit(c, newNode(p[0], p[1], sideOf(p)), null, kk === 0 || (kk === 2 && seeds >= 5) ? 'main' : 'minor'); kk++;
      }
      let fails = 0;
      while (fails < 900 && roads.length < 4000 && roads.length) {
        let total = 0; for (const r of roads) total += r.cum[r.cum.length - 1];
        let pick = rnd() * total, ri = 0;
        while (ri < roads.length - 1 && pick > roads[ri].cum[roads[ri].cum.length - 1]) { pick -= roads[ri].cum[roads[ri].cum.length - 1]; ri++; }
        const r = roads[ri]; let si = 0; while (si < r.cum.length - 2 && r.cum[si + 1] < pick) si++;
        const a = r.pts[si], b = r.pts[si + 1]; const t = (pick - r.cum[si]) / ((r.cum[si + 1] - r.cum[si]) || 1);
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        if (p[0] < -10 || p[1] < -10 || p[0] > W + 10 || p[1] > H + 10 || nodeNear(p, cell * 0.42)) { fails++; continue; }
        const tang = Math.atan2(b[1] - a[1], b[0] - a[0]);
        const ang = tang + (rnd() < 0.5 ? 1 : -1) * (Math.PI / 2 + (rnd() - 0.5) * 0.9);
        const c = trace(p, ang, ri, 0.28, cell * 7);
        if (!acceptable(c, cell * 0.44, cell * 0.5) || c.end === 'dead') { fails++; continue; }
        const roll = rnd();
        commit(c, newNode(p[0], p[1]), { ri, s: pick }, roll < 0.2 && c.len > cell * 1.6 ? 'minor' : roll < 0.7 ? 'track' : 'path');
        fails = 0;
      }

      // graph
      const edges = [], adjN = nodes.map(() => []);
      for (const r of roads) {
        const cuts = r.cuts.slice().sort((x, y) => x.s - y.s);
        for (let kk = 0; kk < cuts.length - 1; kk++) {
          const a = cuts[kk], b = cuts[kk + 1]; if (b.s - a.s < 0.5) continue;
          const pts = [[nodes[a.n].x, nodes[a.n].y]];
          for (let i = 0; i < r.pts.length; i++) if (r.cum[i] > a.s + 0.5 && r.cum[i] < b.s - 0.5) pts.push(r.pts[i]);
          pts.push([nodes[b.n].x, nodes[b.n].y]);
          const e = edges.length; edges.push({ a: a.n, b: b.n, w: b.s - a.s, pts });
          adjN[a.n].push(e); if (b.n !== a.n) adjN[b.n].push(e);
        }
      }

      // a hamlet at a busy junction away from the water
      let village = null;
      for (let tries = 0; tries < 60 && !village; tries++) {
        const ni = Math.floor(rnd() * nodes.length), n = nodes[ni];
        if (!n || n.side || adjN[ni].length < 3) continue;
        if (n.x < W * 0.08 || n.x > W * 0.92 || n.y < H * 0.08 || n.y > H * 0.92) continue;
        if (!clear(n.x, n.y, 220)) continue;
        village = { x: n.x, y: n.y };
      }
      const buildings = [];
      let res = null;
      if (village) {
        for (let tries = 0; tries < 160 && buildings.length < 16; tries++) {
          const a = rnd() * Math.PI * 2, r = 22 + rnd() * 105;
          const x = village.x + Math.cos(a) * r * 1.25, y = village.y + Math.sin(a) * r * 0.85;
          if (nearest([x, y], 26) < 15 || waterAt(x, y) > -0.25) continue;
          if (buildings.some((b) => Math.hypot(b.x - x, b.y - y) < 25)) continue;
          const w = 12 + rnd() * 11, h = 9 + rnd() * 8, ang = -0.15 + (rnd() - 0.5) * 0.4, c = Math.cos(ang), sn = Math.sin(ang);
          buildings.push({ x, y, q: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => [x + u * c - v * sn, y + u * sn + v * c]) });
        }
        res = []; for (let i = 0; i < 40; i++) { const a = i / 40 * Math.PI * 2, rr = 1 + 0.22 * nV(Math.cos(a) * 1.5 + 4, Math.sin(a) * 1.5); res.push([village.x + Math.cos(a) * 175 * rr, village.y + Math.sin(a) * 115 * rr]); }
        res = chaikin(res, true, 2);
      }

      // land cover
      const Ff = field((x, y) => {
        let v = fbm(nF, x / 520, y / 520, 5, 0.52) + 0.02;
        if (village) { const dv = Math.hypot(x - village.x, y - village.y); if (dv < 240) v -= (240 - dv) / 240 * 0.7; }
        return v;
      });
      const ANG = -8.5 * Math.PI / 180, ca = Math.cos(ANG), sa = Math.sin(ANG);
      const parcels = [];
      for (let v = -700; v < H + 700;) {
        const rh = 110 + rnd() * 200;
        for (let u = -700; u < W + 700;) {
          const cw = 100 + rnd() * 240, g = 3, j = () => (rnd() - 0.5) * 10;
          const q = [[u + g + j(), v + g + j()], [u + cw - g + j(), v + g + j()], [u + cw - g + j(), v + rh - g + j()], [u + g + j(), v + rh - g + j()]].map(([x, y]) => [x * ca - y * sa, x * sa + y * ca]);
          const cx = (q[0][0] + q[2][0]) / 2, cy = (q[0][1] + q[2][1]) / 2;
          if (cx > -200 && cx < W + 200 && cy > -200 && cy < H + 200) parcels.push({ q, k: Math.floor(rnd() * 6) });
          u += cw;
        }
        v += rh;
      }
      const crowns = [];
      for (let i = 0, n = Math.round(area / 1000); i < n; i++) {
        const x = rnd() * W, y = rnd() * H, f = sample(Ff, x, y);
        if (f > 0.07 && waterAt(x, y) < -0.08) crowns.push([x, y, 3 + rnd() * 4.5 + (f > 0.22 ? 1.5 : 0), rnd() < 0.62 ? 0 : 1]);
      }
      const contours = [];
      for (let i = 0, t = -0.6; t <= 0.7; t += 0.1, i++) contours.push({ rings: smooth(rings(Hf, t), 0.8, 160), index: i % 3 === 0 });

      // a stream from the first lake out to the edge
      const rivers = [];
      const lake0 = water.find((b) => b.lake);
      if (lake0) {
        const toEdge = [[-1, 0, lake0.x], [1, 0, W - lake0.x], [0, -1, lake0.y], [0, 1, H - lake0.y]].sort((p, q) => p[2] - q[2])[Math.floor(rnd() * 2)];
        let x = lake0.x, y = lake0.y, h = Math.atan2(toEdge[1], toEdge[0]) + (rnd() - 0.5) * 0.6;
        const pts = [[x, y]];
        for (let i = 0; i < 1200; i++) {
          h += nV(x / 220, y / 220) * 0.22;
          x += Math.cos(h) * 8; y += Math.sin(h) * 8; pts.push([x, y]);
          if (x < -40 || y < -40 || x > W + 40 || y > H + 40) break;
        }
        rivers.push(chaikin(pts, false, 2));
      }

      let cycle = -1;
      for (let i = 0; i < roads.length; i++) if (roads[i].cls === 'minor') { cycle = i; break; }

      return {
        parcels, res, buildings: buildings.map((b) => b.q), crowns, contours, rivers, cycle,
        forest: smooth(rings(Ff, 0), 0.55), dense: smooth(rings(Ff, 0.2), 0.55),
        water: smooth(rings(Wf, 0), 0.5),
        roads: roads.map((r) => ({ pts: r.pts, cls: r.cls })),
        graph: { nodes, edges, adj: adjN }
      };
    }

    drawWorld(c, wd, pal, W, H) {
      const poly = (pts, closed) => { c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]); if (closed) c.closePath(); };
      c.fillStyle = pal.base; c.fillRect(0, 0, W, H);
      for (let k = 0; k < 6; k++) { c.beginPath(); for (const p of wd.parcels) if (p.k === k) poly(p.q, true); c.fillStyle = pal.fields[k]; c.fill(); }
      if (wd.res) { c.beginPath(); poly(wd.res, true); c.fillStyle = pal.res; c.fill(); }
      c.beginPath(); for (const r of wd.forest) poly(r, true); c.fillStyle = pal.forest; c.fill('evenodd');
      c.beginPath(); for (const r of wd.dense) poly(r, true); c.fillStyle = pal.dense; c.fill('evenodd');
      c.globalAlpha = pal.crownOp;
      for (const tone of [0, 1]) { c.beginPath(); for (const t of wd.crowns) if (t[3] === tone) { c.moveTo(t[0] + t[2], t[1]); c.arc(t[0], t[1], t[2], 0, 6.2832); } c.fillStyle = tone ? pal.crownB : pal.crownA; c.fill(); }
      c.strokeStyle = pal.contour;
      for (const lv of wd.contours) { c.beginPath(); for (const r of lv.rings) poly(r, true); c.globalAlpha = lv.index ? pal.indexOp : pal.contourOp; c.lineWidth = lv.index ? 1.6 : 1; c.stroke(); }
      c.globalAlpha = 1;
      c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath(); for (const r of wd.rivers) poly(r, false); c.strokeStyle = pal.shore; c.lineWidth = pal.river + 4; c.stroke();
      c.beginPath(); for (const r of wd.water) poly(r, true); c.fillStyle = pal.water; c.fill('evenodd'); c.strokeStyle = pal.shore; c.lineWidth = 2.5; c.stroke();
      c.beginPath(); for (const r of wd.rivers) poly(r, false); c.strokeStyle = pal.water; c.lineWidth = pal.river; c.stroke();
      const of = (cls) => wd.roads.filter((r) => r.cls === cls);
      c.setLineDash([0.1, 6.5]); c.lineWidth = 2.8; c.strokeStyle = pal.path; c.globalAlpha = pal.pathOp;
      c.beginPath(); for (const r of of('path')) poly(r.pts, false); c.stroke();
      c.setLineDash([9, 6]); c.lineWidth = 3; c.strokeStyle = pal.track; c.globalAlpha = pal.trackOp;
      c.beginPath(); for (const r of of('track')) poly(r.pts, false); c.stroke();
      c.setLineDash([]); c.globalAlpha = 1;
      if (wd.cycle >= 0) { c.beginPath(); poly(wd.roads[wd.cycle].pts, false); c.strokeStyle = pal.cycle; c.globalAlpha = pal.cycleOp; c.lineWidth = 17; c.stroke(); c.globalAlpha = 1; }
      for (const [cls, cw, fw, cc, fc] of [['minor', 10, 6.5, pal.minorCase, pal.minor], ['main', 14, 10, pal.roadCase, pal.road]]) {
        const rs = of(cls); if (!rs.length) continue;
        c.beginPath(); for (const r of rs) poly(r.pts, false);
        c.strokeStyle = cc; c.lineWidth = cw; c.stroke(); c.strokeStyle = fc; c.lineWidth = fw; c.stroke();
      }
      if (wd.buildings.length) { c.beginPath(); for (const b of wd.buildings) poly(b, true); c.fillStyle = pal.bld; c.fill(); c.strokeStyle = pal.bldEdge; c.lineWidth = 1; c.stroke(); }
    }

    // Dijkstra over the network; returns the route as one polyline from A to B.
    shortestRoute(g, A, B) {
      const N = g.nodes.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), done = new Uint8Array(N);
      dist[A] = 0; const heap = [[0, A]];
      const push = (it) => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; const tmp = heap[p]; heap[p] = heap[i]; heap[i] = tmp; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; const tmp = heap[m]; heap[m] = heap[i]; heap[i] = tmp; i = m; } } return top; };
      while (heap.length) {
        const top = pop(), d = top[0], u = top[1];
        if (done[u]) continue; done[u] = 1; if (u === B) break;
        for (const e of g.adj[u]) { const ed = g.edges[e]; if (ed.a === ed.b) continue; const v = ed.a === u ? ed.b : ed.a; const nd = d + ed.w; if (nd < dist[v]) { dist[v] = nd; prev[v] = e; push([nd, v]); } }
      }
      if (!isFinite(dist[B])) return null;
      const pts = []; let u = B;
      while (u !== A) {
        const ed = g.edges[prev[u]];
        const seg = ed.a === u ? ed.pts : ed.pts.slice().reverse();
        for (let i = pts.length ? 1 : 0; i < seg.length; i++) pts.push(seg[i]);
        u = ed.a === u ? ed.b : ed.a;
      }
      return pts.reverse();
    }
  }

  function mountAll() {
    var dark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
    var canvases = document.querySelectorAll("canvas[data-trail-map]");
    for (var i = 0; i < canvases.length; i++) {
      (function (canvas) {
        var props = function () {
          return {
            style: dark && dark.matches ? "Night" : "Day",
            seed: Number(canvas.dataset.seed) || 0,
            density: Number(canvas.dataset.density || 175),
            speed: Number(canvas.dataset.speed || 140)
          };
        };
        var run = new TrailMap(props).start(canvas);
        if (dark) {
          var redraw = function () { run.rebuild(); };
          if (dark.addEventListener) dark.addEventListener("change", redraw); else if (dark.addListener) dark.addListener(redraw);
        }
      })(canvases[i]);
    }
  }

  window.NavitalsTrailMap = { TrailMap: TrailMap };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountAll); else mountAll();
})();
