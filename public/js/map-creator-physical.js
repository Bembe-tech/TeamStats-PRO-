// "Physical map" reader for the Map Creator's Image to map (/map-creator.html).
// Turns a physical / topographic map picture (green lowlands -> yellow -> brown mountains, blue sea,
// rivers and lakes, white surroundings, labels, borders, watermarks) into OpenFront cells:
// 0 water, 1..31 land (height 0..30), 255 void. Works in the browser and in Node.
(function (root) {
  "use strict";
  const WATER = 0, VOID = 255;
  // Common hypsometric tints, low to high, placed on OpenFront's height scale (x30):
  // greens = plains (0-9), yellows = highland (10-19), oranges and browns = mountains (20-30).
  const RAMP = [[0, [60, 120, 70]], [0.1, [100, 165, 90]], [0.25, [170, 205, 120]], [0.36, [230, 225, 150]], [0.5, [240, 200, 130]], [0.62, [215, 150, 90]], [0.8, [170, 105, 70]], [1, [120, 75, 55]]];
  let rampLut = null;
  // Height of a colour = position of its nearest point on the tint ramp (cached on 5-bit colour).
  function rampHeight(r, g, b) {
    if (!rampLut) rampLut = new Float32Array(32768).fill(-1);
    const k = (r >> 3) << 10 | (g >> 3) << 5 | (b >> 3);
    let v = rampLut[k];
    if (v >= 0) return v;
    const R = (r >> 3) * 8 + 4, G = (g >> 3) * 8 + 4, B = (b >> 3) * 8 + 4;
    let best = 1e9;
    for (let i = 1; i < RAMP.length; i++) {
      const [ha, a] = RAMP[i - 1], [hb, c] = RAMP[i];
      const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2], L = dx * dx + dy * dy + dz * dz;
      let t = ((R - a[0]) * dx + (G - a[1]) * dy + (B - a[2]) * dz) / L; t = Math.max(0, Math.min(1, t));
      const ex = a[0] + dx * t - R, ey = a[1] + dy * t - G, ez = a[2] + dz * t - B, d = ex * ex + ey * ey + ez * ez;
      if (d < best) { best = d; v = ha + (hb - ha) * t; }
    }
    rampLut[k] = v;
    return v;
  }
  function hash2(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2246822519) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
  function vnoise(x, y, s) { const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf); const a = hash2(xi, yi, s), b = hash2(xi + 1, yi, s), c = hash2(xi, yi + 1, s), d = hash2(xi + 1, yi + 1, s); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; }
  function fbm(x, y, o, s) { let t = 0, a = 1, n = 0, f = 1; for (let i = 0; i < o; i++) { t += a * vnoise(x * f, y * f, s + i * 101); n += a; a *= 0.5; f *= 2.03; } return t / n; }
  function boxBlur(a, w, h, r) {
    if (r < 1) return a;
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length), d = 2 * r + 1;
    for (let y = 0; y < h; y++) { let s = 0; const row = y * w; for (let k = -r; k <= r; k++) s += a[row + Math.min(w - 1, Math.max(0, k))]; for (let x = 0; x < w; x++) { tmp[row + x] = s / d; s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; } }
    for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]; for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; } }
    return out;
  }
  // Connected components of mask==val (4-neighbour). Calls fn(indices, count, touchesBorder).
  function components(mask, w, h, val, fn) {
    const n = w * h, seen = new Uint8Array(n), q = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (seen[s] || mask[s] !== val) continue;
      let head = 0, tail = 0, edge = false; q[tail++] = s; seen[s] = 1;
      while (head < tail) {
        const i = q[head++], x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) edge = true;
        if (x > 0 && !seen[i - 1] && mask[i - 1] === val) { seen[i - 1] = 1; q[tail++] = i - 1; }
        if (x < w - 1 && !seen[i + 1] && mask[i + 1] === val) { seen[i + 1] = 1; q[tail++] = i + 1; }
        if (i >= w && !seen[i - w] && mask[i - w] === val) { seen[i - w] = 1; q[tail++] = i - w; }
        if (i < n - w && !seen[i + w] && mask[i + w] === val) { seen[i + w] = 1; q[tail++] = i + w; }
      }
      fn(q.subarray(0, tail), tail, edge);
    }
  }
  function dilate(mask, w, h, r) {
    if (r <= 0) return mask;
    const out = new Uint8Array(mask.length), R = Math.ceil(r), r2 = r * r + 0.3;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
        if (ox * ox + oy * oy > r2) continue;
        const xx = x + ox, yy = y + oy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
      }
    }
    return out;
  }

  function erode(mask, w, h, r) {
    if (r <= 0) return mask;
    const inv = new Uint8Array(mask.length); for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
    const d = dilate(inv, w, h, r), out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = d[i] ? 0 : 1;
    return out;
  }

  // Zhang-Suen thinning: reduces a mask to 1-pixel centre lines.
  function thin(mask, w, h) {
    const m = mask.slice(); let changed = true, list = [];
    for (let i = 0; i < m.length; i++) if (m[i]) list.push(i);
    const P = i => [m[i - w], m[i - w + 1], m[i + 1], m[i + w + 1], m[i + w], m[i + w - 1], m[i - 1], m[i - w - 1]];
    while (changed) {
      changed = false;
      for (let pass = 0; pass < 2; pass++) {
        const del = [];
        for (const i of list) {
          if (!m[i]) continue;
          const x = i % w; if (x < 1 || x >= w - 1 || i < w || i >= m.length - w) continue;
          const nb = P(i); let B = 0, A = 0;
          for (let k = 0; k < 8; k++) { B += nb[k] ? 1 : 0; if (!nb[k] && nb[(k + 1) % 8]) A++; }
          if (B < 2 || B > 6 || A !== 1) continue;
          if (pass === 0 ? (nb[0] && nb[2] && nb[4]) || (nb[2] && nb[4] && nb[6]) : (nb[0] && nb[2] && nb[6]) || (nb[0] && nb[4] && nb[6])) continue;
          del.push(i);
        }
        if (del.length) { changed = true; for (const i of del) m[i] = 0; }
      }
      list = list.filter(i => m[i]);
    }
    return m;
  }
  // Draws a straight 4-connected line into mask.
  function line(mask, w, x0, y0, x1, y1) {
    let x = x0, y = y0; const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    for (let k = 0; k < 4000; k++) {
      mask[y * w + x] = 1;
      if (x === x1 && y === y1) break;
      if (2 * err > -dy) { err -= dy; x += sx; } else { err += dx; y += sy; }
    }
  }
  // Rivers the way OpenFront maps draw them: clean centre lines of even width, gaps bridged,
  // ends joined to the nearest water ahead (another river, a lake or the sea), lakes kept as shapes.
  function riverNetwork(land, inland, weak, sea, w, h, sc, width) {
    const n = w * h, raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = land[i] && (inland[i] || (weak[i] && !sea[i])) ? 1 : 0;
    // lakes: the thick parts survive an opening
    const k = Math.max(1, Math.round(3 * sc));
    const lakes = dilate(erode(raw, w, h, k), w, h, k);
    // centre lines: close the small gaps first, drop crumbs, thin
    const gap = Math.max(1, Math.round(3 * Math.max(sc, 0.4)));
    const closed = dilate(raw, w, h, gap);
    const minBlue = Math.max(6, Math.round(120 * sc * sc));
    components(closed, w, h, 1, (idx, cnt) => { if (cnt < minBlue) for (const i of idx) closed[i] = 0; });
    const sk = thin(closed, w, h);
    // label skeleton pieces (8-connected)
    const lab = new Int32Array(n), q = new Int32Array(n); let L = 0;
    for (let s = 0; s < n; s++) {
      if (!sk[s] || lab[s]) continue; L++; let head = 0, tail = 0; q[tail++] = s; lab[s] = L;
      while (head < tail) { const i = q[head++]; for (const d of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) { const j = i + d; if (j >= 0 && j < n && sk[j] && !lab[j] && Math.abs((j % w) - (i % w)) <= 1) { lab[j] = L; q[tail++] = j; } } }
    }
    // bridge from every line end to water ahead of it
    const G = Math.max(4, Math.round(16 * sc)), bridges = [];
    for (let i = w; i < n - w; i++) {
      if (!sk[i]) continue;
      const x = i % w; if (x < 1 || x >= w - 1) continue;
      let nbs = 0, nb = -1; for (const d of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) if (sk[i + d]) { nbs++; nb = i + d; }
      if (nbs !== 1) continue;
      // heading: from a few pixels back along the line towards the end
      let back = nb, prev = i;
      for (let t = 0; t < 5; t++) { let nx = -1; for (const d of [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1]) { const j = back + d; if (j !== prev && sk[j] && j !== i) { nx = j; break; } } if (nx < 0) break; prev = back; back = nx; }
      const hx = x - back % w, hy = ((i / w) | 0) - ((back / w) | 0), hl = Math.hypot(hx, hy) || 1;
      const y = (i / w) | 0; let best = -1, bestD = 1e9;
      for (let oy = -G; oy <= G; oy++) for (let ox = -G; ox <= G; ox++) {
        const d2 = ox * ox + oy * oy; if (d2 > G * G || d2 < 4) continue;
        const xx = x + ox, yy = y + oy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx, target = (sk[j] && lab[j] !== lab[i]) || lakes[j] && lab[j] !== lab[i] || !land[j];
        if (!target) continue;
        const dot = (ox * hx + oy * hy) / (Math.sqrt(d2) * hl);
        if (dot < 0.35) continue;
        const cost = d2 * (1.6 - dot);
        if (cost < bestD) { bestD = cost; best = j; }
      }
      if (best >= 0) bridges.push([x, y, best % w, (best / w) | 0]);
    }
    for (const [x0, y0, x1, y1] of bridges) line(sk, w, x0, y0, x1, y1);
    // make diagonal steps 4-connected so water stays one body in the game
    for (let i = w; i < n - w; i++) if (sk[i]) {
      if (sk[i + w + 1] && !sk[i + 1] && !sk[i + w]) sk[i + 1] = 1;
      if (sk[i + w - 1] && !sk[i - 1] && !sk[i + w]) sk[i - 1] = 1;
    }
    // width: the chosen width, plus more where the river is drawn thicker in the image (big rivers stay big)
    const dist = new Float32Array(n).fill(-1); let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (!closed[i]) { dist[i] = 0; q[tail++] = i; }
    while (head < tail) { const i = q[head++], x = i % w; for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < n && dist[j] < 0) { dist[j] = dist[i] + 1; q[tail++] = j; } }
    const base = Math.max(0, (width * sc - 1) / 2), out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!sk[i]) continue;
      const extra = Math.max(0, (dist[i] < 0 ? 0 : dist[i]) - gap - 1) * 0.8;
      const r = base + Math.min(extra, 4 * Math.max(sc, 0.3)), R = Math.ceil(r), r2 = r * r + 0.3, x = i % w, y = (i / w) | 0;
      for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
        if (ox * ox + oy * oy > r2) continue;
        const xx = x + ox, yy = y + oy; if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
      }
    }
    for (let i = 0; i < n; i++) if (lakes[i]) out[i] = 1;
    return out;
  }
  // Pixel kinds: 0 unknown (labels, borders, ink), 1 land, 2 strong blue (sea/lake), 3 background (white/grey paper).
  function classify(px, n, w, h) {
    const kind = new Uint8Array(n), hgt = new Float32Array(n), weak = new Uint8Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      const r = px[q], g = px[q + 1], b = px[q + 2], a = px[q + 3];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx - mn, lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
      if (a < 20) { kind[i] = 3; continue; }
      if (b > r + 28 && b >= g + 8 && sat > 35) { kind[i] = 2; continue; }
      if (sat < 32 && lum > 0.78) { kind[i] = 3; continue; }
      if (sat < 32 || (sat < 45 && lum < 0.42) || (r > 140 && g < 75 && b < 75)) { kind[i] = 0; continue; } // text, outlines, red borders
      kind[i] = 1; hgt[i] = rampHeight(r, g, b);
    }
    // Thin rivers get smeared by scaling and JPEG, so judge blueness against the surroundings:
    // a pixel much bluer than its neighbourhood, blue-ish itself and not grey, is water.
    const bg = new Float32Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) bg[i] = px[q + 2] - px[q + 1];
    const rr = Math.max(2, Math.round(w / 300)), mean = boxBlur(bg, w, h, rr);
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      const r = px[q], g = px[q + 1], b = px[q + 2];
      if (b - g > -45 && b > r + 15 && bg[i] - mean[i] > 30) weak[i] = 1;
    }
    return { kind, hgt, weak };
  }
  // Fills unknown pixels with the value of the nearest known pixel (BFS).
  function fillNearest(known, vals, w, h) {
    const n = w * h, q = new Int32Array(n), done = new Uint8Array(n); let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (known[i]) { done[i] = 1; q[tail++] = i; }
    while (head < tail) {
      const i = q[head++], x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of nb) if (j >= 0 && !done[j]) { done[j] = 1; vals[j] = vals[i]; q[tail++] = j; }
    }
  }

  // p: { smooth 0..1, minIsl, minLake (tiles at this resolution), outside "ocean"|"void", rivers bool,
  //      riverWidth (tiles on the final map), scale (this width / final width), mtn 0..1, vari 0..1 }
  function build(px, w, h, p) {
    const n = w * h, sc = p.scale || 1;
    const { kind, hgt, weak } = classify(px, n, w, h);
    // unknown pixels (labels, border lines) take the kind of their nearest neighbour
    const kk = new Float32Array(n); for (let i = 0; i < n; i++) kk[i] = kind[i];
    const known = new Uint8Array(n); for (let i = 0; i < n; i++) known[i] = kind[i] !== 0 ? 1 : 0;
    fillNearest(known, kk, w, h);
    for (let i = 0; i < n; i++) kind[i] = kk[i];
    // sea = blue areas touching the border or very large; the rest is inland water (lakes, wide rivers)
    const sea = new Uint8Array(n), inland = new Uint8Array(n);
    components(kind, w, h, 2, (idx, cnt, edge) => { const big = edge || cnt > n * 0.02; for (const i of idx) (big ? sea : inland)[i] = 1; });
    // land outline: everything that is not sea or background
    let land = new Uint8Array(n);
    for (let i = 0; i < n; i++) land[i] = kind[i] === 1 || inland[i] ? 1 : 0;
    // holes in the land that do not touch the border (watermarks, white labels) become land
    components(land, w, h, 0, (idx, cnt, edge) => {
      if (edge || cnt > n * 0.04) return;
      let blue = 0; for (const i of idx) if (sea[i]) blue++;
      if (blue < cnt * 0.5) for (const i of idx) land[i] = 1;
    });
    // smooth coastline: blur the outline and cut at half
    const r = Math.round(p.smooth * p.smooth * w / 90 + p.smooth * 1.5);
    if (r >= 1) { const f = new Float32Array(n); for (let i = 0; i < n; i++) f[i] = land[i]; const B = boxBlur(boxBlur(f, w, h, r), w, h, r); for (let i = 0; i < n; i++) land[i] = B[i] >= 0.5 ? 1 : 0; }
    // drop crumbs: tiny islands and tiny lakes
    components(land, w, h, 1, (idx, cnt) => { if (cnt < p.minIsl) for (const i of idx) land[i] = 0; });
    components(land, w, h, 0, (idx, cnt, edge) => { if (!edge && cnt < p.minLake) for (const i of idx) land[i] = 1; });
    // heights: known land colours, spread into gaps, then smoothed so tints blend without steps
    const hk = new Uint8Array(n); for (let i = 0; i < n; i++) hk[i] = kind[i] === 1 ? 1 : 0;
    fillNearest(hk, hgt, w, h);
    const hr = Math.max(1, Math.round(w / 500 + p.smooth * w / 400));
    const H2 = boxBlur(boxBlur(hgt, w, h, hr), w, h, hr);
    // keep small peaks (dark brown specks) that the wide blur would wash out
    const pr = Math.max(1, Math.round(w / 900)), H1 = boxBlur(boxBlur(hgt, w, h, pr), w, h, pr);
    for (let i = 0; i < n; i++) if (H1[i] > 0.6 && H1[i] - 0.04 > H2[i]) H2[i] = H1[i] - 0.04;
    // rivers and lakes inside the land: strong blue + thin blue lines, crumbs removed, widened to the chosen width
    let water = new Uint8Array(n);
    if (p.rivers) {
      water = riverNetwork(land, inland, weak, sea, w, h, sc, p.riverWidth);
      for (let i = 0; i < n; i++) if (!land[i]) water[i] = 0;
    }
    // stretch so the highest tint on this map becomes real mountains (maps rarely use the whole ramp)
    const hist = new Uint32Array(101); let cnt = 0;
    for (let i = 0; i < n; i++) if (land[i]) { hist[Math.min(100, Math.max(0, Math.round(H2[i] * 100)))]++; cnt++; }
    let top = 100, acc = 0; for (; top > 0; top--) { acc += hist[top]; if (acc >= cnt * 0.004) break; }
    const stretch = top < 30 ? 1 / Math.max(0.2, top / 100 / 0.6) : 1; // only lift maps that never leave the greens
    for (let i = 0; i < n; i++) H2[i] = Math.min(1, H2[i] * stretch);
    const out = new Uint8Array(n), fs = 6 / w, mtn = p.mtn, vari = p.vari;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      if (!land[i]) { out[i] = sea[i] || p.outside !== "void" ? WATER : VOID; continue; }
      if (water[i]) { out[i] = WATER; continue; }
      let v = Math.max(0, H2[i]) * (0.5 + mtn * 0.833);
      if (vari) v += (fbm(x * fs, y * fs, 4, 99) - 0.5) * vari * 0.25 * (0.4 + v);
      out[i] = 1 + Math.max(0, Math.min(30, Math.round(v * 30)));
    }
    return out;
  }
  // Rough test: a lot of green/yellow/brown tints and some blue or white = physical map.
  function looksPhysical(px) {
    let n = 0, tint = 0, blue = 0, paper = 0;
    for (let q = 0; q < px.length; q += 4 * 5) {
      const r = px[q], g = px[q + 1], b = px[q + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b), lum = (r + g + b) / 765; n++;
      if (g > b + 15 && mx - mn > 40) tint++;
      else if (b > r + 28 && b >= g + 8) blue++;
      else if (mx - mn < 32 && lum > 0.78) paper++;
    }
    return tint / n > 0.2 && (blue / n > 0.01 || paper / n > 0.1);
  }
  root.PhysicalMap = { build, looksPhysical, rampHeight };
})(typeof self !== "undefined" ? self : this);
