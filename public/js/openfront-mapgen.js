// OpenFront map generator, ported to JavaScript for the Map Creator (/map-creator.html).
// Mirrors map-generator/map_generator.go from https://github.com/openfrontio/OpenFrontIO
// step by step (same loop order, same tie-breaks), so map.bin / map4x.bin / map16x.bin
// come out byte-identical to `go run . --maps=<name>`. Works in the browser and in Node.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OFMapGen = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LAND = 0, WATER = 1, IMPASSABLE = 2;
  const MIN_ISLAND = 30, MIN_LAKE = 200;

  // Terrain grid: flat typed arrays indexed x*h+y (column-major like terrain[x][y] in Go).
  function makeGrid(w, h) {
    const n = w * h;
    return { w, h, type: new Uint8Array(n), mag: new Float64Array(n), shore: new Uint8Array(n), ocean: new Uint8Array(n) };
  }

  // Pixel -> terrain, exactly as GenerateMap: alpha<20 or blue==106 water, #000 impassable,
  // otherwise land with magnitude (clamp(blue,140,200)-140)/2. rgba is row-major RGBA.
  function gridFromRGBA(rgba, imgW, imgH) {
    const w = imgW - (imgW % 4), h = imgH - (imgH % 4);
    const g = makeGrid(w, h);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const p = (y * imgW + x) * 4, r = rgba[p], gr = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
      const i = x * h + y;
      if (a < 20 || b === 106) g.type[i] = WATER;
      else if (r === 0 && gr === 0 && b === 0) g.type[i] = IMPASSABLE;
      else { g.type[i] = LAND; g.mag[i] = (Math.min(200, Math.max(140, b)) - 140) / 2; }
    }
    return g;
  }

  // Flood fill of the area sharing (x,y)'s type; returns flat indices. visited is shared.
  function getArea(g, start, visited, queue) {
    const { w, h, type } = g, target = type[start], area = [];
    let head = 0, tail = 0;
    visited[start] = 1; queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      if (type[i] !== target) continue;
      area.push(i);
      const x = (i / h) | 0, y = i - x * h;
      if (x > 0 && !visited[i - h]) { visited[i - h] = 1; queue[tail++] = i - h; }
      if (x < w - 1 && !visited[i + h]) { visited[i + h] = 1; queue[tail++] = i + h; }
      if (y > 0 && !visited[i - 1]) { visited[i - 1] = 1; queue[tail++] = i - 1; }
      if (y < h - 1 && !visited[i + 1]) { visited[i + 1] = 1; queue[tail++] = i + 1; }
    }
    return area;
  }

  function forNeighbors(g, i, fn) {
    const h = g.h, x = (i / h) | 0, y = i - x * h;
    if (x > 0) fn(i - h);
    if (x < g.w - 1) fn(i + h);
    if (y > 0) fn(i - 1);
    if (y < h - 1) fn(i + 1);
  }

  // Majority type among unique outside neighbours; ties Water > Impassable > Land.
  function majorityNeighborType(g, coords) {
    const inBody = new Set(coords), seen = new Set(), counts = [0, 0, 0];
    for (const c of coords) forNeighbors(g, c, nb => {
      if (inBody.has(nb) || seen.has(nb)) return;
      seen.add(nb); counts[g.type[nb]]++;
    });
    let best = WATER, bestCount = counts[WATER];
    if (counts[IMPASSABLE] > bestCount) { best = IMPASSABLE; bestCount = counts[IMPASSABLE]; }
    if (counts[LAND] > bestCount) best = LAND;
    return best;
  }

  function findBodies(g, kind) {
    const n = g.w * g.h, visited = new Uint8Array(n), queue = new Int32Array(n), bodies = [];
    for (let i = 0; i < n; i++) if (g.type[i] === kind && !visited[i]) bodies.push(getArea(g, i, visited, queue));
    return bodies;
  }

  function removeSmallIslands(g, minSize, removeSmall, stats) {
    if (!removeSmall) return;
    const bodies = findBodies(g, LAND);
    for (const body of bodies) if (body.length < minSize) {
      const rep = majorityNeighborType(g, body);
      for (const c of body) { g.type[c] = rep; g.mag[c] = 0; }
      if (stats) { stats.islands++; stats.islandTiles += body.length; }
    }
  }

  function processShore(g) {
    const n = g.w * g.h, shoreWater = [];
    for (let i = 0; i < n; i++) {
      g.shore[i] = 0;
      const t = g.type[i];
      if (t === LAND) {
        let s = 0; forNeighbors(g, i, nb => { if (g.type[nb] === WATER) s = 1; });
        g.shore[i] = s;
      } else if (t === WATER) {
        let s = 0; forNeighbors(g, i, nb => { if (g.type[nb] === LAND) s = 1; });
        if (s) { g.shore[i] = 1; shoreWater.push(i); }
      }
    }
    return shoreWater;
  }

  function processDistToLand(g, shoreWater) {
    const n = g.w * g.h, visited = new Uint8Array(n), q = new Int32Array(n), dist = new Int32Array(n);
    let head = 0, tail = 0;
    for (const i of shoreWater) { q[tail++] = i; visited[i] = 1; g.mag[i] = 0; }
    const { w, h } = g;
    while (head < tail) {
      const i = q[head++], d = dist[i] + 1, x = (i / h) | 0, y = i - x * h;
      // Go order: (0,1) (1,0) (0,-1) (-1,0)
      const cand = [y < h - 1 ? i + 1 : -1, x < w - 1 ? i + h : -1, y > 0 ? i - 1 : -1, x > 0 ? i - h : -1];
      for (const nb of cand) if (nb >= 0 && !visited[nb] && g.type[nb] === WATER) {
        visited[nb] = 1; g.mag[nb] = d; dist[nb] = d; q[tail++] = nb;
      }
    }
  }

  function processWater(g, removeSmall, stats) {
    g.ocean.fill(0);
    const bodies = findBodies(g, WATER);
    // Same O(n^2) swap sort as the Go code so equal-sized bodies keep the same order.
    for (let i = 0; i < bodies.length - 1; i++) for (let j = i + 1; j < bodies.length; j++)
      if (bodies[j].length > bodies[i].length) { const t = bodies[i]; bodies[i] = bodies[j]; bodies[j] = t; }
    if (!bodies.length) return;
    for (const c of bodies[0]) g.ocean[c] = 1;
    if (removeSmall) for (let k = 1; k < bodies.length; k++) if (bodies[k].length < MIN_LAKE) {
      const rep = majorityNeighborType(g, bodies[k]);
      for (const c of bodies[k]) { g.type[c] = rep; g.mag[c] = 0; }
      if (stats) { stats.lakes++; stats.lakeTiles += bodies[k].length; }
    }
    processDistToLand(g, processShore(g));
  }

  function setImpassableNeighborWaterDepth(g) {
    const n = g.w * g.h;
    for (let i = 0; i < n; i++) {
      if (g.type[i] !== WATER) continue;
      let hit = false; forNeighbors(g, i, nb => { if (g.type[nb] === IMPASSABLE) hit = true; });
      if (hit) g.mag[i] = 20;
    }
  }

  // 2x2 -> 1, priority Water > Impassable > Land (last land wins), copying every field.
  function createMiniMap(g) {
    const mw = (g.w / 2) | 0, mh = (g.h / 2) | 0, m = makeGrid(mw, mh);
    for (let x = 0; x < g.w; x++) for (let y = 0; y < g.h; y++) {
      const mx = x >> 1, my = y >> 1;
      if (mx >= mw || my >= mh) continue;
      const s = x * g.h + y, d = mx * mh + my;
      if (m.type[d] === WATER) continue;
      if (g.type[s] !== WATER && m.type[d] === IMPASSABLE) continue;
      m.type[d] = g.type[s]; m.mag[d] = g.mag[s]; m.shore[d] = g.shore[s]; m.ocean[d] = g.ocean[s];
    }
    return m;
  }

  // Row-major bytes: bit7 land, bit6 shoreline, bit5 ocean, bits0-4 magnitude.
  function packTerrain(g) {
    const { w, h } = g, out = new Uint8Array(w * h);
    let land = 0;
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      const i = x * h + y, t = g.type[i];
      if (t === IMPASSABLE) { out[y * w + x] = 0x9f; continue; }
      let b = 0;
      if (t === LAND) { b |= 0x80; land++; }
      if (g.shore[i]) b |= 0x40;
      if (g.ocean[i]) b |= 0x20;
      b |= t === LAND ? Math.min(Math.ceil(g.mag[i]), 31) : Math.min(Math.ceil(g.mag[i] / 2), 31);
      out[y * w + x] = b;
    }
    return { data: out, width: w, height: h, numLandTiles: land };
  }

  function thumbnailColor(t, mag, shore) {
    if (t !== LAND) return [0, 0, 0, 0];
    if (shore) return [204, 203, 158, 255];
    if (mag < 10) return [190, (220 - 2 * mag) & 255, 138, 255];
    if (mag < 20) { const a = 2 * mag; return [(200 + a) & 255, (183 + a) & 255, (138 + a) & 255, 255]; }
    const v = Math.floor(230 + mag / 2) & 255; return [v, v, v, 255];
  }

  // RGBA thumbnail from the 4x terrain at half size (same as createMapThumbnail(terrain4x, 0.5)).
  function thumbnailRGBA(g) {
    const tw = Math.max(1, Math.floor(g.w * 0.5)), th = Math.max(1, Math.floor(g.h * 0.5));
    const px = new Uint8ClampedArray(tw * th * 4);
    for (let x = 0; x < tw; x++) for (let y = 0; y < th; y++) {
      const sx = Math.min(x * 2, g.w - 1), sy = Math.min(y * 2, g.h - 1), i = sx * g.h + sy;
      const c = thumbnailColor(g.type[i], g.mag[i], g.shore[i]), p = (y * tw + x) * 4;
      px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = c[3];
    }
    return { data: px, width: tw, height: th };
  }

  // Full pipeline. Returns packed maps for the three scales, thumbnail pixels and stats.
  function generate(rgba, imgW, imgH, opts) {
    const removeSmall = !(opts && opts.removeSmall === false);
    const progress = (opts && opts.progress) || function () {};
    const stats = { islands: 0, islandTiles: 0, lakes: 0, lakeTiles: 0 };
    progress("Reading pixels");
    const g = gridFromRGBA(rgba, imgW, imgH);
    progress("Removing small islands");
    removeSmallIslands(g, MIN_ISLAND, removeSmall, stats);
    progress("Processing water");
    processWater(g, removeSmall, stats);
    setImpassableNeighborWaterDepth(g);
    progress("Building mini maps");
    const g4 = createMiniMap(g);
    removeSmallIslands(g4, MIN_ISLAND / 2, removeSmall);
    processWater(g4, false);
    setImpassableNeighborWaterDepth(g4);
    const g16 = createMiniMap(g4);
    processWater(g16, false);
    setImpassableNeighborWaterDepth(g16);
    progress("Packing");
    const thumb = thumbnailRGBA(g4);
    const map = packTerrain(g), map4x = packTerrain(g4), map16x = packTerrain(g16);
    return { map, map4x, map16x, thumb, stats };
  }

  // In-game-ish colour of a packed tile byte (used for the preview of the generated result).
  function tileColor(b) {
    if (b === 0x9f) return [12, 14, 20];
    const land = b & 0x80, shore = b & 0x40, mag = b & 0x1f;
    if (!land) {
      if (shore) return [100, 143, 255];
      const adj = 11 - Math.min(mag, 10) - 10;
      return [Math.max(70 + adj, 0), Math.max(132 + adj, 0), Math.max(180 + adj, 0)];
    }
    return thumbnailColor(LAND, mag, shore).slice(0, 3);
  }

  return { LAND, WATER, IMPASSABLE, MIN_ISLAND, MIN_LAKE, generate, tileColor, thumbnailColor };
});
