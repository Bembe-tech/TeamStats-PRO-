// World generator for the Map Creator (/map-creator.html).
// Builds a map from seeded noise + a shape preset. Coordinates are normalised (0..1), so a small
// preview and the full-size map come out the same. Output cells: 0 water, 1..31 land (height 0..30), 255 void.
(function (root) {
  "use strict";
  const WATER = 0, VOID = 255;

  function hash2(x, y, seed) {
    let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  function vnoise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed), c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct, seed) {
    let s = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < oct; o++) { s += amp * vnoise(x * f, y * f, seed + o * 101); norm += amp; amp *= 0.5; f *= 2.03; }
    return s / norm;
  }
  function ridged(x, y, oct, seed) {
    let s = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < oct; o++) { const n = 1 - Math.abs(vnoise(x * f, y * f, seed + o * 57) * 2 - 1); s += amp * n * n; norm += amp; amp *= 0.5; f *= 2.1; }
    return s / norm;
  }
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
  const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  // Presets: shape + slider defaults. land = share of the map that is land (before void).
  const PRESETS = {
    continents: { name: "Continents", desc: "One or more big landmasses in an ocean", land: 42, count: 1, scale: 50, rough: 50, detail: 55, mtn: 55, ranges: 45, rivers: 4, islands: 15 },
    archipelago: { name: "Archipelago", desc: "Hundreds of islands, naval play", land: 30, count: 1, scale: 25, rough: 55, detail: 60, mtn: 35, ranges: 20, rivers: 0, islands: 45 },
    pangaea: { name: "Pangaea", desc: "One huge continent with inland seas", land: 62, count: 1, scale: 55, rough: 45, detail: 55, mtn: 60, ranges: 55, rivers: 6, islands: 10 },
    fractured: { name: "Fractured", desc: "Many mid-sized lands split by channels", land: 48, count: 6, scale: 40, rough: 75, detail: 60, mtn: 50, ranges: 40, rivers: 3, islands: 20 },
    inland: { name: "Inland sea", desc: "Land all around a central sea", land: 62, count: 1, scale: 50, rough: 50, detail: 55, mtn: 55, ranges: 45, rivers: 5, islands: 20 },
    ring: { name: "Ring world", desc: "A ring of land around a central lake", land: 34, count: 1, scale: 45, rough: 45, detail: 55, mtn: 50, ranges: 50, rivers: 2, islands: 10 },
    strait: { name: "Strait", desc: "Two coasts facing each other across a channel", land: 62, count: 1, scale: 50, rough: 45, detail: 55, mtn: 55, ranges: 50, rivers: 6, islands: 15 },
    coast: { name: "Coastline", desc: "Land on one side, open ocean on the other", land: 55, count: 1, scale: 50, rough: 55, detail: 55, mtn: 55, ranges: 50, rivers: 6, islands: 25 },
    lakes: { name: "Lake land", desc: "Mostly land, full of lakes", land: 78, count: 1, scale: 35, rough: 50, detail: 55, mtn: 45, ranges: 35, rivers: 4, islands: 0 },
    rivers: { name: "River land", desc: "Land cut by long rivers", land: 85, count: 1, scale: 50, rough: 40, detail: 50, mtn: 50, ranges: 40, rivers: 14, islands: 0 },
    arc: { name: "Island arc", desc: "A curved chain of islands", land: 26, count: 1, scale: 30, rough: 55, detail: 60, mtn: 55, ranges: 50, rivers: 0, islands: 25 },
    highlands: { name: "Highlands", desc: "Rugged land with long mountain ranges", land: 55, count: 2, scale: 45, rough: 55, detail: 65, mtn: 85, ranges: 90, rivers: 8, islands: 10 },
  };

  // Folds coordinates for symmetric (fair) team maps.
  function fold(u, v, sym) {
    switch (sym) {
      case "x": return [u > 0.5 ? 1 - u : u, v];
      case "y": return [u, v > 0.5 ? 1 - v : v];
      case "xy": return [u > 0.5 ? 1 - u : u, v > 0.5 ? 1 - v : v];
      case "rot": return u > 0.5 ? [1 - u, 1 - v] : [u, v];
      default: return [u, v];
    }
  }
  function mirrors(u, v, sym) {
    switch (sym) {
      case "x": return [[u, v], [1 - u, v]];
      case "y": return [[u, v], [u, 1 - v]];
      case "xy": return [[u, v], [1 - u, v], [u, 1 - v], [1 - u, 1 - v]];
      case "rot": return [[u, v], [1 - u, 1 - v]];
      default: return [[u, v]];
    }
  }

  function generate(W, H, p) {
    const seed = (p.seed | 0) || 1, R = rng(seed * 7919 + 13), aspect = W / H;
    const preset = p.preset;
    // continent centres (in folded space when symmetric, so every side gets the same lands)
    const centers = [];
    const nC = preset === "continents" || preset === "fractured" || preset === "highlands" ? Math.max(1, p.count | 0) : 1;
    const symSpan = { x: [0.5, 1], y: [1, 0.5], xy: [0.5, 0.5], rot: [0.5, 1] }[p.sym] || [1, 1];
    for (let i = 0; i < nC; i++) {
      if (nC === 1 && p.sym === "none") { centers.push([0.5, 0.5]); break; }
      let best = null, bestD = -1;
      for (let t = 0; t < 30; t++) { // spread the centres out
        const c = [0.12 + R() * (symSpan[0] - 0.12 - (symSpan[0] === 1 ? 0.12 : 0.04)), 0.14 + R() * (symSpan[1] - 0.14 - (symSpan[1] === 1 ? 0.14 : 0.04))];
        let d = 9; for (const o of centers) d = Math.min(d, Math.hypot((c[0] - o[0]) * aspect, c[1] - o[1]));
        if (d > bestD) { bestD = d; best = c; }
      }
      centers.push(best);
    }
    const nMirror = { x: 2, y: 2, xy: 4, rot: 2 }[p.sym] || 1;
    const radius = 0.5 / Math.sqrt(nC * nMirror) * (0.75 + p.land / 100 * 0.6);
    const F = (preset === "archipelago" ? 7 : preset === "arc" ? 6 : preset === "lakes" ? 4.5 : 2.4) * (1.6 - p.scale / 100 * 1.1);
    const warp = 0.15 + p.rough / 100 * 0.9;
    const oct = 3 + Math.round(p.detail / 100 * 5);
    const phase = R() * 6.28, phase2 = R() * 6.28;

    // sample on a coarser grid, then interpolate (invisible at map scale, 4-9x faster)
    const step = Math.max(1, Math.round(Math.max(W, H) / 900));
    const gw = Math.ceil(W / step) + 2, gh = Math.ceil(H / step) + 2;
    const gF = new Float32Array(gw * gh), gR = new Float32Array(gw * gh);
    // Symmetric maps average the field over the mirror images: exactly fair and seamless.
    const allCenters = [];
    for (const c of centers) for (const m of mirrors(c[0], c[1], p.sym)) allCenters.push(m);
    function raw(u, v) {
      const X = u * aspect, Y = v;
      const wx = X + warp * (fbm(X * F * 0.45 + 3.1, Y * F * 0.45, 3, seed + 11) - 0.5) * 2 / F * 2.2;
      const wy = Y + warp * (fbm(X * F * 0.45, Y * F * 0.45 + 7.7, 3, seed + 17) - 0.5) * 2 / F * 2.2;
      let n = fbm(wx * F, wy * F, oct, seed);
      let s = 0;
      const dx = (u - 0.5) * aspect, dy = v - 0.5, dc = Math.hypot(dx, dy) / Math.min(1, aspect) * 2; // 0 centre .. ~1 edge
      switch (preset) {
        case "continents": case "fractured": case "highlands": {
          let d = 9; for (const c of allCenters) d = Math.min(d, Math.hypot((wx - c[0] * aspect), wy - c[1]) / radius);
          s = 0.42 - (preset === "fractured" ? 0.9 : 0.62) * d * d;
          if (preset === "fractured") s -= 0.42 * smooth(0.6, 0.8, 1 - Math.abs(fbm(wx * F * 1.3, wy * F * 1.3, 3, seed + 41) * 2 - 1));
          break;
        }
        case "archipelago": { const e = Math.min(u, v, 1 - u, 1 - v); s = -0.05 - (e < 0.07 ? (0.07 - e) * 5 : 0); break; }
        case "pangaea": {
          const d = Math.hypot(wx - 0.5 * aspect, wy - 0.5) / (0.42 * Math.max(1, aspect * 0.8));
          s = 0.45 - 0.55 * d * d - 0.28 * smooth(0.62, 0.78, fbm(wx * 2.2, wy * 2.2, 3, seed + 31)); break;
        }
        case "inland": { s = -0.45 + 0.75 * Math.min(1.3, dc) ; s -= Math.min(u, v, 1 - u, 1 - v) < 0.03 ? 0.4 : 0; break; }
        case "ring": { const r = Math.hypot(wx - 0.5 * aspect, wy - 0.5) / 0.5; s = 0.36 - 5.5 * (r - 0.62) * (r - 0.62); break; }
        case "strait": { const c = 0.5 + 0.07 * Math.sin(wx * 6.28 * 0.9 / aspect * 1.5 + phase); s = Math.min(0.5, Math.abs(wy - c) * 2.4) - 0.2; break; }
        case "coast": { const c = 0.52 + 0.08 * Math.sin(wy * 6.28 + phase); s = (c - wx / aspect) * 1.5; break; }
        case "lakes": n = 1 - n; s = 0.08; break;
        case "rivers": s = 0.4; break;
        case "arc": {
          const cx = 0.5 * aspect, cy = 1.25, rr = Math.hypot(wx - cx, wy - cy), R0 = 0.95;
          const ang = Math.abs(Math.atan2(wx - cx, cy - wy));
          s = 0.25 - 3.2 * Math.abs(rr - R0) - (ang > 0.75 ? (ang - 0.75) * 2 : 0); break;
        }
      }
      return [n, s, ridged(wx * F * 1.7 + 5, wy * F * 1.7, 4, seed + 77)];
    }
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const imgs = mirrors(Math.min(1, gx * step / W), Math.min(1, gy * step / H), p.sym);
      let a = 0, sh = 0, b = 0;
      for (const [u, v] of imgs) { const r = raw(u, v); a += r[0]; sh += r[1]; b += r[2]; }
      const k = imgs.length, n = 0.5 + (a / k - 0.5) * Math.sqrt(k); // averaging flattens noise; restore its contrast
      const i = gy * gw + gx;
      gF[i] = n * 0.62 + sh / k; gR[i] = b / k;
    }
    // interpolate
    const field = new Float32Array(W * H), ridge = new Float32Array(W * H);
    for (let y = 0; y < H; y++) {
      const gy = y / step, y0 = gy | 0, fy = gy - y0;
      for (let x = 0; x < W; x++) {
        const gx = x / step, x0 = gx | 0, fx = gx - x0, i0 = y0 * gw + x0, i = y * W + x;
        const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
        field[i] = gF[i0] * a + gF[i0 + 1] * b + gF[i0 + gw] * c + gF[i0 + gw + 1] * d;
        ridge[i] = gR[i0] * a + gR[i0 + 1] * b + gR[i0 + gw] * c + gR[i0 + gw + 1] * d;
      }
    }
    // map edge (void shapes)
    const out = new Uint8Array(W * H);
    const isVoid = new Uint8Array(W * H);
    if (p.edge && p.edge !== "ocean") {
      const t = 0.035;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W, v = (y + 0.5) / H; let vd = false;
        if (p.edge === "frame") vd = Math.min(u, v, 1 - u, 1 - v) < t * Math.min(1, 1 / aspect) * (aspect > 1 ? 1 : aspect);
        else if (p.edge === "round") vd = ((u - 0.5) / 0.5) ** 2 + ((v - 0.5) / 0.5) ** 2 > 1;
        else if (p.edge === "diamond") vd = Math.abs(u - 0.5) / 0.5 + Math.abs(v - 0.5) / 0.5 > 1;
        if (vd) isVoid[y * W + x] = 1;
      }
    }
    // sea level as a quantile so "land" means the same on every preset
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < field.length; i++) if (!isVoid[i]) { const f = field[i]; if (f < lo) lo = f; if (f > hi) hi = f; }
    const hist = new Uint32Array(2048), span = hi - lo || 1; let cnt = 0;
    for (let i = 0; i < field.length; i++) if (!isVoid[i]) { hist[Math.min(2047, ((field[i] - lo) / span * 2048) | 0)]++; cnt++; }
    const target = cnt * (1 - p.land / 100);
    let acc = 0, bin = 0; while (bin < 2047 && acc + hist[bin] < target) acc += hist[bin++];
    const sea = lo + bin / 2048 * span, top = hi - sea || 1;
    const mtn = p.mtn / 100, rg = p.ranges / 100;
    for (let i = 0; i < field.length; i++) {
      if (isVoid[i]) { out[i] = VOID; continue; }
      const f = field[i];
      if (f < sea) { out[i] = WATER; continue; }
      const e = (f - sea) / top;
      let h = Math.pow(e, 2 - mtn * 1.1) * (0.25 + mtn * 0.8);
      h += rg * 0.6 * Math.pow(ridge[i], 3) * smooth(0.04, 0.4, e) * (0.3 + mtn * 0.9);
      out[i] = 1 + Math.max(0, Math.min(30, Math.round(h * 30)));
    }
    // small islands in open water
    if (p.islands > 0) {
      const Fi = 16 * (1.5 - p.scale / 100 * 0.8), thr = 0.78 - p.islands / 100 * 0.16;
      for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x++) {
        const i = y * W + x; if (out[i] !== WATER) continue;
        const [u, v] = fold((x + 0.5) / W, (y + 0.5) / H, p.sym);
        const n = fbm(u * aspect * Fi, v * Fi, 3, seed + 501);
        if (n > thr) out[i] = 1 + Math.min(30, Math.round((n - thr) * 60));
      }
    }
    // rivers: walk downhill from high ground to the sea, carving water
    if (p.rivers > 0) carveRivers(out, field, W, H, p, R, sea);
    return out;
  }

  function carveRivers(out, field, W, H, p, R, sea) {
    const width = Math.max(1, Math.round(Math.max(W, H) / 900 * (1 + p.scale / 100)));
    const stepLen = Math.max(1, Math.round(Math.max(W, H) / 600));
    const starts = [];
    const span = { x: [0.5, 1], y: [1, 0.5], xy: [0.5, 0.5], rot: [0.5, 1] }[p.sym] || [1, 1];
    for (let t = 0; t < 600 && starts.length < p.rivers; t++) {
      const u = R() * span[0], v = R() * span[1], x = (u * W) | 0, y = (v * H) | 0, i = y * W + x;
      if (out[i] === WATER || out[i] === VOID) continue;
      if (field[i] < sea + (field[i] - sea) * 0 && R() < 0.5) continue;
      const hgt = out[i] - 1;
      if (hgt < 6 && R() < 0.8) continue;
      starts.push([x, y]);
    }
    const carve = (x, y) => {
      for (const [mu, mv] of mirrors((x + 0.5) / W, (y + 0.5) / H, p.sym)) {
        const cx = Math.round(mu * W - 0.5), cy = Math.round(mv * H - 0.5);
        for (let oy = -width; oy <= width; oy++) for (let ox = -width; ox <= width; ox++) {
          if (ox * ox + oy * oy > width * width + 0.5) continue;
          const xx = cx + ox, yy = cy + oy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const j = yy * W + xx; if (out[j] !== VOID) out[j] = WATER;
        }
      }
    };
    for (const [sx, sy] of starts) {
      let x = sx, y = sy, dirx = 0, diry = 0;
      const path = [];
      const ph = R() * 6.28;
      for (let s = 0; s < 4000; s++) {
        path.push([x, y]);
        // among the downhill directions pick the one closest to a slowly swinging heading, so rivers meander
        const here = field[y * W + x], heading = Math.atan2(diry, dirx) + (vnoise(s * 0.09, ph * 10, 3) - 0.5) * 2.2;
        let best = null, bestScore = -Infinity, low = null, lowV = Infinity;
        for (let k = 0; k < 16; k++) {
          const a = k / 16 * Math.PI * 2, nx = Math.round(x + Math.cos(a) * stepLen), ny = Math.round(y + Math.sin(a) * stepLen);
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const val = field[ny * W + nx];
          if (val < lowV) { lowV = val; low = [nx, ny, Math.cos(a), Math.sin(a)]; }
          if (val >= here) continue;
          const score = (s === 0 && !dirx && !diry ? 0 : Math.cos(a - heading)) + (here - val) * 40;
          if (score > bestScore) { bestScore = score; best = [nx, ny, Math.cos(a), Math.sin(a)]; }
        }
        if (!best) best = low;
        if (!best) break;
        dirx = best[2]; diry = best[3]; x = best[0]; y = best[1];
        const v = out[y * W + x];
        if (v === WATER || v === VOID || x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) { path.push([x, y]); break; }
      }
      const end = out[y * W + x];
      if (path.length < 8 || (end !== WATER && !(x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1))) continue; // never reached the sea
      for (let k = 1; k < path.length; k++) {
        const [ax, ay] = path[k - 1], [bx, by] = path[k], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
        for (let t = 0; t <= n; t++) carve(Math.round(ax + (bx - ax) * t / n), Math.round(ay + (by - ay) * t / n));
      }
    }
  }

  root.WorldGen = { PRESETS, generate };
})(typeof self !== "undefined" ? self : this);
