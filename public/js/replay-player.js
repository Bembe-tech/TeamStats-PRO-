// Replay Player — plays a match recorded with the real OpenFront engine
// (server: replay-player-engine.js, data from tools/replay-engine/player-template.ts).
// Territory, fallout, railroads and terrain are drawn on the GPU (WebGL2) the same way
// the OpenFront client does it (same terrain colours, 58.8% territory fill, darker
// borders, patterns, rails in the border colour); structures, units, nukes and names are
// drawn on a 2D canvas above it, with unit movement interpolated between samples.
//
// Usage: ReplayPlayer.mount(rootElement, gameId, { onStatus, onReady })
(function () {
  'use strict';
  const TICK_MS = 100;
  const UT = { TRANSPORT: 1, WARSHIP: 2, SHELL: 3, SAM_MISSILE: 4, PORT: 5, ATOM: 6, HYDRO: 7, TRADE: 8, SILO: 9, DEFENSE: 10, SAM: 11, CITY: 12, MIRV: 13, WARHEAD: 14, TRAIN: 15, FACTORY: 16 };
  const STRUCT = { 12: 0, 5: 1, 16: 2, 10: 3, 11: 4, 9: 5 }; // unit type -> icon atlas column
  const UNIT_COL = { 1: 0, 8: 1, 2: 2, 6: 3, 7: 4, 13: 5, 4: 6, 3: 7, 14: 8 }; // unit atlas column (trains: 9-11)
  const NUKE_R = { 6: 30, 7: 100, 14: 18, 13: 18 };
  // building names (singular, plural) by unit type; bldText: "3 cities, 1 SAM" counted by levels (a level 4 city = 4)
  const BNAME = { 12: ['city', 'cities'], 5: ['port', 'ports'], 16: ['factory', 'factories'], 10: ['defense post', 'defense posts'], 11: ['SAM', 'SAMs'], 9: ['silo', 'silos'] };
  const bldText = list => { const c = new Map(); for (const b of list) c.set(b.type, (c.get(b.type) || 0) + (b.level || 1)); return [...c].sort((a, b) => b[1] - a[1]).map(([ty, n]) => n + ' ' + (BNAME[ty] ? BNAME[ty][n === 1 ? 0 : 1] : 'building')).join(', '); };
  const NUKE_NAME = { 6: 'Atom Bomb', 7: 'Hydrogen Bomb', 13: 'MIRV' };
  const TEAM_ORDER = ['Red', 'Blue', 'Teal', 'Purple', 'Yellow', 'Orange', 'Green'];

  // ---------- helpers ----------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hexRGB = h => { const n = parseInt(String(h || '#888888').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const fmtT = ticks => { const s = Math.max(0, Math.floor(ticks * TICK_MS / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const compact = n => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M'; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K'; return String(Math.round(n)); };
  function hsvDarken(rgb, k) { // OpenFront structure shader: scale HSV value
    const [r, g, b] = rgb.map(v => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0; if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
    const s = mx ? d / mx : 0, v = mx * k, f = (n) => { const kk = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(kk, 4 - kk, 1)); };
    return [f(5), f(3), f(1)].map(x => Math.round(x * 255));
  }
  const css = rgb => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  function b64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), o = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i); return o; }

  // Graphics settings in OpenFront's own format (see public/js/replay-gfx.js). Pages that pass no
  // opts.gfx keep this renderer's original look (OpenFront's defaults, dark icons with a white glyph).
  function gfxFrom(o) {
    o = o || {}; const n = o.name || {}, st = o.structure || {}, mo = o.mapOverlay || {}, te = o.terrain || {}, li = o.lighting || {}, co = o.cosmetics || {};
    const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
    return {
      classicBotColors: !!o.classicBotColors,
      nameScaleFactor: num(n.nameScaleFactor, 0.4), cullThreshold: num(n.cullThreshold, 0.008), darkNames: !!n.darkNames,
      iconSize: num(st.iconSize, 60), classicIcons: !!st.classicIcons, showDots: st.showDots !== false,
      highlightFill: num(mo.highlightFillBrighten, 0.25), highlightBorder: num(mo.highlightBrighten, 0),
      saturation: num(mo.territorySaturation, 0.85), alpha: num(mo.territoryAlpha, 0.588),
      background: te.backgroundColor || null, ocean: te.oceanColor ? hexRGB(te.oceanColor) : null,
      land: { sand: te.sandColor ? hexRGB(te.sandColor) : null, plains: te.plainsColor ? hexRGB(te.plainsColor) : null, highland: te.highlandColor ? hexRGB(te.highlandColor) : null, mountain: te.mountainColor ? hexRGB(te.mountainColor) : null },
      ambient: Math.max(0, Math.min(1, num(li.ambient, 1))), falloff: num(li.falloffPower, 2),
      skins: co.territorySkins !== false,
      nukeColor: hexRGB(mo.staleNukeColor || '#0d8c12'), railMinZoom: num((o.railroad || {}).railMinZoom, 3), railThickness: num((o.railroad || {}).railThickness, 1), gridOpacity: num(mo.coordinateGridOpacity, 0.5),
      hoverFade: num(n.hoverFadeAlpha, 0.5), hoverGlowWidth: num(n.hoverGlowWidth, 5), hoverGlowAlpha: num(n.hoverGlowAlpha, 0.75),
      thicken: Math.max(0, Math.min(10, Math.floor(num(mo.highlightThicken, 1)))), fallout: (o.passEnabled || {}).fallout !== false, fx: (o.passEnabled || {}).fx !== false,
    };
  }

  // OpenFront terrain colours (client/render/gl/utils/ColorUtils.ts, default theme).
  // Alpha keeps the terrain kind for the shader (255 land, 254 water, 253 impassable).
  // sea === 'clanmap': the Clan Map's sea instead (turquoise shallows along the coast, deep blue
  // offshore, a soft foam line at the shore and a gentle texture); w = map width.
  // land (optional): { sand, plains, highland, mountain } RGB overrides (OpenFront terrain.*Color)
  function terrainRGBA(bytes, sea, w, oceanRGB, land) {
    const out = new Uint8Array(bytes.length * 4), L = land || {};
    const ocean = oceanRGB || [0x47, 0x85, 0xb5], sand = L.sand || [204, 203, 158], plains = L.plains || [190, 220, 138], highland = L.highland || [220, 203, 158], mountain = L.mountain || [230, 230, 230], peak = [0x3c, 0x3c, 0x3c];
    for (let i = 0; i < bytes.length; i++) {
      const tb = bytes[i], land = (tb & 0x80) !== 0, shore = (tb & 0x40) !== 0, m = tb & 0x1f; let r, g, b;
      if (land && m === 31) [r, g, b] = peak;
      else if (land && shore) [r, g, b] = sand;
      else if (land) {
        if (m < 10) { r = plains[0]; g = plains[1] - 2 * m; b = plains[2]; }
        else if (m < 20) { const k = m - 10; r = Math.min(255, highland[0] + 2 * k); g = Math.min(255, highland[1] + 2 * k); b = Math.min(255, highland[2] + 2 * k); }
        else { const k = Math.floor(m / 2); r = Math.min(255, mountain[0] + k); g = Math.min(255, mountain[1] + k); b = Math.min(255, mountain[2] + k); }
      } else if (shore) { r = Math.round(0.7 * ocean[0] + 76.5); g = Math.round(0.7 * ocean[1] + 76.5); b = Math.round(0.7 * ocean[2] + 76.5); }
      else { const k = Math.min(m, 10); r = Math.max(0, ocean[0] - k); g = Math.max(0, ocean[1] - k); b = Math.max(0, ocean[2] - k); }
      if (sea === 'season2' && !land) { // Season 2 map: the home page Clan Map's sea (Bembe 2026-10-25): deep navy offshore, lighter glowing water along the coast, a foam line at the shore
        const x = i % w, y = (i / w) | 0, t = shore ? 0 : Math.min(1, m / 12);
        const n = 0.92 + 0.08 * Math.sin(x / 23 + y / 31) * Math.cos(x / 57 - y / 19) + 0.03 * Math.sin((x * 0.7 + y) / 7);
        if (t < 0.35) { const q = (t / 0.35) ** 2; r = 30 + (24 - 30) * q; g = 98 + (88 - 98) * q; b = 150 + (150 - 150) * q; } // (a softer shallow band: the bright one looked like a glow, Bembe 2026-10-25)
        else { const q = Math.sqrt((t - 0.35) / 0.65); r = 24 + (10 - 24) * q; g = 88 + (40 - 88) * q; b = 150 + (92 - 150) * q; }
        r *= n; g *= n; b *= n;
        if (shore) { r += (120 - r) * 0.12; g += (170 - g) * 0.12; b += (200 - b) * 0.12; } // a faint foam line only
        // near the edge of the map the water fades into the open-sea colour around it (no straight line through the Arctic)
        const e = Math.min(x, w - 1 - x, ((bytes.length / w) | 0) - 1 - y); // (not at the top: the dark band there looked like a border, Bembe 2026-10-26) if (e < 36) { const k = (1 - e / 36) ** 1.5; r += (9 - r) * k; g += (38 - g) * k; b += (88 - b) * k; }
      }
      if (sea === 'clanmap' && !land) {
        const x = i % w, y = (i / w) | 0, t = shore ? 0 : Math.min(1, m / 14), q = Math.sqrt(t);
        const n = 0.93 + 0.07 * Math.sin(x / 23 + y / 31) * Math.cos(x / 57 - y / 19) + 0.03 * Math.sin((x * 0.7 + y) / 7);
        r = (40 + (10 - 40) * q) * n; g = (122 + (40 - 122) * q) * n; b = (162 + (92 - 162) * q) * n;
        if (m < 2) { const k = shore ? 0.42 : 0.2; r += (170 - r) * k; g += (205 - g) * k; b += (220 - b) * k; }
      }
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = land && m === 31 ? 253 : land ? 255 : 254;
    }
    return out;
  }

  // ---------- data loading ----------
  async function fetchData(gameId, onStatus, signal) {
    for (let tries = 0; tries < 400; tries++) {
      const r = await fetch('/api/replay-player/' + encodeURIComponent(gameId), { cache: 'no-store', signal });
      if (r.status === 200) {
        const total = Number(r.headers.get('Content-Length')) || 0, reader = r.body.getReader(), chunks = []; let got = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onStatus({ step: 'download', pct: total ? got / total : 0, bytes: got }); }
        onStatus({ step: 'unpack' });
        const blob = new Blob(chunks);
        return await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      }
      const j = await r.json().catch(() => ({}));
      if (r.status !== 202) throw new Error(j.error || ('HTTP ' + r.status));
      onStatus({ step: 'compute', state: j.state, position: j.position, since: j.startedAt });
      await new Promise(res => setTimeout(res, 2000));
    }
    throw new Error('timed out');
  }
  // Live stream (server ?live=<offset>): frames of [u32 length][gzip piece]; piece = [u32 json length][json]
  // [u32][a bytes][u32][b bytes]. First piece k:"h" = header + terrain, then k:"c" pieces (frameTicks, units,
  // rails, names, stats, events + territory / move bytes); the last one carries end: { ticks, summary }.
  async function gunzip(bytes) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); }
  async function livePieces(buf, out) { // takes whole frames off the front of buf, returns the rest
    let o = 0; const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    while (o + 4 <= buf.length) {
      const n = dv.getUint32(o, true); if (o + 4 + n > buf.length) break;
      const p = await gunzip(buf.subarray(o + 4, o + 4 + n)); o += 4 + n;
      const pv = new DataView(p.buffer, p.byteOffset, p.byteLength); let q = 0;
      const sec = () => { const m = pv.getUint32(q, true), x = p.subarray(q + 4, q + 4 + m); q += 4 + m; return x; };
      const json = JSON.parse(new TextDecoder().decode(sec())); json.a = sec(); json.b = sec(); out.push(json);
    }
    return buf.subarray(o);
  }
  // growable byte array (territory and move streams keep growing while a replay loads)
  function growBytes(g, add) {
    if (!add.length) return g;
    if (g.len + add.length > g.buf.length) { const nb = new Uint8Array(Math.max(g.buf.length * 2, g.len + add.length, 1 << 16)); nb.set(g.buf.subarray(0, g.len)); g.buf = nb; }
    g.buf.set(add, g.len); g.len += add.length; return g;
  }
  function parse(buf) {
    const dv = new DataView(buf), td = new TextDecoder(); let o = 0;
    const sec = () => { const n = dv.getUint32(o, true), s = new Uint8Array(buf, o + 4, n); o += 4 + n; return s; };
    const header = JSON.parse(td.decode(sec())), terrain = sec(), terr = sec(), timeline = JSON.parse(td.decode(sec())), moves = sec();
    return { header, terrain, terr, timeline, moves };
  }
  // offsets of each record in a varint stream of "count, then count*per varints"
  function indexStream(bytes, per, n) {
    const off = new Uint32Array(n); let p = 0;
    for (let f = 0; f < n; f++) {
      off[f] = p; let c = 0, s = 0, b;
      do { b = bytes[p++]; c |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
      for (let k = c * per; k > 0; k--) { while (bytes[p++] & 0x80); }
    }
    return off;
  }
  const bsearch = (arr, t) => { let lo = 0, hi = arr.length - 1; if (hi < 0 || arr[0] > t) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m] <= t) lo = m; else hi = m - 1; } return lo; };

  // ---------- WebGL ----------
  const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;
  const FS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform sampler2D uTerrain; uniform usampler2D uState; uniform usampler2D uRail; uniform usampler2D uGhost; uniform int uSoftNuke;
uniform sampler2D uPalette; uniform sampler2D uPatMeta; uniform usampler2D uPatData;
uniform sampler2D uImgMeta; uniform highp sampler2DArray uImgSkins; // admin image skins (r = on, g = layer, b = log2 tile size)
uniform vec2 uMap; uniform vec2 uOffset; uniform float uScale; uniform float uViewH;
uniform int uShowTerr; uniform int uShowRails; uniform int uShowPatterns; uniform uint uFocus;
uniform float uSat; uniform float uAlpha; uniform float uHiFill; uniform float uHiBorder; uniform float uPulse;
// OpenFront look (opts.ofLook): highlight border mixed toward white and thickened by uHiThick tiles (BorderCompute /
// BorderStamp passes); fallout bloom (FalloutBloomPass: extract at 1/8 tile resolution, linear filtered)
uniform int uOF; uniform int uHiThick; uniform int uBloom; uniform sampler2D uBloomTex; uniform vec3 uNukeCol; uniform float uRailFade; uniform float uRailThick; uniform float uBorderMix; uniform float uRailDetail;
out vec4 o;

uint ownerAt(ivec2 p){ p = clamp(p, ivec2(0), ivec2(uMap) - 1); return texelFetch(uState, p, 0).r & 4095u; }
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// rail arm coverage for a 4-bit connection mask (1 N, 2 E, 4 S, 8 W); f in -0.5..0.5
float arm(vec2 f, uint m, float hw){
  float c = 0.0;
  if ((m & 1u) != 0u && abs(f.x) < hw && f.y <= hw) c = 1.0;
  if ((m & 4u) != 0u && abs(f.x) < hw && f.y >= -hw) c = 1.0;
  if ((m & 2u) != 0u && abs(f.y) < hw && f.x >= -hw) c = 1.0;
  if ((m & 8u) != 0u && abs(f.y) < hw && f.x <= hw) c = 1.0;
  return c;
}
// distance from p (tile-local, centre 0,0) to the rail centre lines of mask m (OpenFront railLineDist)
float segD(vec2 p, vec2 a, vec2 b){ vec2 ab = b - a; float t = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0); return length(p - a - ab * t); }
float railDist(vec2 p, uint m){
  float d = 9.0;
  if ((m & 1u) != 0u) d = min(d, segD(p, vec2(0.0), vec2(0.0, -0.5)));
  if ((m & 4u) != 0u) d = min(d, segD(p, vec2(0.0), vec2(0.0, 0.5)));
  if ((m & 2u) != 0u) d = min(d, segD(p, vec2(0.0), vec2(0.5, 0.0)));
  if ((m & 8u) != 0u) d = min(d, segD(p, vec2(0.0), vec2(-0.5, 0.0)));
  return d;
}
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uViewH - gl_FragCoord.y);
  vec2 w = (frag - uOffset) / uScale;
  vec3 bg = vec3(0.235);
  if (w.x < 0.0 || w.y < 0.0 || w.x >= uMap.x || w.y >= uMap.y) { o = vec4(0.0); return; }
  ivec2 tc = ivec2(floor(w));
  vec4 ter = texelFetch(uTerrain, tc, 0);
  vec3 col = ter.rgb;
  bool land = ter.a > 0.999;
  bool impassable = ter.a < 0.9935;
  uint raw = texelFetch(uState, tc, 0).r;
  uint own = raw & 4095u;
  bool fallout = (raw & 8192u) != 0u;
  if (uShowTerr == 1) {
    if (fallout) {
      // SOFT NUKE option: the fallout green is see-through, so the terrain under it shows (no owner colour, no skin);
      // off: plain fallout green, as in the game
      if (uSoftNuke == 1) {
        col = mix(col, vec3(0.12, 0.62, 0.14), 0.42 + hash(vec2(tc)) * 0.06);
        // a light speckled line along the edge of the fallout
        int st = max(1, int(floor(0.9 / uScale)));
        bool fe = (texelFetch(uState, tc + ivec2(st, 0), 0).r & 8192u) == 0u || (texelFetch(uState, tc - ivec2(st, 0), 0).r & 8192u) == 0u || (texelFetch(uState, tc + ivec2(0, st), 0).r & 8192u) == 0u || (texelFetch(uState, tc - ivec2(0, st), 0).r & 8192u) == 0u;
        if (fe) col = mix(col, vec3(0.85, 1.0, 0.85), 0.35 + hash(vec2(tc) + 7.0) * 0.35);
      }
      else col = (uOF == 1 ? uNukeCol : vec3(0.05, 0.55, 0.07)) + vec3(hash(vec2(tc)) * 0.05);
    } else if (own != 0u) {
      vec4 fill4 = texelFetch(uPalette, ivec2(int(own), 0), 0); vec3 fill = fill4.rgb;
      bool away = fill4.a < 0.983; // player left the game: palette alpha 250, drawn nearly opaque
      bool traitor = !away && fill4.a < 0.99; // traitor status: palette alpha 251, a slow red pulse
      vec3 border = texelFetch(uPalette, ivec2(int(own), 1), 0).rgb;
      // zoomed out, test farther neighbours so borders stay visible
      int st = max(1, int(floor(0.9 / uScale)));
      bool edge = ownerAt(tc + ivec2(st, 0)) != own || ownerAt(tc - ivec2(st, 0)) != own || ownerAt(tc + ivec2(0, st)) != own || ownerAt(tc - ivec2(0, st)) != own;
      bool hiEdge = false;
      if (uOF == 1 && !edge && uFocus != 0u && own == uFocus) for (int d = 1; d <= 10 && !hiEdge; d++) { if (d > uHiThick) break;
        for (int i = -d; i <= d && !hiEdge; i++) hiEdge = ownerAt(tc + ivec2(i, -d)) != own || ownerAt(tc + ivec2(i, d)) != own || ownerAt(tc + ivec2(-d, i)) != own || ownerAt(tc + ivec2(d, i)) != own; }
      // uBorderMix < 1 (opts.borderMix): the border is laid over the filled tile, see-through (softer lines)
      bool isEdge = edge || hiEdge;
      if (!isEdge || uBorderMix < 1.0) {
        vec4 meta = texelFetch(uPatMeta, ivec2(int(own), 0), 0);
        vec4 im = texelFetch(uImgMeta, ivec2(int(own), 0), 0);
        bool img = uShowPatterns == 1 && im.r > 0.5 && !away;
        if (img) {
          // the image repeats every 2^b map tiles; textureGrad avoids a seam where fract() wraps
          vec2 q = w / exp2(floor(im.b * 255.0 + 0.5));
          fill = textureGrad(uImgSkins, vec3(fract(q), floor(im.g * 255.0 + 0.5)), dFdx(q), dFdy(q)).rgb;
        } else if (uShowPatterns == 1 && meta.r > 0.5) {
          int pw = int(meta.g * 255.0 + 0.5), ph = int(meta.b * 255.0 + 0.5), ps = int(meta.a * 255.0 + 0.5);
          int px = tc.x >> ps, py = tc.y >> ps;
          int bit = (py % ph) * pw + (px % pw);
          uint by = texelFetch(uPatData, ivec2(bit >> 3, int(own)), 0).r;
          if ((by & (1u << uint(bit & 7))) != 0u) fill = border;
        }
        float luma = dot(fill, vec3(0.299, 0.587, 0.114));
        if (!img) fill = mix(vec3(luma), fill, uSat);
        if (uFocus != 0u && own == uFocus) fill = clamp((fill - 0.5) * (1.0 + uHiFill) + 0.5, 0.0, 1.0);
        col = mix(col, fill, away ? 0.85 : img ? max(uAlpha, 0.85) : uAlpha);
        if (traitor) col = mix(col, vec3(1.0, 0.12, 0.1), 0.1 + 0.25 * uPulse);
      }
      if (isEdge) { vec3 bc = border; if (uFocus != 0u && own == uFocus && uHiBorder > 0.0) bc = uOF == 1 ? mix(bc, vec3(1.0), uHiBorder) : clamp((bc - 0.5) * (1.0 + uHiBorder) + 0.5, 0.0, 1.0);
        col = uBorderMix < 1.0 ? mix(col, bc, uBorderMix) : bc; }
    }
  }
  if (uShowRails == 1 && uRailFade > 0.0 && uOF == 1 && uScale < 6.0) {
    // OpenFront line mode: a line railThickness tiles wide around the centre line, spilling into the 3x3 neighbours
    float hw = 0.5 * uRailThick, best = 9.0; vec3 rc = vec3(0.75);
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      ivec2 n = tc + ivec2(dx, dy); if (n.x < 0 || n.y < 0 || n.x >= int(uMap.x) || n.y >= int(uMap.y)) continue;
      uint nm = texelFetch(uRail, n, 0).r; if (nm == 0u) continue;
      float d = railDist(w - vec2(n) - 0.5, nm); if (d < best) { best = d; uint no = texelFetch(uState, n, 0).r & 4095u; rc = no != 0u ? texelFetch(uPalette, ivec2(int(no), 1), 0).rgb : vec3(0.75); }
    }
    float aa = 0.5 / max(uScale, 0.01);
    float cov = 1.0 - smoothstep(hw - aa, hw + aa, best);
    if (cov > 0.0) { if (!land && texelFetch(uRail, tc, 0).r != 0u) col = mix(col, vec3(0.773, 0.271, 0.282), 0.9 * uRailFade); col = mix(col, rc, cov * uRailFade); }
  } else if (uShowRails == 1 && uRailFade > 0.0) {
    uint m = texelFetch(uRail, tc, 0).r;
    if (m != 0u) {
      vec3 under = col; float rk = uOF == 1 ? uRailThick : 1.0; // OpenFront railroad.railThickness / railMinZoom fade
      vec3 rc = own != 0u ? texelFetch(uPalette, ivec2(int(own), 1), 0).rgb : vec3(0.75);
      vec2 f = fract(w) - 0.5;
      if (!land) col = mix(col, vec3(0.773, 0.271, 0.282), 0.9);
      if (uScale >= uRailDetail) {
        // detailed track: two rails and cross ties (from opts.railDetailZoom px per tile, default 6)
        float rails = max(arm(f - vec2(0.2, 0.0), m & 5u, 0.07 * rk), arm(f + vec2(0.2, 0.0), m & 5u, 0.07 * rk));
        rails = max(rails, max(arm(f - vec2(0.0, 0.2), m & 10u, 0.07 * rk), arm(f + vec2(0.0, 0.2), m & 10u, 0.07 * rk)));
        float ties = 0.0;
        if ((m & 5u) != 0u && abs(f.x) < 0.33 && fract((w.y) * 3.0) < 0.35 && arm(f, m & 5u, 0.33) > 0.5) ties = 1.0;
        if ((m & 10u) != 0u && abs(f.y) < 0.33 && fract((w.x) * 3.0) < 0.35 && arm(f, m & 10u, 0.33) > 0.5) ties = 1.0;
        if (ties > 0.5) col = mix(col, rc * 0.55, 0.9);
        if (rails > 0.5) col = rc;
      } else {
        float hw = uOF == 1 ? min(0.5, 0.5 * uRailThick) : clamp(0.75 / uScale, 0.18, 0.5);
        if (arm(f, m, hw) > 0.5) col = rc;
      }
      col = mix(under, col, uRailFade);
    }
  }
  // impassable terrain blends into the page background, as in OpenFront (map looks non-rectangular)
  if (impassable && own == 0u && texelFetch(uRail, tc, 0).r == 0u) { o = vec4(0.0); return; }
  if (uBloom == 1 && uShowTerr == 1) { // FalloutBloomPass composite: blurred 1/8-resolution bloom, LINEAR, x bloomCoverage, premultiplied
    vec4 bl = texture(uBloomTex, w / uMap) * 1.1;
    col = bl.rgb + col * (1.0 - clamp(bl.a, 0.0, 1.0));
  }
  o = vec4(col, 1.0);
}`;
  // OpenFront FalloutBloomPass, extract (shaders/fallout-bloom/extract.frag.glsl with render-settings.json values):
  // one pixel per 8x8 tiles; blurred with shaders/shared/blur.frag.glsl, H then V
  const BLOOM_FS = `#version 300 es
precision highp float; precision highp int; precision highp usampler2D;
uniform usampler2D uState; uniform vec2 uMap; uniform float uFrame; uniform int uNukeN; uniform vec4 uNuke[32];
out vec4 fragColor;
float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float sstep(float lo, float hi, float x){ return hi <= lo ? step(lo, x) : smoothstep(lo, hi, x); }
// heat of a nuked tile: 1 when the bomb lands, minus 1/255 per game tick (uNuke = x, y, radius, heat)
float heatAt(vec2 c){ float h = 0.0; for (int i = 0; i < 32; i++) { if (i >= uNukeN) break; vec4 q = uNuke[i]; if (distance(c, q.xy) <= q.z) h = max(h, q.w); } return h; }
bool nearHot(vec2 c){ for (int i = 0; i < 32; i++) { if (i >= uNukeN) break; if (distance(c, uNuke[i].xy) <= uNuke[i].z + 16.0) return true; } return false; }
// bloom of one 8x8 block (OpenFront extract.frag.glsl with render-settings.json values), premultiplied
vec4 bloomBlock(ivec2 b){
  ivec2 tc = b * 8 + 4;
  if (tc.x >= int(uMap.x) || tc.y >= int(uMap.y)) return vec4(0.0);
  uint raw = texelFetch(uState, tc, 0).r; if ((raw & 8192u) == 0u) return vec4(0.0);
  uint owner = raw & 4095u; vec2 c = vec2(tc) + 0.5; float heat = heatAt(c); if (heat <= 0.0) return vec4(0.0);
  float t = uFrame * mix(0.0018, 0.0, heat);
  float broil = vnoise3(vec3(c * 0.059, t)) * 0.6 + vnoise3(vec3(c * 0.171, t * 1.3)) * 0.4;
  broil = sstep(mix(0.52, 0.0, heat), mix(1.0, 0.0, heat), broil);
  float meta = vnoise3(vec3(c * 0.02, t * 0.5));
  float intensity = mix(0.15, 1.8, heat) * mix(1.0, meta, mix(1.0, 0.0, heat));
  float opacity = smoothstep(0.0, 1.0, heat);
  vec4 r = vec4(0.054901960784313725, 0.8196078431372549, 0.0, 1.0) * broil * intensity * opacity;
  float h1 = fract(sin(float(tc.x) * 12.9898 + float(tc.y) * 78.233) * 43758.5453), h2 = fract(sin(float(tc.x) * 63.7 + float(tc.y) * 157.3) * 23421.631);
  if (h2 > (owner == 0u ? 0.85 : 0.875)) {
    float flick = max(0.0, sin(uFrame * 0.2 * (0.4 + h1 * 1.2) + h1 * 12.0) * 0.8 + 0.2); flick *= flick;
    flick *= mix(0.2, 1.0, 1.0 - heat) * opacity;
    vec3 pc = mix(vec3(0.05, 0.4, 0.05), vec3(0.2, 1.0, 0.2), h1) * flick;
    r += vec4(pc, max(pc.r, max(pc.g, pc.b)));
  }
  return r;
}
void main(){ fragColor = bloomBlock(ivec2(gl_FragCoord.xy)); }`;
  const BLUR_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex; uniform vec2 uDir; uniform vec2 uSize; out vec4 fragColor;
const float w[3] = float[3](0.375, 0.25, 0.0625);
void main(){ vec2 uv = gl_FragCoord.xy / uSize; vec4 r = texture(uTex, uv) * w[0];
  for (int i = 1; i < 3; i++) { vec2 off = uDir * float(i); r += texture(uTex, uv + off) * w[i]; r += texture(uTex, uv - off) * w[i]; }
  fragColor = r; }`;
  function glProgram(gl, fs) {
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs || FS)); gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  function tex(gl, unit, internal, format, type, w, h, data) {
    const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data);
    return t;
  }

  // ---------- the player ----------
  function mount(root, gameId, opts = {}) {
    const onStatus = opts.onStatus || (() => {});
    const glCv = document.createElement('canvas'), ovCv = document.createElement('canvas');
    glCv.className = 'rpx-gl'; ovCv.className = 'rpx-ov';
    root.appendChild(glCv); root.appendChild(ovCv);
    const gl = glCv.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) { onStatus({ step: 'error', error: 'WebGL2 is not available in this browser' }); return null; }
    const ctx = ovCv.getContext('2d');
    const G = gfxFrom(opts.gfx);
    const P = { tick: 0, speed: 5, playing: false, showNames: true, showUnits: true, showBuildings: true, showRails: true, showWarships: false, showSams: false, showTrade: false, showAllies: false, showStrays: false, showNukes: false, showDonations: false, softNuke: false, showTerr: true, showPatterns: G.skins, focus: 0, listeners: {}, gfx: G };
    if (G.background) root.style.background = G.background; // outside the map and impassable terrain
    const emit = (ev, d, e2) => (P.listeners[ev] || []).forEach(f => f(d, e2));
    P.on = (ev, f) => ((P.listeners[ev] ||= []).push(f), P);

    let D = null, W = 0, H = 0, N = 0;
    let patRows = null, patTex = null, patH = 0, ovFirst = 0, ovr = null, ovrDirty = false;
    let terrRGBA = null, terrTex = null, ghost, ghostTex, state, stateTex, railMask, railTex, prog, uni = {}, palette, meta, palTex, metaTex, palOrig, metaOrig, awayKey = '';
    let terrFrame = -1, dirtyLo = Infinity, dirtyHi = -1, fullDirty = false;
    const cam = { scale: 1, ox: 0, oy: 0, ts: 1, tox: 0, toy: 0, fitted: false, user: false }; // user: moved or zoomed by hand (no auto-fit on resize)
    const icons = new Image(), unitAtlas = new Image();
    if (opts.ofLook && document.fonts) document.fonts.load('700 20px Overpass').then(() => { textCache.clear(); textLast.clear(); }).catch(() => { });
    const statusAtlas = new Image(); if (opts.ofLook) statusAtlas.src = '/img/replay/status-atlas.png'; // OpenFront resources/atlases (crown = cell 0)
    icons.src = '/img/replay/icon-atlas.png'; unitAtlas.src = '/img/replay/unit-atlas.png';
    let unitGray = null; // grayscale pixels of the unit atlas (156 x 13)
    unitAtlas.onload = () => { const c = document.createElement('canvas'); c.width = unitAtlas.width; c.height = unitAtlas.height; const x = c.getContext('2d'); x.drawImage(unitAtlas, 0, 0); unitGray = x.getImageData(0, 0, c.width, c.height); spriteCache.clear(); };
    icons.onload = () => structCache.clear();

    // ----- players -----
    let players = [], bySid = new Map(), pal = new Map(), teams = [], teamOf = new Map();
    function setupPlayers() {
      const h = D.header;
      players = h.players; bySid = new Map(players.map(p => [p.sid, p]));
      setupPal();
      // teams with real names: the clan most of the team's humans play for (e.g. "JR")
      const groups = new Map();
      for (const p of players) { if (p.team == null || p.type === 'BOT') continue; if (!groups.has(p.team)) groups.set(p.team, []); groups.get(p.team).push(p); }
      teams = [...groups.entries()].map(([team, members]) => {
        const humans = members.filter(p => p.type === 'HUMAN'), cnt = new Map();
        for (const p of humans) { const tag = String(p.clan || (/^\[([^\]]+)\]/.exec(p.display || '') || [])[1] || '').trim().toUpperCase(); if (tag) cnt.set(tag, (cnt.get(tag) || 0) + 1); }
        const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
        const clan = top && (top[1] >= 2 || humans.length <= 2) && top[1] / Math.max(1, humans.length) >= 0.34 ? top[0] : null;
        const idx = TEAM_ORDER.indexOf(String(team));
        return { team, clan, label: clan || String(team), sub: clan ? String(team) : '', members, color: h.teamColors?.[team] || (members[0] && members[0].fill) || '#888', order: idx < 0 ? 99 : idx };
      }).sort((a, b) => a.order - b.order || String(a.team).localeCompare(String(b.team), undefined, { numeric: true }));
      for (const t of teams) for (const p of t.members) teamOf.set(p.sid, t);
    }

    function setupPal() {
      for (const p of players) {
        const cl = G.classicBotColors && p.classic, fill = hexRGB(cl ? p.classic.fill : p.fill), border = hexRGB(cl ? p.classic.border : p.border);
        pal.set(p.sid, { fill, border, fillCss: css(fill), borderCss: css(border), sFill: css(hsvDarken(fill, 0.65)), sBorder: css(hsvDarken(border, 0.9)),
          // OpenFront "classic icons": the shape in the player colour, a darkened border and a dark glyph
          cFill: css(fill), cBorder: css(hsvDarken(fill, 0.7)), cGlyph: css(hsvDarken(fill, 0.3)) });
      }
    }

    // ----- GPU setup -----
    function setupGL() {
      prog = glProgram(gl); gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      for (const n of ['uTerrain', 'uState', 'uRail', 'uPalette', 'uPatMeta', 'uPatData', 'uMap', 'uOffset', 'uScale', 'uViewH', 'uShowTerr', 'uShowRails', 'uShowPatterns', 'uFocus', 'uSat', 'uAlpha', 'uHiFill', 'uHiBorder', 'uPulse', 'uGhost', 'uSoftNuke', 'uImgMeta', 'uImgSkins', 'uOF', 'uHiThick', 'uBloom', 'uBloomTex', 'uNukeCol', 'uRailFade', 'uRailThick', 'uBorderMix', 'uRailDetail']) uni[n] = gl.getUniformLocation(prog, n);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      terrRGBA = terrainRGBA(D.terrain, opts.sea, W, G.ocean, G.land); terrTex = tex(gl, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, terrRGBA);
      state = new Uint16Array(N); stateTex = tex(gl, 1, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, W, H, state);
      railMask = new Uint8Array(N); railTex = tex(gl, 2, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, W, H, railMask);
      const maxSid = Math.max(1, ...players.map(p => p.sid)) + 1;
      // palette rows 2-3 / meta row 1: untouched copies (fill, border, skin) for burnt land (soft nuke)
      palette = new Uint8Array(4096 * 4 * 4); meta = new Uint8Array(4096 * 2 * 4); patH = maxSid + 64; patRows = new Uint8Array(1024 * patH); // +64 rows: owner override sids (P.setOwnerOverride)
      for (const p of players) {
        const c = pal.get(p.sid);
        palette.set([...c.fill, 255], p.sid * 4); palette.set([...c.border, 255], (4096 + p.sid) * 4);
        if (p.pattern && p.pattern.d) try {
          const b = b64url(p.pattern.d); if (b[0] !== 0) throw 0;
          const scale = b[1] & 7, pw = (((b[2] & 3) << 5) | ((b[1] >> 3) & 31)) + 2, ph = ((b[2] >> 2) & 63) + 2;
          meta.set([255, pw, ph, scale], p.sid * 4); patRows.set(b.subarray(3, 3 + Math.min(1024, b.length - 3)), p.sid * 1024);
        } catch (e) { }
      }
      palette.copyWithin(4096 * 2 * 4, 0, 4096 * 2 * 4); meta.copyWithin(4096 * 4, 0, 4096 * 4);
      palTex = tex(gl, 3, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4096, 4, palette); palOrig = palette.slice();
      metaTex = tex(gl, 4, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4096, 2, meta); metaOrig = meta.slice();
      patTex = tex(gl, 5, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 1024, patH, patRows); ovFirst = maxSid;
      ghost = new Uint16Array(N); ghostTex = tex(gl, 6, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, W, H, ghost); gl.uniform1i(uni.uGhost, 6);
      gl.uniform1i(uni.uTerrain, 0); gl.uniform1i(uni.uState, 1); gl.uniform1i(uni.uRail, 2); gl.uniform1i(uni.uPalette, 3); gl.uniform1i(uni.uPatMeta, 4); gl.uniform1i(uni.uPatData, 5);
      gl.uniform2f(uni.uMap, W, H);
      imgMetaTex = tex(gl, 8, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 4096, 1, new Uint8Array(4096 * 4)); gl.uniform1i(uni.uImgMeta, 8);
      imgSkins(1, []); gl.uniform1i(uni.uImgSkins, 7);
    }
    // Admin image skins (replay-skins.js): list = [{ sid, img (image/canvas), tile (map tiles, power of 2) }].
    // Each image is drawn into one 256x256 layer of a texture array (centre crop to a square).
    let imgMetaTex = null, imgArrTex = null;
    function imgSkins(n, list) {
      const S = 256;
      if (imgArrTex) gl.deleteTexture(imgArrTex);
      imgArrTex = gl.createTexture(); gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D_ARRAY, imgArrTex);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, list.length ? 9 : 1, gl.RGBA8, list.length ? S : 1, list.length ? S : 1, Math.max(1, n));
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, list.length ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, list.length ? gl.LINEAR : gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.REPEAT);
      const im = new Uint8Array(4096 * 4), c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d', { willReadFrequently: true });
      list.forEach((k, i) => {
        const w = k.img.naturalWidth || k.img.width, h = k.img.naturalHeight || k.img.height, m = Math.min(w, h);
        x.clearRect(0, 0, S, S); x.drawImage(k.img, (w - m) / 2, (h - m) / 2, m, m, 0, 0, S, S);
        gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, S, S, 1, gl.RGBA, gl.UNSIGNED_BYTE, x.getImageData(0, 0, S, S).data);
        if (k.sid > 0 && k.sid < 4096) im.set([255, i, Math.round(Math.log2(Math.max(4, Math.min(2048, k.tile || 64)))), 255], k.sid * 4);
      });
      if (list.length) gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
      if (imgMetaTex) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, imgMetaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 1, gl.RGBA, gl.UNSIGNED_BYTE, im); }
    }
    P.setImageSkins = list => { if (!prog) return false; list = (list || []).filter(k => k && k.img).slice(0, 255); imgSkins(list.length, list); P.imageSkins = list.map(k => k.sid); return true; };

    // ----- territory -----
    let terrOff, frameTicks;
    function applyTerrFrame(f) {
      const b = D.terr; let p = terrOff[f], c = 0, s = 0, x;
      do { x = b[p++]; c |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
      let pos = 0;
      for (let r = 0; r < c; r++) {
        let gap = 0, len = 0, val = 0; s = 0; do { x = b[p++]; gap |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
        s = 0; do { x = b[p++]; len |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
        s = 0; do { x = b[p++]; val |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
        pos += gap; if (pos < dirtyLo) dirtyLo = pos;
        if (val & 4095) ghost.fill(0, pos, pos + len); // owned again: no ghost
        else if (val & 8192) { for (let i = pos; i < pos + len; i++) { const o = state[i] & 4095; if (o) ghost[i] = o; } } // nuked: keep the last owner
        else ghost.fill(0, pos, pos + len);
        state.fill(val, pos, pos + len); pos += len; if (pos > dirtyHi) dirtyHi = pos;
      }
    }
    // keyframes (full owner grid every TK frames, made while playing) make jumping back instant
    const TK = 3000, terrKeys = new Map();
    function seekTerritory(t) {
      const f = bsearch(frameTicks, t);
      if (f === terrFrame) { if (ovrDirty) applyOvr(); return; }
      if (f < terrFrame || f - terrFrame > TK) {
        let kf = -1; for (const k of terrKeys.keys()) if (k <= f && k > kf) kf = k;
        if (f < terrFrame || kf > terrFrame) { if (kf >= 0) { const k = terrKeys.get(kf); state.set(k.s); ghost.set(k.g); } else { state.fill(0); ghost.fill(0); } terrFrame = kf; fullDirty = true; }
      }
      while (terrFrame < f) { applyTerrFrame(++terrFrame); if (terrFrame % TK === 0 && terrFrame && !terrKeys.has(terrFrame)) terrKeys.set(terrFrame, { s: state.slice(), g: ghost.slice() }); }
      if (ovr) applyOvr();
    }
    // Owner override (Season 2 members): some tiles drawn as extra owners (sid >= P.overrideFirst(), < +64) with
    // their own fill, border and skin, on top of whatever the replay says; kept when the replay loops.
    // ovr.base keeps what the replay itself says under each overridden tile, so the override can be taken off in place
    // (taking it off used to replay the territory from the first frame: ~300 ms on a PC, a visible stall on tablets).
    // An override replaced before it was ever drawn has nothing to give back (its base is still empty: clans lost
    // their colour when the mouse crossed several clans quickly)
    function applyOvr() { ovrDirty = false; if (!ovr) return; const { tiles, sids, base } = ovr; for (let k = 0; k < tiles.length; k++) { const t = tiles[k], v = state[t], o = v & 4095; if (o < ovFirst || o >= ovFirst + 64) base[k] = v; if (!(v & 8192)) state[t] = sids[k]; } ovr.applied = true; ovrRows(tiles); }
    function dropOvr() { const { tiles, base } = ovr; if (ovr.applied) for (let k = 0; k < tiles.length; k++) { const t = tiles[k]; if (!(state[t] & 8192)) state[t] = base[k]; } ovr = null; ovrDirty = false; terrKeys.clear(); ovrRows(tiles); }
    // only the rows the override covers go to the GPU again (the whole 2000x1000 grid took ~25 ms per change)
    function ovrRows(tiles) { let lo = Infinity, hi = -1; for (let k = 0; k < tiles.length; k++) { const t = tiles[k]; if (t < lo) lo = t; if (t > hi) hi = t; } if (hi >= 0) { if (lo < dirtyLo) dirtyLo = lo; if (hi + 1 > dirtyHi) dirtyHi = hi + 1; } }
    P.overrideFirst = () => ovFirst;
    P.setOwnerOverride = (entries, tiles, sids) => {
      if (!prog) return false;
      for (const e of entries) {
        if (e.sid < ovFirst || e.sid >= patH) continue;
        palette.set([...e.fill, 255], e.sid * 4); palette.set([...e.border, 255], (4096 + e.sid) * 4);
        palette.set([...e.fill, 255], (4096 * 2 + e.sid) * 4); palette.set([...e.border, 255], (4096 * 3 + e.sid) * 4);
        meta.fill(0, e.sid * 4, e.sid * 4 + 4); patRows.fill(0, e.sid * 1024, e.sid * 1024 + 1024);
        if (e.pattern && e.pattern.d) try {
          const b = b64url(e.pattern.d); if (b[0] !== 0) throw 0;
          const scale = b[1] & 7, pw = (((b[2] & 3) << 5) | ((b[1] >> 3) & 31)) + 2, ph = ((b[2] >> 2) & 63) + 2;
          meta.set([255, pw, ph, scale], e.sid * 4); patRows.set(b.subarray(3, 3 + Math.min(1024, b.length - 3)), e.sid * 1024);
        } catch (er) { }
        meta.copyWithin((4096 + e.sid) * 4, e.sid * 4, e.sid * 4 + 4);
        pal.set(e.sid, { fill: e.fill, border: e.border, fillCss: css(e.fill), borderCss: css(e.border), sFill: css(hsvDarken(e.fill, 0.65)), sBorder: css(hsvDarken(e.border, 0.9)), cFill: css(e.fill), cBorder: css(hsvDarken(e.fill, 0.7)), cGlyph: css(hsvDarken(e.fill, 0.3)) });
      }
      palOrig = palette.slice(); metaOrig = meta.slice();
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, palTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 4, gl.RGBA, gl.UNSIGNED_BYTE, palette);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, metaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 2, gl.RGBA, gl.UNSIGNED_BYTE, meta);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, patTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, patH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, patRows);
      if (ovr) dropOvr();
      ovr = { tiles, sids, base: new Uint16Array(tiles.length) }; ovrDirty = true; return true;
    };
    P.clearOwnerOverride = () => { if (!ovr) return; dropOvr(); };
    function uploadTerritory() {
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, stateTex);
      if (fullDirty) { gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED_INTEGER, gl.UNSIGNED_SHORT, state); gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, ghostTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ghost); }
      else if (dirtyHi >= 0) {
        const r0 = Math.floor(dirtyLo / W), r1 = Math.min(H - 1, Math.floor((dirtyHi - 1) / W));
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, W, r1 - r0 + 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, state.subarray(r0 * W, (r1 + 1) * W));
        gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, ghostTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, W, r1 - r0 + 1, gl.RED_INTEGER, gl.UNSIGNED_SHORT, ghost.subarray(r0 * W, (r1 + 1) * W));
      }
      fullDirty = false; dirtyLo = Infinity; dirtyHi = -1;
    }

    // ----- units -----
    let unitTicks, moveOff, units = new Map(), unitFrame = -1, peek = null;
    const zz = n => (n >>> 1) ^ -(n & 1);
    function eachMove(k, fn) {
      const b = D.moves; let p = moveOff[k], c = 0, s = 0, x;
      do { x = b[p++]; c |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
      let id = 0;
      for (let i = 0; i < c; i++) {
        let g = 0, dx = 0, dy = 0; s = 0; do { x = b[p++]; g |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
        s = 0; do { x = b[p++]; dx |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
        s = 0; do { x = b[p++]; dy |= (x & 0x7f) << s; s += 7; } while (x & 0x80);
        id += g; fn(id, zz(dx), zz(dy));
      }
    }
    function applyUnitFrame(k, map, onRemove) {
      const [tick, full, removed] = D.timeline.units[k];
      for (const e of full) {
        const [id, tile, type, owner, level, flags, tt, target, vet = 0, hp = 10] = e;
        let u = map.get(id);
        if (!u) { u = { id, born: tick, trail: null }; map.set(id, u); }
        u.type = type; u.owner = owner; u.level = level; u.flags = flags; u.tt = tt; u.target = target; u.vet = vet; u.hp = hp; u.x = tile % W; u.y = Math.floor(tile / W);
        if (type === UT.ATOM || type === UT.HYDRO || type === UT.MIRV || type === UT.WARHEAD || type === UT.TRANSPORT) { (u.trail ||= []).push(u.x, u.y); }
      }
      // boats keep their whole path until they land or sink; nuke trails keep the last 200 points
      eachMove(k, (id, dx, dy) => { const u = map.get(id); if (!u) return; u.x += dx; u.y += dy; if (u.trail) { u.trail.push(u.x, u.y); if (u.type !== UT.TRANSPORT && u.trail.length > 400) u.trail.splice(0, 2); } });
      for (const id of removed) { const u = map.get(id); if (u && onRemove) onRemove(u, tick); map.delete(id); }
    }
    const UK = 1000, unitKeys = new Map();
    const cloneUnits = m => new Map([...m].map(([id, u]) => [id, { ...u, trail: u.trail && u.trail.slice() }]));
    function seekUnits(t) {
      const k = bsearch(unitTicks, t);
      if (k === unitFrame) return;
      if (k < unitFrame || k - unitFrame > UK) {
        let kf = -1; for (const x of unitKeys.keys()) if (x <= k && x > kf) kf = x;
        if (k < unitFrame || kf > unitFrame) { units = kf >= 0 ? cloneUnits(unitKeys.get(kf)) : new Map(); unitFrame = kf; }
      }
      while (unitFrame < k) { applyUnitFrame(++unitFrame, units); if (unitFrame % UK === 0 && unitFrame && !unitKeys.has(unitFrame)) unitKeys.set(unitFrame, cloneUnits(units)); }
      peek = null;
    }
    // Warship view: each warship's route over the next WS_AHEAD unit samples (read ahead in the
    // recording, recomputed only when the unit sample changes)
    const WS_AHEAD = 75, WS_RANGE = 130, WS_PATROL = 100; // OpenFront warshipTargettingRange / warshipPatrolRange, in tiles
    let wsFuture = null, wsFrame = -2, samCv = null;
    // Trade routes: every sample of every trade ship over the whole match, counted on a grid of
    // TR_CELL x TR_CELL tiles, drawn as a glowing heat map (busiest lanes brightest). Built once, on first use.
    // Live trade heat map: where trade ships are sailing now. Positions of all trade ships at every
    // unit sample are kept once (tile indices per sample); for the current time the samples of the
    // last TR_WINDOW ticks are summed with a fading weight (older = fainter), on water only, and drawn
    // as a soft glow. Recomputed when the replay time moves, so it follows seeking and every speed.
    const TR_CELL = 4, TR_WINDOW = 600, TR_TAU = 220; let trPos = null, trCv = null, trGrid = null, trWater = null, trT = -1e9, trWall = 0, trTmp = null;
    function tradeHeat(t) {
      const gw = Math.ceil(W / TR_CELL), gh = Math.ceil(H / TR_CELL);
      if (!trPos) {
        trPos = []; const pos = new Map();
        for (let k = 0; k < unitTicks.length; k++) {
          const [, full, removed] = D.timeline.units[k];
          for (const e of full) { if (e[2] === UT.TRADE) pos.set(e[0], [e[1] % W, Math.floor(e[1] / W)]); else pos.delete(e[0]); }
          eachMove(k, (id, dx, dy) => { const q = pos.get(id); if (q) { q[0] += dx; q[1] += dy; } });
          for (const id of removed) pos.delete(id);
          const arr = new Int32Array(pos.size); let i = 0; for (const [x, y] of pos.values()) arr[i++] = Math.floor(y / TR_CELL) * gw + Math.floor(x / TR_CELL); trPos.push(arr);
        }
        trWater = new Uint8Array(gw * gh); for (let i = 0; i < N; i++) if (!(D.terrain[i] & 0x80)) trWater[Math.floor(Math.floor(i / W) / TR_CELL) * gw + Math.floor((i % W) / TR_CELL)] = 1;
        trGrid = new Float32Array(gw * gh); trCv = document.createElement('canvas'); trCv.width = gw; trCv.height = gh;
      }
      const wall = performance.now();
      if (Math.abs(t - trT) < 3 || (wall - trWall < 120 && Math.abs(t - trT) < 60)) return trCv; // cheap: at most ~8 updates a second
      trT = t; trWall = wall; trGrid.fill(0);
      const k1 = bsearch(unitTicks, t); if (k1 < 0) return null;
      for (let k = k1; k >= 0 && unitTicks[k] > t - TR_WINDOW; k--) { const w = Math.exp(-(t - unitTicks[k]) / TR_TAU), arr = trPos[k]; for (let i = 0; i < arr.length; i++) trGrid[arr[i]] += w; }
      // spread each cell over its neighbours (two box passes), so ships sailing side by side in one
      // lane add up; single ships stay faint, busy lanes get hot
      const G = trGrid, T2 = trTmp || (trTmp = new Float32Array(G.length));
      for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < gh; y++) { const o = y * gw; for (let x0 = 0; x0 < gw; x0++) { let v = G[o + x0] * 2; if (x0) v += G[o + x0 - 1]; if (x0 < gw - 1) v += G[o + x0 + 1]; T2[o + x0] = v / 4; } }
        for (let y = 0; y < gh; y++) { const o = y * gw; for (let x0 = 0; x0 < gw; x0++) { let v = T2[o + x0] * 2; if (y) v += T2[o - gw + x0]; if (y < gh - 1) v += T2[o + gw + x0]; G[o + x0] = v / 4; } }
      }
      // scale by a high percentile of the busy water (not the single hottest cell) with a fixed floor,
      // so the busiest lanes reach red/white and quiet water with one ship stays a faint blue
      const vals = []; for (let i = 0; i < G.length; i++) if (trWater[i] && G[i] > 0.05) vals.push(G[i]);
      vals.sort((u, v) => u - v); const M = Math.max(vals.length ? vals[Math.floor(vals.length * 0.97)] : 0, 3);
      const x = trCv.getContext('2d'), im = x.createImageData(gw, gh), d = im.data;
      for (let i = 0; i < G.length; i++) { const v = G[i]; if (v < 0.05 || !trWater[i]) continue; const q = Math.min(1, v / M);
        let k = 0; while (k < TR_RAMP.length - 2 && q > TR_RAMP[k + 1][0]) k++;
        const A0 = TR_RAMP[k], A1 = TR_RAMP[k + 1], f = Math.max(0, Math.min(1, (q - A0[0]) / (A1[0] - A0[0])));
        for (let c = 1; c <= 4; c++) d[i * 4 + c - 1] = A0[c] + (A1[c] - A0[c]) * f; }
      x.putImageData(im, 0, 0); return trCv;
    }
    // intensity -> [r, g, b, alpha]: faint blue, cyan, green-yellow, orange, red, white-hot
    const TR_RAMP = [[0, 30, 70, 160, 40], [0.12, 30, 150, 220, 110], [0.3, 60, 220, 200, 170], [0.5, 190, 235, 70, 215], [0.68, 255, 170, 30, 240], [0.85, 255, 55, 40, 255], [1, 255, 245, 230, 255]];
    function warshipFuture() {
      if (wsFrame === unitFrame && wsFuture) return wsFuture;
      wsFrame = unitFrame; const pos = new Map(), path = new Map();
      for (const u of units.values()) if (u.type === UT.WARSHIP) { pos.set(u.id, [u.x, u.y]); path.set(u.id, [[u.x, u.y]]); }
      for (let k = unitFrame + 1; k < Math.min(unitTicks.length, unitFrame + 1 + WS_AHEAD) && pos.size; k++) {
        for (const e of D.timeline.units[k][1]) if (pos.has(e[0])) { const p = [e[1] % W, Math.floor(e[1] / W)]; pos.set(e[0], p); path.get(e[0]).push(p); }
        eachMove(k, (id, dx, dy) => { const p = pos.get(id); if (!p) return; const q = [p[0] + dx, p[1] + dy]; pos.set(id, q); path.get(id).push(q); });
        for (const id of D.timeline.units[k][2]) if (pos.has(id)) { pos.delete(id); path.get(id).sunk = true; }
      }
      return (wsFuture = path);
    }
    function peekNext() { // positions at the next unit sample, for interpolation
      if (peek && peek.k === unitFrame + 1) return peek;
      const k = unitFrame + 1, pos = new Map();
      if (k < unitTicks.length) {
        for (const e of D.timeline.units[k][1]) pos.set(e[0], [e[1] % W, Math.floor(e[1] / W)]);
        eachMove(k, (id, dx, dy) => { const u = units.get(id); if (u) pos.set(id, [u.x + dx, u.y + dy]); });
      }
      return (peek = { k, pos });
    }

    // ----- one pass over the whole match: nuke explosions, launches, kills -----
    let effects = [], feed = [], marks = [], kills = [], allies = []; const allyOpen = new Map(), deathAt = new Map(), away = [], traitors = [], TRAITOR_T = 300, donations = []; // donations: { t, a (from), b (to), gold, n } // traitors: { sid, from, to } // away: { sid, from, to } players who left the game // allies: { a, b, from, to, broken, traitor } // kills: every elimination (team kill counts); feed: only what matters
    let pUnits = 0, pEvents = 0, pStats = 0; const pMap = new Map(), pHad = new Set(), pGone = new Set();
    function prescan() { // goes on from where the last call stopped (a live replay keeps growing)
      const map = pMap;
      for (; pUnits < unitTicks.length; pUnits++) { const k = pUnits;
        const [tick, full] = D.timeline.units[k];
        for (const e of full) if (NUKE_NAME[e[2]] && !map.has(e[0])) feed.push({ t: tick, kind: 'nuke', owner: e[3], type: e[2] });
        applyUnitFrame(k, map, (u, t) => { if (NUKE_R[u.type]) effects.push({ t, x: u.x, y: u.y, r: NUKE_R[u.type], type: u.type }); });
      }
      for (; pEvents < D.timeline.events.length; pEvents++) { const e = D.timeline.events[pEvents];
        if (e[1] === 'k' && !deathAt.has(e[3])) deathAt.set(e[3], e[0]); // when each player was eliminated
        if (e[1] === 'k' && !(bySid.get(e[2])?.type === 'BOT' && bySid.get(e[3])?.type === 'BOT')) {
          kills.push({ t: e[0], a: e[2], b: e[3] });
          if (bySid.get(e[3])?.type === 'HUMAN') feed.push({ t: e[0], kind: 'kill', a: e[2], b: e[3] }); // bots and nations are not news
        }
        if (e[1] === 'w') feed.push({ t: e[0], kind: 'win', w: e[2] });
        if (e[1] === 'dn' && e[2] && e[3]) donations.push({ t: e[0], a: e[2], b: e[3], gold: !!e[4], n: e[5] });
        if (e[1] === 'dc') { // left the game / came back
          if (e[3]) { away.push({ sid: e[2], from: e[0], to: Infinity }); if (bySid.get(e[2])?.type === 'HUMAN' && !(deathAt.get(e[2]) <= e[0])) feed.push({ t: e[0], kind: 'left', sid: e[2] }); /* only players still alive */ }
          else { const iv = away.findLast(a => a.sid === e[2] && a.to === Infinity); if (iv) iv.to = e[0]; }
        }
        if (e[1] === 'ae') { // expiry time of an alliance (set when it forms, moved when both extend)
          const iv = allyOpen.get(Math.min(e[2], e[3]) + ':' + Math.max(e[2], e[3])); if (iv) (iv.exps || (iv.exps = [])).push([e[0], e[4]]);
        }
        if (e[1] === 'al' || e[1] === 'ab' || e[1] === 'ax') {
          const key = Math.min(e[2], e[3]) + ':' + Math.max(e[2], e[3]);
          if (e[1] === 'al') { if (!allyOpen.has(key)) { const iv = { a: e[2], b: e[3], from: e[0], to: Infinity, broken: false }; allyOpen.set(key, iv); allies.push(iv); } }
          else { const iv = allyOpen.get(key); if (iv) { iv.to = e[0]; iv.broken = e[1] === 'ab'; iv.traitor = e[1] === 'ab' ? e[2] : 0; allyOpen.delete(key); } }
          if (e[1] === 'ab') {
            const isT = sid => traitors.some(x => x.sid === sid && x.from <= e[0] && e[0] < x.to), gone = away.some(a => a.sid === e[3] && a.from <= e[0] && e[0] < a.to);
            if (!isT(e[3]) && !gone) { const cur = traitors.find(x => x.sid === e[2] && x.to > e[0]); if (cur) cur.to = e[0] + TRAITOR_T; else traitors.push({ sid: e[2], from: e[0], to: e[0] + TRAITOR_T }); }
          }
          if (e[1] === 'ab' && bySid.get(e[2])?.type === 'HUMAN' && bySid.get(e[3])?.type === 'HUMAN') feed.push({ t: e[0], kind: 'betray', a: e[2], b: e[3] });
        }
      }
      kills.sort((a, b) => a.t - b.t); feed.sort((a, b) => a.t - b.t);
      // a whole team out: the first stats sample where none of its players holds land any more
      // (players can also lose their last tiles without a conquest event, e.g. to bots or nukes)
      const had = pHad, gone = pGone;
      for (; pStats < D.timeline.stats.length; pStats++) { const [tick, row] = D.timeline.stats[pStats];
        const land = new Map(); for (let k = 0; k < row.length; k += 4) land.set(row[k], row[k + 1]);
        for (const tm of teams) {
          if (gone.has(tm)) continue;
          const alive = tm.members.some(p => (land.get(p.sid) || 0) > 0);
          if (alive) { had.add(tm); continue; }
          if (!had.has(tm)) continue;
          gone.add(tm);
          const last = kills.filter(k => k.t <= tick && tm.members.some(p => p.sid === k.b)).pop();
          feed.push({ t: tick, kind: 'teamout', team: tm, by: last ? last.a : 0 });
        }
      }
      feed.sort((a, b) => a.t - b.t || (a.kind === 'teamout') - (b.kind === 'teamout'));
      marks.length = 0;
      for (const f of feed) {
        if (f.kind === 'nuke') marks.push({ t: f.t, c: '#ff9a3c' });
        else if (f.kind === 'kill') marks.push({ t: f.t, c: '#ff4d6d' });
        else if (f.kind === 'win') marks.push({ t: f.t, c: '#ffd23f' });
      }
    }

    // ----- railroads -----
    let railSegs = [], railEvTicks = [], railIdx = -2, railDone = 0; const railLive = new Map();
    function setupRails() {
      const live = railLive;
      for (; railDone < D.timeline.rails.length; railDone++) { const e = D.timeline.rails[railDone];
        const t = e[0];
        if (e[1] === 'c') { const s = { from: t, to: Infinity, tiles: e[3] }; live.set(e[2], s); railSegs.push(s); }
        else if (e[1] === 'd') { const s = live.get(e[2]); if (s) { s.to = t; live.delete(e[2]); } }
        else if (e[1] === 's') {
          const s = live.get(e[2]); if (s) { s.to = t; live.delete(e[2]); }
          const a = { from: t, to: Infinity, tiles: e[4] }, b = { from: t, to: Infinity, tiles: e[6] };
          live.set(e[3], a); live.set(e[5], b); railSegs.push(a, b);
        }
        railEvTicks.push(t);
      }
    }
    function seekRails(t) {
      const i = bsearch(railEvTicks, t);
      if (i === railIdx) return;
      railIdx = i; railMask.fill(0);
      for (const s of railSegs) {
        if (s.from > t || s.to <= t) continue;
        const L = s.tiles;
        for (let j = 0; j < L.length; j++) {
          const a = L[j];
          for (const nb of [L[j - 1], L[j + 1]]) {
            if (nb === undefined) continue;
            const d = nb - a;
            railMask[a] |= d === -W ? 1 : d === 1 ? 2 : d === W ? 4 : d === -1 ? 8 : 0;
          }
          if (L.length === 1) railMask[a] |= 15;
        }
      }
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, railTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED_INTEGER, gl.UNSIGNED_BYTE, railMask);
    }

    // ----- stats (tiles, troops, gold) -----
    let statTicks = [];
    function statsAt(t) {
      const S = D.timeline.stats, i = Math.max(0, bsearch(statTicks, t)), out = new Map();
      // bots are only sampled every 5th time: take them from the latest sample that has them
      let bi = i; const botEvery = D.header.stat * 5;
      while (bi > 0 && S[bi][0] % botEvery !== 0 && bi !== S.length - 1) bi--;
      const read = (row, onlyBots, frac, next) => {
        for (let k = 0; k < row.length; k += 4) {
          const sid = row[k], p = bySid.get(sid); if (onlyBots && p?.type !== 'BOT') continue;
          out.set(sid, [row[k + 1], row[k + 2], row[k + 3]]);
        }
      };
      read(S[bi][1], true); read(S[i][1], false);
      // smooth troop / tile counts toward the next sample
      const j = i + 1;
      if (j < S.length && S[j][0] > S[i][0]) {
        const a = Math.max(0, Math.min(1, (t - S[i][0]) / (S[j][0] - S[i][0]))), row = S[j][1];
        for (let k = 0; k < row.length; k += 4) { const v = out.get(row[k]); if (v && bySid.get(row[k])?.type !== 'BOT') { v[0] += (row[k + 1] - v[0]) * a; v[1] += (row[k + 2] - v[1]) * a; } }
      }
      return out;
    }

    // ----- crown: the player with the most land (bots left out) and since when they hold it -----
    let crownRuns = null; // [{ sid, from }] one entry per change of leader, from the stat samples
    function crownAt(t) {
      if (!crownRuns) {
        crownRuns = []; let cur = 0;
        for (const [tick, row] of D.timeline.stats) {
          let best = 0, bt = 0; for (let k = 0; k < row.length; k += 4) { const p = bySid.get(row[k]); if (!p || p.type === 'BOT') continue; if (row[k + 1] > bt) { bt = row[k + 1]; best = row[k]; } }
          if (best && best !== cur) { cur = best; crownRuns.push({ sid: best, from: tick }); }
        }
      }
      let r = null; for (const c of crownRuns) { if (c.from <= t) r = c; else break; } return r;
    }
    function drawCrown(cx, cy, w) { // gold crown, bottom centre at (cx, cy), width w
      const h = w * 0.62, l = cx - w / 2;
      ctx.beginPath(); ctx.moveTo(l, cy); ctx.lineTo(l, cy - h * 0.55); ctx.lineTo(l + w * 0.22, cy - h * 0.25); ctx.lineTo(cx, cy - h); ctx.lineTo(l + w * 0.78, cy - h * 0.25); ctx.lineTo(l + w, cy - h * 0.55); ctx.lineTo(l + w, cy); ctx.closePath();
      const g = ctx.createLinearGradient(0, cy - h, 0, cy); g.addColorStop(0, '#fff3b0'); g.addColorStop(0.45, '#ffd23f'); g.addColorStop(1, '#d99a00');
      ctx.shadowColor = 'rgba(255,200,40,.8)'; ctx.shadowBlur = w * 0.35; ctx.fillStyle = g; ctx.fill(); ctx.shadowBlur = 0;
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1.2, w * 0.07); ctx.strokeStyle = 'rgba(60,35,0,.9)'; ctx.stroke();
      ctx.fillStyle = '#e8384f'; for (const [px, py] of [[cx, cy - h], [l, cy - h * 0.55], [l + w, cy - h * 0.55]]) { ctx.beginPath(); ctx.arc(px, py, Math.max(1.3, w * 0.07), 0, Math.PI * 2); ctx.fill(); }
    }

    // ----- names (OpenFront's own placement) -----
    let nameTicks = [];
    function namesAt(t) {
      const S = D.timeline.names, i = bsearch(nameTicks, t); if (i < 0) return new Map();
      const out = new Map(); for (const [sid, x, y, s] of S[i][1]) out.set(sid, [x, y, s]);
      const j = i + 1;
      if (j < S.length) { const a = Math.max(0, Math.min(1, (t - S[i][0]) / Math.max(1, S[j][0] - S[i][0]))), e = a * a * (3 - 2 * a); for (const [sid, x, y, s] of S[j][1]) { const v = out.get(sid); if (v) { v[0] += (x - v[0]) * e; v[1] += (y - v[1]) * e; v[2] += (s - v[2]) * e; } } }
      return out;
    }

    // ----- sprites -----
    const spriteCache = new Map(), structCache = new Map();
    function unitSprite(owner, col, tint) { // tint: '#rrggbb' a page gives its own unit (Season 2: the team colour of a live game)
      const key = owner + ':' + col + (tint ? ':' + tint : ''); let c = spriteCache.get(key); if (c) return c;
      if (!unitGray) return null;
      const tc = tint && /^#[0-9a-f]{6}$/i.test(tint) ? [1, 3, 5].map(i => parseInt(tint.slice(i, i + 2), 16)) : null;
      const pc = tc ? { fill: tc, border: tc.map(v => Math.round(v * .4)) } : pal.get(owner) || { fill: [200, 200, 200], border: [90, 90, 90] }, f = pc.fill, b = pc.border, mid = f.map((v, i) => (v + b[i]) / 2);
      c = document.createElement('canvas'); c.width = 13; c.height = 13; const x = c.getContext('2d'), img = x.createImageData(13, 13), src = unitGray.data, sw = unitGray.width;
      for (let yy = 0; yy < 13; yy++) for (let xx = 0; xx < 13; xx++) {
        const si = (yy * sw + col * 13 + xx) * 4, di = (yy * 13 + xx) * 4, a = src[si + 3]; if (a < 3) continue;
        const g = src[si] / 255, rgb = g > 0.6 ? f : g > 0.45 ? mid : g > 0.34 ? f : b;
        img.data[di] = rgb[0]; img.data[di + 1] = rgb[1]; img.data[di + 2] = rgb[2]; img.data[di + 3] = a;
      }
      if (col === 7 || col === 8) { img.data.fill(0); for (let yy = 5; yy < 8; yy++) for (let xx = 5; xx < 8; xx++) { const di = (yy * 13 + xx) * 4; img.data.set([...(col === 7 ? [255, 255, 255] : b), 255], di); } }
      x.putImageData(img, 0, 0); spriteCache.set(key, c); return c;
    }
    // Structure icons exactly as OpenFront's structure shader draws them (shaders/structure/*.glsl):
    // a shape per type in a square quad (radius 0.45 of the quad, border 0.06 / shapeScale), filled with
    // the player colour darkened in HSV, and the white atlas glyph at iconFill of the icon size on top.
    // Shape per atlas column: City circle, Port pentagon (vertex up), Factory hexagon (flat top),
    // Defense octagon (flat top), SAM square, Silo triangle (vertex up).
    const SIDES = [0, 5, 6, 8, 4, 3], NROT = [0, Math.PI / 2, Math.PI / 6, 0, 0, Math.PI / 2];
    const SSCALE = [1, 1.08, 1.08, 1, 1.4, 1.55], IFILL = [0.85, 0.85, 0.85, 0.8, 1, 0.85];
    function shapePath(x, cx, cy, R, col) {
      x.beginPath(); const n = SIDES[col];
      if (!n) { x.arc(cx, cy, R, 0, Math.PI * 2); return; }
      const an = Math.PI / n; // edge normals at NROT + k*2an, vertices halfway between them
      for (let k = 0; k < n; k++) { const v = NROT[col] + an + k * 2 * an; x[k ? 'lineTo' : 'moveTo'](cx + Math.cos(v) * R, cy + Math.sin(v) * R); }
      x.closePath();
    }
    function structSprite(owner, col, dots) {
      const key = owner + ':' + col + (dots ? ':d' : ''); let c = structCache.get(key); if (c) return c;
      const pc = pal.get(owner); if (!pc) return null;
      const S = 128, ss = SSCALE[col], R = 0.45 * S, bw = 0.06 / ss * S; c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d');
      // classic icons: shape in the player colour, border darkened 0.7, glyph = player colour darkened 0.3
      // (white when the fill is dark); otherwise fill darkened 0.65, border 0.1, white glyph
      const fill = hsvDarken(pc.fill, G.classicIcons ? 1 : 0.65), border = hsvDarken(pc.border, G.classicIcons ? 0.7 : 0.1);
      shapePath(x, S / 2, S / 2, R, col); x.fillStyle = css(border); x.fill();
      shapePath(x, S / 2, S / 2, R - bw, col); x.fillStyle = css(fill); x.fill();
      if (!dots && icons.complete && icons.naturalWidth) {
        const lum = (0.299 * fill[0] + 0.587 * fill[1] + 0.114 * fill[2]) / 255;
        const glyph = G.classicIcons && lum >= 0.25 ? css(hsvDarken(fill, 0.3)) : '#fff';
        const g = S * IFILL[col] / ss, t = document.createElement('canvas'); t.width = t.height = 64; const tx = t.getContext('2d');
        tx.drawImage(icons, col * 64, 0, 64, 64, 0, 0, 64, 64); tx.globalCompositeOperation = 'source-in'; tx.fillStyle = glyph; tx.fillRect(0, 0, 64, 64);
        x.save(); shapePath(x, S / 2, S / 2, R - bw, col); x.clip(); x.globalAlpha = G.classicIcons ? 0.9 : 1; x.drawImage(t, S / 2 - g / 2, S / 2 - g / 2, g, g); x.restore();
      }
      structCache.set(key, c); return c;
    }

    // ----- camera -----
    let vw = 0, vh = 0, dpr = 1;
    function resize() {
      if (P.exporting) return;
      const r = root.getBoundingClientRect(); dpr = Math.min(P.maxDpr || 2, window.devicePixelRatio || 1);
      vw = Math.max(1, r.width); vh = Math.max(1, r.height);
      for (const c of [glCv, ovCv]) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); }
      if (D && !cam.user) fit(true);
    }
    function fit(instant) {
      // P.fitInsets(): CSS px kept clear at the stage edges (e.g. the page's floating playback bar)
      const ins = (P.fitInsets && P.fitInsets()) || {}, t = ins.top || 0, b = ins.bottom || 0, aw = vw, ah = Math.max(50, vh - t - b);
      const s = Math.min(aw / W, ah / H) * 0.98;
      cam.ts = s; cam.tox = (aw - W * s) / 2; cam.toy = t + (ah - H * s) / 2;
      if (instant) { cam.scale = cam.ts; cam.ox = cam.tox; cam.oy = cam.toy; }
      cam.fitted = true;
    }
    function zoomAt(px, py, factor) {
      const ns = Math.max(Math.min(vw / W, vh / H) * 0.5, Math.min(40, cam.ts * factor));
      const wx = (px - cam.tox) / cam.ts, wy = (py - cam.toy) / cam.ts;
      cam.ts = ns; cam.tox = px - wx * ns; cam.toy = py - wy * ns; cam.user = true;
    }
    P.zoomBy = f => zoomAt(vw / 2, vh / 2, f);
    P.fit = () => { cam.user = false; fit(false); };
    P.toScreen = (x, y) => [cam.ox + x * cam.scale, cam.oy + y * cam.scale]; // map tile -> CSS px in the stage
    P.zoom = () => cam.scale;
    // light mode for slow devices: at most 1 canvas pixel per CSS pixel, drawn every other frame
    P.setLowPower = on => { P.lowPower = !!on; P.maxDpr = on ? 1 : 0; resize(); };
    P.ownerAt = e => { const t = tileAt(e); return t >= 0 && state ? state[t] & 4095 : 0; };
    P.lookAt = (x, y, scale, snap) => { cam.ts = scale || cam.ts; cam.tox = vw / 2 - x * cam.ts; cam.toy = vh / 2 - y * cam.ts; cam.user = true; if (snap) { cam.scale = cam.ts; cam.ox = cam.tox; cam.oy = cam.toy; } }; // snap: no glide
    P.unitsNow = () => [...units.values()];
    // nuked land (fallout craters) at tick t: tile count, and the centre of the densest crater area (tiles in
    // 3x3 cells of 32 tiles) (moves the territory to t)
    P.fallout = t => {
      seekTerritory(t); const C = 32, cw = Math.ceil(W / C), cnt = new Uint32Array(cw * Math.ceil(H / C)); let n = 0;
      for (let i = 0; i < N; i++) if (state[i] & 8192) { n++; cnt[((i / W | 0) / C | 0) * cw + ((i % W) / C | 0)]++; }
      let best = -1, bi = 0; const ch = cnt.length / cw;
      for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < cw && y < ch) s += cnt[y * cw + x]; } if (s > best) { best = s; bi = cy * cw + cx; } }
      return { n, x: (bi % cw + 0.5) * C, y: ((bi / cw | 0) + 0.5) * C, near: Math.max(0, best) };
    };
    // debug: cost of n consecutive frames advancing `step` ticks each (no rAF needed)
    P.bench = (n = 60, step = 1.7) => { const a = performance.now(); for (let i = 0; i < n; i++) { P.tick += step; const t = P.tick; seekTerritory(t); uploadTerritory(); seekRails(t); seekUnits(t); const st = statsAt(t); drawGL(); drawOverlay(t, st); } gl.finish(); return (performance.now() - a) / n; };
    // wheel: all events of one frame are merged into a single zoom step (applied in frame())
    let wheelZ = null;
    root.addEventListener('wheel', e => { e.preventDefault(); if (!wheelZ) wheelZ = { cx: e.clientX, cy: e.clientY, f: 1 }; wheelZ.f *= Math.pow(1.0015, -e.deltaY); wheelZ.cx = e.clientX; wheelZ.cy = e.clientY; }, { passive: false });
    let drag = null;
    root.addEventListener('pointerdown', e => {
      // buttons and panels inside the stage (zoom, fit, export) keep their own clicks: capturing the
      // pointer here would send the click to the map instead
      if (e.target.closest && e.target.closest('button, a, input, select, .rpx-zoom, .rpx-export')) return;
      drag = { x: e.clientX, y: e.clientY, ox: cam.tox, oy: cam.toy, moved: false }; root.setPointerCapture(e.pointerId);
    });
    root.addEventListener('pointermove', e => {
      if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; if (P.track) P.stopTrack('manual'); } cam.tox = drag.ox + dx; cam.toy = drag.oy + dy; cam.ox = cam.tox; cam.oy = cam.toy; cam.user = true; }
      else hover(e);
    });
    root.addEventListener('pointerup', e => { if (drag && !drag.moved) click(e); drag = null; });
    root.addEventListener('dblclick', e => { const r = root.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, 2); });
    function tileAt(e) { const r = root.getBoundingClientRect(), x = Math.floor((e.clientX - r.left - cam.ox) / cam.scale), y = Math.floor((e.clientY - r.top - cam.oy) / cam.scale); return x >= 0 && y >= 0 && x < W && y < H ? y * W + x : -1; }
    let hoverSid = 0; // player under the mouse (alliance view highlights their alliances)
    let mouseX = -1e9, mouseY = -1e9;
    function hover(e) { const r = root.getBoundingClientRect(); mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; const t = tileAt(e); const o = t >= 0 ? state[t] & 4095 : 0; hoverSid = o; root.style.cursor = P.trackPick ? (o ? 'crosshair' : 'not-allowed') : o ? 'pointer' : 'grab'; }
    root.addEventListener('pointerleave', () => { hoverSid = 0; mouseX = mouseY = -1e9; });
    // Track a player: P.trackPick waits for a click on a territory; then the camera keeps the whole
    // territory of that player in view (small far-away bits ignored), until stopped, dragged or zoomed by hand
    P.track = 0; P.trackPick = false; let trackBox = null, trackWall = 0, trackRow = null, trackCol = null, trackGoal = null;
    P.startTrack = sid => { P.track = sid; P.trackPick = false; trackBox = null; trackWall = 0; trackGoal = null; emit('track', sid ? bySid.get(sid) : null); };
    // stopped by death, the ✕, Esc or the button: back to the whole map; dragged / zoomed by hand: the camera stays
    P.stopTrack = (why) => { if (!P.track && !P.trackPick) return; const was = P.track; P.track = 0; P.trackPick = false; if (was && why !== 'manual') P.fit(); emit('track', null, why); };
    P.trackDebug = () => trackGoal && { ...trackGoal };
    function updateTrack(t, stats) {
      if (!P.track) return; const st = stats.get(P.track);
      if (!st || st[0] <= 0 || deathAt.get(P.track) <= t) { P.stopTrack('dead'); return; }
      const wall = performance.now();
      if (!trackBox || wall - trackWall > 250) {
        trackWall = wall; if (!trackRow) { trackRow = new Uint32Array(H); trackCol = new Uint32Array(W); } else { trackRow.fill(0); trackCol.fill(0); }
        let n = 0; for (let i = 0; i < N; i++) if ((state[i] & 4095) === P.track) { trackRow[(i / W) | 0]++; trackCol[i % W]++; n++; }
        if (!n) return;
        // bounds holding all but 1% of the tiles on each side: a lone speck far away doesn't widen the view
        const cut = n * 0.01, lim = a => { let c = 0, lo = 0, hi = a.length - 1; while (lo < hi && c + a[lo] <= cut) c += a[lo++]; c = 0; while (hi > lo && c + a[hi] <= cut) c += a[hi--]; return [lo, hi]; };
        const [y0, y1] = lim(trackRow), [x0, x1] = lim(trackCol); trackBox = { x0, x1: x1 + 1, y0, y1: y1 + 1 };
      }
      const ins = (P.fitInsets && P.fitInsets()) || {}, top = (ins.top || 0) + 40, bot = (ins.bottom || 0) + 20, aw = vw - 80, ah = Math.max(50, vh - top - bot);
      const bw = Math.max(20, trackBox.x1 - trackBox.x0), bh = Math.max(20, trackBox.y1 - trackBox.y0), bcx = (trackBox.x0 + trackBox.x1) / 2, bcy = (trackBox.y0 + trackBox.y1) / 2;
      const need = Math.max(Math.min(vw / W, vh / H) * 0.5, Math.min(24, Math.min(aw / bw, ah / bh) * 0.9));
      // calm camera: a goal that only changes when it has to (zoom out as soon as the land no longer fits,
      // zoom in only when it could be 25% closer; pan only when some land would leave the view or it drifted off-centre),
      // then eased toward over about a second of real time, whatever the replay speed
      const g = trackGoal || (trackGoal = { s: need, cx: bcx, cy: bcy, ss: cam.scale, scx: (vw / 2 - cam.ox) / cam.scale, scy: (top + ah / 2 - cam.oy) / cam.scale, wall }); // eases in from the current view
      if (need < g.s * 0.97 || need > g.s * 1.25) g.s = need;
      const hw = aw / g.s / 2, hh = ah / g.s / 2; // the land is framed at 90%, so it only moves when some of it would leave the view
      if (trackBox.x0 < g.cx - hw || trackBox.x1 > g.cx + hw || trackBox.y0 < g.cy - hh || trackBox.y1 > g.cy + hh || Math.hypot(bcx - g.cx, bcy - g.cy) * g.s > Math.min(aw, ah) * 0.2) { g.cx = bcx; g.cy = bcy; }
      const dt = Math.min(0.2, (wall - g.wall) / 1000); g.wall = wall; const k = 1 - Math.exp(-dt / 0.9);
      g.ss = Math.exp(Math.log(g.ss) + (Math.log(g.s) - Math.log(g.ss)) * k); g.scx += (g.cx - g.scx) * k; g.scy += (g.cy - g.scy) * k;
      const sc = g.ss, cx = g.scx, cy = g.scy;
      // the map always fills the whole view: never zoomed out past the map, never showing the empty area around it
      const vb = vh - (ins.bottom || 0), sc2 = Math.max(sc, vw / W, vb / H), clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v)); // vb: top of the playback bar
      cam.ts = sc2; cam.tox = clamp(vw / 2 - cx * sc2, vw - W * sc2, 0); cam.toy = clamp(top + ah / 2 - cy * sc2, vb - H * sc2, 0); cam.user = true;
      cam.scale = cam.ts; cam.ox = cam.tox; cam.oy = cam.toy; // already eased here
    }
    function click(e) { const t = tileAt(e); const o = t >= 0 ? state[t] & 4095 : 0; if (P.trackPick) { if (o) P.startTrack(o); return; } P.focus = o === P.focus ? 0 : o; emit('focus', P.focus ? bySid.get(P.focus) : null); }

    // Stray pixels: small pieces of a player's territory on the sea shore, cut off and far from the rest
    // (connected groups of tiles, 4-neighbour, up to STRAY_MAX tiles, not the player's biggest piece). Found with a flood
    // fill over the current territory, redone at most about once a second while it changes.
    const STRAY_MAX = 30; let strayList = [], strayFrame = -2, strayWall = 0, strayWorker = null, strayBusy = false;
    // runs in a worker (a copy of the territory is sent), so the flood fill never stalls playback
    function strayScan(st, terrain, W, N, MAX) {
      const comp = new Int32Array(N), stack = new Int32Array(N), comps = [], biggest = new Map(); let id = 0;
      for (let i = 0; i < N; i++) {
        if (comp[i]) continue; const o = st[i] & 4095; if (!o) continue;
        id++; let sp = 0, n = 0, sx = 0, sy = 0, sea = 0; stack[sp++] = i; comp[i] = id;
        // does the piece touch the sea (ocean water, bit 0x20; lakes and rivers don't count)
        const look = nb => { const tb = terrain[nb]; if (!(tb & 0x80) && (tb & 0x20)) sea++; };
        while (sp) { const c = stack[--sp], x = c % W; n++; sx += x; sy += (c - x) / W;
          if (n <= MAX) { if (x > 0) look(c - 1); if (x < W - 1) look(c + 1); if (c >= W) look(c - W); if (c + W < N) look(c + W); }
          if (x > 0 && !comp[c - 1] && (st[c - 1] & 4095) === o) { comp[c - 1] = id; stack[sp++] = c - 1; }
          if (x < W - 1 && !comp[c + 1] && (st[c + 1] & 4095) === o) { comp[c + 1] = id; stack[sp++] = c + 1; }
          if (c >= W && !comp[c - W] && (st[c - W] & 4095) === o) { comp[c - W] = id; stack[sp++] = c - W; }
          if (c + W < N && !comp[c + W] && (st[c + W] & 4095) === o) { comp[c + W] = id; stack[sp++] = c + W; } }
        const b = biggest.get(o); if (b === undefined || n > comps[b].n) biggest.set(o, comps.length);
        comps.push({ o, n, x: sx / n, y: sy / n, sea });
      }
      // candidates: small pieces on the sea shore (landings), not the player's main land
      const cand = comps.filter((c, k) => c.n <= MAX && biggest.get(c.o) !== k && c.sea > 0);
      // truly isolated only: no bigger land of the same player within R tiles (so not bits next to
      // their own border or across a river); pieces of one player close together become one marker
      const R = 25, H = N / W, out = [];
      const nearOwnLand = c => { const cx = Math.round(c.x), cy = Math.round(c.y);
        for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) for (let x = Math.max(0, cx - R), o = y * W; x <= Math.min(W - 1, cx + R); x++) { const j = o + x; if ((st[j] & 4095) === c.o && comps[comp[j] - 1].n > MAX) return true; }
        return false; };
      for (const c of cand) { if (nearOwnLand(c)) continue;
        const g = out.find(q => q.o === c.o && Math.abs(q.x - c.x) <= R && Math.abs(q.y - c.y) <= R);
        if (g) { g.x = (g.x * g.n + c.x * c.n) / (g.n + c.n); g.y = (g.y * g.n + c.y * c.n) / (g.n + c.n); g.n += c.n; g.k++; } else out.push({ o: c.o, x: c.x, y: c.y, n: c.n, k: 1 }); }
      return out;
    }
    function findStrays() {
      const wall = performance.now(); if (strayBusy || strayFrame === terrFrame || wall - strayWall < 500) return strayList;
      strayFrame = terrFrame; strayWall = wall;
      if (!strayWorker) {
        try {
          const src = 'const strayScan = ' + strayScan.toString() + ';let terrain=null;onmessage=e=>{if(e.data.terrain)terrain=e.data.terrain;postMessage(strayScan(e.data.st,terrain,e.data.W,e.data.N,e.data.MAX))}';
          strayWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
          strayWorker.onmessage = e => { strayList = e.data; strayBusy = false; };
          strayWorker.postMessage({ terrain: D.terrain.slice(), st: state.slice(), W, N, MAX: STRAY_MAX }); strayBusy = true; return strayList;
        } catch { strayWorker = false; }
      }
      if (strayWorker) { strayWorker.postMessage({ st: state.slice(), W, N, MAX: STRAY_MAX }); strayBusy = true; }
      else strayList = strayScan(state, D.terrain, W, N, STRAY_MAX); // no workers: same scan on the page
      return strayList;
    }

    // Nuke history: every atom bomb, hydrogen bomb and MIRV from the unit timeline: where it was launched
    // (the silo it came from), its target, where it ended and whether it was shot down on the way. Shown
    // until the launching silo is destroyed or taken by another player.
    let nukeHist = null;
    function nukeHistory() {
      if (nukeHist) return nukeHist;
      const silos = new Map(), live = new Map(), list = [], sams = new Map(), samEnds = [], blds = new Map(), bldEnds = [];
      for (let k = 0; k < unitTicks.length; k++) {
        const [tick, full, removed] = D.timeline.units[k];
        for (const e of full) {
          const [id, tile, type, owner, level, , , target] = e, x = tile % W, y = Math.floor(tile / W);
          if (STRUCT[type] !== undefined) blds.set(id, { x, y, type, owner, level: level || 1 });
          if (type === UT.SILO) { const si = silos.get(id); if (!si) silos.set(id, { x, y, owner, gone: Infinity }); else if (si.owner !== owner && si.gone === Infinity) si.gone = tick; continue; }
          if (type === UT.SAM_MISSILE) { const m = sams.get(id); if (m) { m.x = x; m.y = y; } else sams.set(id, { x, y }); continue; }
          if (type !== UT.ATOM && type !== UT.HYDRO && type !== UT.MIRV) continue;
          let n = live.get(id);
          if (!n) {
            // the silo it left from: the closest silo of the owner still standing
            let best = null, bd = 9; for (const si of silos.values()) { if (si.gone !== Infinity || si.owner !== owner) continue; const d = Math.hypot(si.x - x, si.y - y); if (d < bd) { bd = d; best = si; } }
            n = { id, t: tick, type, owner, sx: x, sy: y, silo: best, tx: target >= 0 ? target % W : x, ty: target >= 0 ? Math.floor(target / W) : y, ex: x, ey: y, end: Infinity };
            live.set(id, n); list.push(n);
          } else { n.ex = x; n.ey = y; if (target >= 0) { n.tx = target % W; n.ty = Math.floor(target / W); } }
        }
        eachMove(k, (id, dx, dy) => { const n = live.get(id) || sams.get(id); if (n) { if (n.ex !== undefined) { n.ex += dx; n.ey += dy; } else { n.x += dx; n.y += dy; } } });
        for (const id of removed) {
          const si = silos.get(id); if (si && si.gone === Infinity) si.gone = tick;
          const m = sams.get(id); if (m) { samEnds.push({ t: tick, x: m.x, y: m.y }); sams.delete(id); }
          const bd = blds.get(id); if (bd) { bldEnds.push({ t: tick, ...bd }); blds.delete(id); }
          const n = live.get(id); if (n) { n.end = tick; live.delete(id); }
        }
      }
      // shot down: a SAM missile ended at about the same time and place as the bomb
      for (const n of list) if (n.type !== UT.MIRV && n.end !== Infinity) n.shot = samEnds.some(m => Math.abs(m.t - n.end) <= 6 && Math.hypot(m.x - n.ex, m.y - n.ey) < 40);
      // buildings destroyed by a bomb: gone within a few ticks of the blast, inside its radius (nearest blast wins)
      for (const b of bldEnds) {
        let best = null, bd = Infinity;
        for (const n of list) { if (n.shot || n.end === Infinity || Math.abs(b.t - n.end) > 6) continue; const cx = n.type === UT.MIRV ? n.ex : n.tx, cy = n.type === UT.MIRV ? n.ey : n.ty, d = Math.hypot(b.x - cx, b.y - cy); if (d <= (NUKE_R[n.type] || 20) + 2 && d < bd) { bd = d; best = n; } }
        if (best) (best.destroyed || (best.destroyed = [])).push(b);
      }
      return (nukeHist = list);
    }

    // ----- drawing -----
    // players who left: territory dark charcoal grey (a hint of their colour left), a bright light border, no skin;
    // their buildings and name keep their normal colours
    const traitorsAt = t => traitors.filter(a => a.from <= t && t < a.to && !(deathAt.get(a.sid) <= t)).map(a => a.sid);
    const awayAt = t => away.filter(a => a.from <= t && t < a.to && !(deathAt.get(a.sid) <= t)).map(a => a.sid);
    function updateAwayPalette() {
      if (!palTex || (!away.length && !traitors.length)) return; const list = awayAt(P.tick), tr = traitorsAt(P.tick), key = list.join(',') + '|' + tr.join(','); if (key === awayKey) return; awayKey = key;
      palette.set(palOrig); meta.set(metaOrig);
      for (const sid of list) { const o = sid * 4, b = (4096 + sid) * 4;
        const f = [palOrig[o], palOrig[o + 1], palOrig[o + 2]], g = (f[0] + f[1] + f[2]) / 3;
        for (let i = 0; i < 3; i++) palette[o + i] = Math.round(0.85 * (g * 0.12 + 30) + 0.15 * f[i]); // dark charcoal, a hint of their colour
        palette[o + 3] = 250; palette[b] = 235; palette[b + 1] = 238; palette[b + 2] = 242; meta[o] = 0; }
      for (const sid of tr) if (palette[sid * 4 + 3] === 255) palette[sid * 4 + 3] = 251;
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, palTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 4, gl.RGBA, gl.UNSIGNED_BYTE, palette);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, metaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 2, gl.RGBA, gl.UNSIGNED_BYTE, meta);
    }
    // fallout bloom (OpenFront look): heat of a nuked tile = 1 when the bomb lands, -1/255 per game tick
    let glFrame = 0, bloomOn = false, bl = null;
    function drawBloom() {
      const t = P.tick, q = [];
      for (const e of effects) { const age = t - e.t; if (age < 0 || age >= 255) continue; q.push(e.x + 0.5, e.y + 0.5, e.r + 1, 1 - age / 255); if (q.length >= 128) break; }
      bloomOn = !!opts.ofLook && G.fallout && q.length > 0; if (!bloomOn) return;
      if (!bl) {
        const bw = Math.max(1, Math.floor(W / 8)), bh = Math.max(1, Math.floor(H / 8)), mk = () => { const tx = gl.createTexture(); gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, tx);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, bw, bh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tx, 0); return { tx, fb }; };
        const ext = glProgram(gl, BLOOM_FS), blur = glProgram(gl, BLUR_FS), u = (pr, n) => gl.getUniformLocation(pr, n);
        bl = { bw, bh, A: mk(), B: mk(), ext, blur, eState: u(ext, 'uState'), eMap: u(ext, 'uMap'), eFrame: u(ext, 'uFrame'), eN: u(ext, 'uNukeN'), eNuke: u(ext, 'uNuke'), bTex: u(blur, 'uTex'), bDir: u(blur, 'uDir'), bSize: u(blur, 'uSize') };
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
      gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, null); // never sampled while drawn into
      gl.viewport(0, 0, bl.bw, bl.bh); gl.disable(gl.BLEND);
      gl.useProgram(bl.ext); gl.bindFramebuffer(gl.FRAMEBUFFER, bl.A.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1i(bl.eState, 1); gl.uniform2f(bl.eMap, W, H); gl.uniform1f(bl.eFrame, glFrame); gl.uniform1i(bl.eN, q.length / 4); gl.uniform4fv(bl.eNuke, new Float32Array(q));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.useProgram(bl.blur); gl.uniform1i(bl.bTex, 10); gl.uniform2f(bl.bSize, bl.bw, bl.bh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bl.B.fb); gl.activeTexture(gl.TEXTURE10); gl.bindTexture(gl.TEXTURE_2D, bl.A.tx); gl.uniform2f(bl.bDir, 1 / bl.bw, 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bl.A.fb); gl.bindTexture(gl.TEXTURE_2D, bl.B.tx); gl.uniform2f(bl.bDir, 0, 1 / bl.bh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindTexture(gl.TEXTURE_2D, null); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, bl.A.tx);
    }
    function drawGL() {
      updateAwayPalette(); glFrame++; drawBloom();
      gl.viewport(0, 0, glCv.width, glCv.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(prog);
      gl.uniform2f(uni.uOffset, cam.ox * dpr, cam.oy * dpr); gl.uniform1f(uni.uScale, cam.scale * dpr); gl.uniform1f(uni.uViewH, glCv.height);
      gl.uniform1i(uni.uShowTerr, P.showTerr ? 1 : 0); gl.uniform1i(uni.uShowRails, P.showRails ? 1 : 0); gl.uniform1i(uni.uShowPatterns, P.showPatterns ? 1 : 0);
      gl.uniform1ui(uni.uFocus, (opts.ofLook && hoverSid) || P.focus || 0);
      gl.uniform1i(uni.uOF, opts.ofLook ? 1 : 0); gl.uniform1i(uni.uHiThick, G.thicken);
      gl.uniform3f(uni.uNukeCol, G.nukeColor[0] / 255, G.nukeColor[1] / 255, G.nukeColor[2] / 255); gl.uniform1f(uni.uRailThick, G.railThickness); gl.uniform1f(uni.uBorderMix, opts.borderMix ?? 1); gl.uniform1f(uni.uRailDetail, opts.railDetailZoom ?? 6);
      // OpenFront: rails fade out over 2 zoom steps below railMinZoom (zoom = screen pixels per tile)
      // (opts.railMinZoom: the same fade without the OpenFront look)
      const rmz = opts.ofLook ? G.railMinZoom : opts.railMinZoom;
      gl.uniform1f(uni.uRailFade, rmz != null ? Math.min(1, Math.max(0, (cam.scale - (rmz - 2)) / 2)) : 1);
      gl.uniform1i(uni.uBloom, bloomOn ? 1 : 0); gl.uniform1i(uni.uBloomTex, 9);
      gl.uniform1f(uni.uSat, G.saturation); gl.uniform1f(uni.uAlpha, G.alpha); gl.uniform1f(uni.uHiFill, G.highlightFill); gl.uniform1f(uni.uHiBorder, G.highlightBorder); gl.uniform1i(uni.uSoftNuke, P.softNuke ? 1 : 0); gl.uniform1f(uni.uPulse, 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 3.2));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const FLICK = ['#ffea00', '#ff8c00', '#ff2d00', '#fff4b0'];
    // Outlined text as cached images: rendered once at a size step (~12% apart) and drawn scaled,
    // so zooming only moves images instead of re-rasterising every label each frame.
    const textCache = new Map(), textLast = new Map();
    function drawText(txt, weight, px, fill, stroke, lwk, cx, cy) {
      if (px < 1) return;
      const step = Math.pow(1.12, Math.round(Math.log(px * dpr) / Math.log(1.12))), key = txt + '|' + weight + '|' + step.toFixed(2) + '|' + fill + '|' + stroke + '|' + lwk;
      let im = textCache.get(key);
      // while the camera is still gliding, reuse this text at any size already made (no new rasterising mid-zoom)
      const base = txt + '|' + weight + '|' + fill + '|' + stroke + '|' + lwk;
      if (!im && Math.abs(cam.ts - cam.scale) > 1e-3 * cam.ts) im = textLast.get(base);
      if (!im) {
        if (textCache.size > 3000) { textCache.clear(); textLast.clear(); }
        const c = document.createElement('canvas'), x = c.getContext('2d'), font = `${weight} ${step.toFixed(1)}px ${opts.ofLook ? 'Overpass,' : ''}Inter,system-ui,sans-serif`, lw = lwk < 0 ? -lwk * dpr : Math.max(2, step * lwk); // lwk < 0: line width in CSS px
        x.font = font; const w = Math.ceil(x.measureText(txt).width + lw * 2 + 2), h = Math.ceil(step * 1.35 + lw * 2);
        c.width = w; c.height = h; x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.lineJoin = 'round';
        x.lineWidth = lw; x.strokeStyle = stroke; x.strokeText(txt, w / 2, h / 2); x.fillStyle = fill; x.fillText(txt, w / 2, h / 2);
        im = { c, w, h, step }; textCache.set(key, im); textLast.set(base, im);
      }
      const k = px * dpr / im.step / dpr, dw = im.w * k, dh = im.h * k;
      ctx.drawImage(im.c, cx - dw / 2, cy - dh / 2, dw, dh); return dw;
    }
    // Lighting (OpenFront lighting.ambient / falloffPower): the map is darkened to "ambient" and every
    // building and unit lights a disc around it (same radii and intensities as OpenFront's PointLightPass,
    // in tiles), fading as (1 - d)^falloffPower. Drawn as a dark veil with the lights cut out of it.
    const LIGHT = { 12: [18, 1.2], 5: [18, 1.2], 16: [18, 1.2], 10: [18, 1.2], 11: [18, 1.2], 9: [18, 1.2], 1: [6, 2.7], 8: [6, 2.7], 2: [10, 2.8], 6: [16, 1.1], 7: [22, 1.3], 13: [18, 1.2], 14: [12, 1.0], 15: [6, 0.5] };
    let lightSprite = null, veil = null;
    function drawLighting(t, s, X, Y, inView) {
      if (!lightSprite) { const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), im = x.createImageData(128, 128);
        for (let yy = 0; yy < 128; yy++) for (let xx = 0; xx < 128; xx++) { const d = Math.hypot(xx - 63.5, yy - 63.5) / 64; im.data[(yy * 128 + xx) * 4 + 3] = d >= 1 ? 0 : Math.round(255 * Math.pow(1 - d, G.falloff)); }
        x.putImageData(im, 0, 0); lightSprite = c; }
      if (!veil) veil = document.createElement('canvas');
      if (veil.width !== ovCv.width || veil.height !== ovCv.height) { veil.width = ovCv.width; veil.height = ovCv.height; }
      const v = veil.getContext('2d'); v.setTransform(dpr, 0, 0, dpr, 0, 0); v.globalCompositeOperation = 'source-over'; v.clearRect(0, 0, vw, vh);
      v.fillStyle = `rgba(0,0,0,${1 - G.ambient})`; v.fillRect(0, 0, vw, vh);
      v.globalCompositeOperation = 'destination-out';
      for (const u of units.values()) { const L = LIGHT[u.type]; if (!L || (u.type === UT.TRAIN && !P.showRails) || (!P.showBuildings && STRUCT[u.type] !== undefined)) continue; const R = L[0] * s; if (R < 1 || !inView(u.x, u.y, R)) continue; v.globalAlpha = Math.min(1, L[1]); v.drawImage(lightSprite, X(u.x) - R, Y(u.y) - R, R * 2, R * 2); }
      v.globalAlpha = 1;
      ctx.drawImage(veil, 0, 0, vw, vh);
    }
    // OpenFront CoordinateGridPass (shown with the grid key or alt view): white lines 1.25 px every cell, labels
    // "A1" (row letter, column number) in bold monospace at a cell's top-left once cells are 60 px or more
    function drawGrid(s, X, Y) {
      const raw = Math.min(W, H) / 10; let rows = Math.max(1, Math.round(H / raw)), cols = Math.max(1, Math.round(W / raw));
      if (cols > 50) { rows = Math.max(2, Math.min(rows, Math.floor(50 * H / W))); cols = 50; }
      const cs = Math.min(W / cols, H / rows), a = G.gridOpacity; if (a <= 0) return;
      ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = '#fff';
      const x0 = X(-0.5), y0 = Y(-0.5), x1 = X(W - 0.5), y1 = Y(H - 0.5);
      for (let c = 0; c * cs < W; c++) ctx.fillRect(x0 + c * cs * s, y0, 1.25, y1 - y0);
      for (let r = 0; r * cs < H; r++) ctx.fillRect(x0, y0 + r * cs * s, x1 - x0, 1.25);
      if (cs * s >= 60) {
        const fsz = Math.max(21.6, Math.min(38.4, 24 + (s - 1) * 1.2)); ctx.font = 'bold ' + fsz.toFixed(1) + 'px monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
        ctx.lineWidth = 4 * fsz / 56; ctx.strokeStyle = '#000'; ctx.lineJoin = 'round';
        for (let r = 0; r * cs < H; r++) for (let c = 0; c * cs < W; c++) {
          const lx = x0 + c * cs * s + 8, ly = y0 + r * cs * s + 8; if (lx > vw || ly > vh || lx + cs * s < 0 || ly + cs * s < 0) continue;
          const lab = (r < 26 ? String.fromCharCode(65 + r) : String.fromCharCode(64 + Math.floor(r / 26)) + String.fromCharCode(65 + r % 26)) + (c + 1);
          ctx.strokeText(lab, lx, ly); ctx.fillText(lab, lx, ly);
        }
      }
      ctx.restore();
    }
    function drawOverlay(t, stats) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, vw, vh);
      const s = cam.scale, X = x => cam.ox + (x + 0.5) * s, Y = y => cam.oy + (y + 0.5) * s;
      const inView = (x, y, m) => { const sx = X(x), sy = Y(y); return sx > -m && sy > -m && sx < vw + m && sy < vh + m; };
      const awayNow = new Set(away.length ? awayAt(t) : []);
      if (G.ambient < 1) drawLighting(t, s, X, Y, inView);
      if (P.showGrid) drawGrid(s, X, Y);
      // nuke shockwaves (this site's effect; the OpenFront look has the fallout bloom instead)
      if (!opts.ofLook) for (const e of effects) {
        const age = t - e.t, dur = 14 + P.speed * 2; if (age < 0 || age > dur) continue;
        const k = age / dur, R = e.r * s * (0.35 + 0.65 * Math.sqrt(k));
        ctx.beginPath(); ctx.arc(X(e.x), Y(e.y), Math.max(4, R), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,${Math.round(200 - 120 * k)},60,${0.45 * (1 - k)})`; ctx.fill();
        ctx.lineWidth = 2 + 3 * (1 - k); ctx.strokeStyle = `rgba(255,240,180,${1 - k})`; ctx.stroke();
      }
      if (P.showUnits) {
        const nx = peekNext(), t0 = unitTicks[unitFrame] ?? 0, t1 = unitTicks[unitFrame + 1] ?? t0 + 1, a = Math.max(0, Math.min(1, (t - t0) / Math.max(1, t1 - t0)));
        const posOf = u => { const n = nx.pos.get(u.id); return n ? [u.x + (n[0] - u.x) * a, u.y + (n[1] - u.y) * a] : [u.x, u.y]; };
        const structs = [], ground = [], air = [];
        for (const u of units.values()) { if (P.onlyExtra && STRUCT[u.type] === undefined) continue; /* P.onlyExtra: only the page's own units move (Season 2 battle close-up) */ if (STRUCT[u.type] !== undefined) structs.push(u); else if (u.type === UT.ATOM || u.type === UT.HYDRO || u.type === UT.MIRV || u.type === UT.WARHEAD || u.type === UT.SHELL || u.type === UT.SAM_MISSILE) air.push(u); else ground.push(u); }
        // P.structOverride = { hide: Set(owner sids), add: [{ x, y, type, owner, level }] }: some owners' buildings swapped for others
        if (P.structOverride) { const so = P.structOverride; if (so.hide) for (let i = structs.length - 1; i >= 0; i--) if (so.hide.has(structs[i].owner)) structs.splice(i, 1); if (so.add) for (const a of so.add) structs.push(a); }
        // P.extraUnits(t) = [{ id, type, x, y, owner, hp }]: moving units a page adds itself (Season 2: warships of live battles)
        if (P.extraUnits) try { for (const u of P.extraUnits(t) || []) (u.type === UT.SHELL ? air : ground).push(u); } catch (e) {}
        // opts.structTileColor: a building takes the colour of whoever owns the land under it now (Season 2: land moves between clans and players)
        if (opts.structTileColor && state) for (let i = 0; i < structs.length; i++) { const u = structs[i], o = state[(u.y | 0) * W + (u.x | 0)] & 4095; if (o && o !== u.owner && pal.get(o)) structs[i] = Object.assign({}, u, { owner: o }); }
        if (P.showTrade) { // live trade heat map, softly blurred, under units and names
          const tc = tradeHeat(t); if (tc) { ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.globalAlpha = 0.95; ctx.filter = 'blur(' + Math.max(1, s * 1.4).toFixed(1) + 'px)';
            ctx.drawImage(tc, cam.ox, cam.oy, W * s, H * s); ctx.restore(); } }
        if (P.showSams || P.track) {
          const byTeam = new Map();
          for (const u of structs) { if (u.type !== UT.SAM) continue; if (!P.showSams && u.owner !== P.track) continue; const p = bySid.get(u.owner), key = p && p.team != null ? 't:' + p.team : 'p:' + u.owner;
            if (!byTeam.has(key)) byTeam.set(key, { col: p && p.team != null && D.header.teamColors?.[p.team] || pal.get(u.owner)?.fillCss || '#fff', list: [] }); byTeam.get(key).list.push(u); }
          if (byTeam.size) {
            if (!samCv) samCv = document.createElement('canvas');
            if (samCv.width !== ovCv.width || samCv.height !== ovCv.height) { samCv.width = ovCv.width; samCv.height = ovCv.height; }
            const sx = samCv.getContext('2d');
            for (const { col, list } of byTeam.values()) {
              // OpenFront samRange(level) = 150 - 480 / (level + 5) tiles (70 at level 1)
              const discs = list.map(u => [X(u.x), Y(u.y), (150 - 480 / ((u.level || 1) + 5)) * s, u.flags & 1]).filter(([x, y, r]) => x > -r && y > -r && x < vw + r && y < vh + r);
              if (!discs.length) continue;
              sx.setTransform(dpr, 0, 0, dpr, 0, 0); sx.globalCompositeOperation = 'source-over'; sx.clearRect(0, 0, vw, vh);
              // outline of the union: every disc slightly bigger, then the discs cut out of it
              sx.fillStyle = col; for (const [x, y, r] of discs) { sx.beginPath(); sx.arc(x, y, r + 1.6, 0, Math.PI * 2); sx.fill(); }
              sx.globalCompositeOperation = 'destination-out'; for (const [x, y, r] of discs) { sx.beginPath(); sx.arc(x, y, r, 0, Math.PI * 2); sx.fill(); }
              sx.globalCompositeOperation = 'source-over'; sx.globalAlpha = 0.13; for (const [x, y, r] of discs) { sx.beginPath(); sx.arc(x, y, r, 0, Math.PI * 2); sx.fill(); } sx.globalAlpha = 1;
              ctx.drawImage(samCv, 0, 0, vw, vh);
              // level 5+ (upgraded) SAM: a stronger, glowing double ring with a slowly turning gold dash
              const up = list.filter(u => (u.level || 1) >= 5).map(u => [X(u.x), Y(u.y), (150 - 480 / ((u.level || 1) + 5)) * s, u.level]).filter(([x, y, r]) => x > -r && y > -r && x < vw + r && y < vh + r);
              if (up.length) { const now = performance.now() / 1000; ctx.save();
                for (const [x, y, r, lv] of up) {
                  ctx.shadowColor = col; ctx.shadowBlur = 14; ctx.lineWidth = 3.2; ctx.strokeStyle = col; ctx.globalAlpha = 0.95; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
                  ctx.shadowBlur = 0; ctx.lineWidth = 1.6; ctx.strokeStyle = '#ffd23f'; ctx.setLineDash([10, 8]); ctx.lineDashOffset = -now * 18; ctx.beginPath(); ctx.arc(x, y, r - 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
                  ctx.globalAlpha = 1; ctx.font = '800 11px Inter,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.strokeText('★ SAM ' + lv, x, y - r - 9); ctx.fillStyle = '#ffd23f'; ctx.fillText('★ SAM ' + lv, x, y - r - 9);
                }
                ctx.restore(); }
            }
          }
        }
        // structures: OpenFront icon shapes, dots when zoomed far out
        // OpenFront sizing (structure.vert.glsl): at zoom <= 1.2 dots (0.3 of the icon size), from zoom 7 the
        // icon grows with the map, in between min(1, zoom / 3) of iconSize; each shape has its own scale
        const dots = G.showDots && s <= 1.2, iconScale = dots ? 0.3 : s >= 7 ? s / 7 : Math.min(1, s / 3), base = G.iconSize * iconScale;
        ctx.imageSmoothingEnabled = true;
        // the replay player's Buildings button hides only these (trains, ships and the trade heat stay)
        // (with the SAM view on, SAM launchers stay visible next to their range zones)
        for (const u of structs) {
          if (!P.showBuildings && !(P.showSams && u.type === UT.SAM)) continue;
          if (!inView(u.x, u.y, base)) continue;
          const pc = pal.get(u.owner); if (!pc) continue;
          ctx.globalAlpha = (u.flags & 1) ? 0.45 : 1;
          const col = STRUCT[u.type], d = base * SSCALE[col], sp = structSprite(u.owner, col, dots);
          if (sp) ctx.drawImage(sp, X(u.x) - d / 2, Y(u.y) - d / 2, d, d);
          // level above the icon (structure-level shader: size ~ half the icon, sitting on its top edge)
          if (!dots && u.level > 1 && base >= 14) { const hh = base / 2; drawText(String(u.level), 800, hh * 0.95, '#fff', 'rgba(0,0,0,.85)', 0.22, X(u.x), Y(u.y) - hh * 0.6 - hh * 0.45); }
        }
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = false;
        const us = Math.max(s, opts.minUnitScale ?? 0.85); // sprite texel -> screen px (world-space like OpenFront, readable when zoomed out; opts.minUnitScale = the floor)
        const drawSprite = (u, col) => { const sp = unitSprite(u.owner, col, u.color); if (!sp) return; const [x, y] = posOf(u); if (!inView(x, y, 30)) return; const d = 13 * us * (u.scale || 1); ctx.drawImage(sp, X(x) - d / 2, Y(y) - d / 2, d, d); }; // u.scale: a page's extra unit drawn smaller
        // boat trails
        for (const u of ground) if (u.trail && u.type === UT.TRANSPORT && u.trail.length > 3) { const pc = pal.get(u.owner); ctx.globalAlpha = 0.55; ctx.strokeStyle = pc ? pc.fillCss : '#fff'; ctx.lineWidth = Math.max(1, s * 0.8); ctx.beginPath(); for (let i = 0; i < u.trail.length; i += 6) ctx[i ? 'lineTo' : 'moveTo'](X(u.trail[i]), Y(u.trail[i + 1])); const [x, y] = posOf(u); ctx.lineTo(X(x), Y(y)); ctx.stroke(); ctx.globalAlpha = 1; }
        // with railroads hidden, trains (and their glow) are hidden too
        for (const u of ground) if (u.type !== UT.TRAIN || P.showRails) drawSprite(u, u.type === UT.TRAIN ? (u.tt === 3 ? ((u.flags & 4) ? 11 : 10) : 9) : UNIT_COL[u.type] ?? 1);
        // warships: veterancy pips (gold lines at the sprite's bottom-right, one per rank, as in OpenFront)
        // and a health bar above the ship when it is damaged
        for (const u of ground) { if (u.type !== UT.WARSHIP || (!u.vet && !(u.hp < 10))) continue; const [x, y] = posOf(u); if (!inView(x, y, 30)) continue;
          const cx = X(x) - 0.5 * s, cy = Y(y) - 0.5 * s, k = us * (u.scale || 1);
          for (let v = 0; v < (u.vet || 0); v++) { const px = cx + 1.5 * k, py = cy + (3.5 - v * 2) * k; ctx.fillStyle = 'rgba(0,0,0,.7)'; ctx.fillRect(px - 0.5, py - 0.5, 4 * k + 1, Math.max(1.5, k) + 1); ctx.fillStyle = '#ffd600'; ctx.fillRect(px, py, 4 * k, Math.max(1.5, k)); }
          if (u.hp < 10) { const w = 11 * k, h = Math.max(2, 3 * k * 0.6), bx = cx - w / 2, by = cy - 6 * k - h; ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fillRect(bx - 1, by - 1, w + 2, h + 2); const f = Math.max(0, u.hp) / 10; ctx.fillStyle = f > 0.6 ? '#4ade80' : f > 0.3 ? '#facc15' : '#ef4444'; ctx.fillRect(bx, by, w * f, h); } }
        // warship view: firing range, the route ahead with an arrow, or the patrol area when it stays put
        // warship view; while tracking, the tracked player's warships are shown even with it off
        if (P.showWarships || P.track) {
          const fut = warshipFuture();
          for (const u of ground) {
            if (u.type !== UT.WARSHIP) continue; if (!P.showWarships && u.owner !== P.track) continue; const pc = pal.get(u.owner), col = pc ? pc.fillCss : '#fff', [x, y] = posOf(u);
            const R = WS_RANGE * s; if (!inView(x, y, R)) continue;
            ctx.beginPath(); ctx.arc(X(x), Y(y), R, 0, Math.PI * 2); ctx.globalAlpha = 0.07; ctx.fillStyle = col; ctx.fill();
            ctx.globalAlpha = 0.5; ctx.setLineDash([6, 5]); ctx.lineWidth = 1.2; ctx.strokeStyle = col; ctx.stroke(); ctx.setLineDash([]);
            const path = fut.get(u.id) || [], end = path[path.length - 1] || [x, y], moved = Math.hypot(end[0] - x, end[1] - y);
            if (moved >= 3) {
              ctx.globalAlpha = 0.9; ctx.lineWidth = Math.max(1.5, s * 0.9); ctx.strokeStyle = col; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(X(x), Y(y));
              for (let i = 2; i < path.length; i += 2) ctx.lineTo(X(path[i][0]), Y(path[i][1])); ctx.lineTo(X(end[0]), Y(end[1]));
              const lw = ctx.lineWidth; ctx.strokeStyle = 'rgba(0,0,0,.65)'; ctx.lineWidth = lw + 2.5; ctx.stroke(); ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.stroke(); // dark edge: readable on any land colour
              // arrowhead at the end of the route
              const a = path.length > 3 ? path[path.length - 4] : [x, y], ang = Math.atan2(Y(end[1]) - Y(a[1]), X(end[0]) - X(a[0])), L = Math.max(7, s * 3);
              ctx.beginPath(); ctx.moveTo(X(end[0]), Y(end[1])); ctx.lineTo(X(end[0]) - L * Math.cos(ang - 0.45), Y(end[1]) - L * Math.sin(ang - 0.45)); ctx.lineTo(X(end[0]) - L * Math.cos(ang + 0.45), Y(end[1]) - L * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke();
              if (path.sunk) { ctx.globalAlpha = 1; ctx.font = `700 ${Math.max(11, s * 4)}px Inter,system-ui,sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ff6b6b'; ctx.fillText('✕', X(end[0]), Y(end[1]) - L); }
            } else { // standing still: the area it patrols
              ctx.globalAlpha = 0.45; ctx.setLineDash([2, 6]); ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(X(x), Y(y), WS_PATROL * s, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
            }
            ctx.globalAlpha = 1;
          }
        }
        // nukes: trail + flickering sprite, target marker
        const flick = Math.floor(performance.now() / 90);
        for (const u of air) {
          const [x, y] = posOf(u), pc = pal.get(u.owner);
          if (u.trail && u.trail.length > 3 && u.type !== UT.SHELL) { ctx.globalAlpha = 0.7; ctx.strokeStyle = pc ? pc.fillCss : '#fff'; ctx.lineWidth = Math.max(1.2, s * 0.9); ctx.beginPath(); for (let i = 0; i < u.trail.length; i += 2) ctx[i ? 'lineTo' : 'moveTo'](X(u.trail[i]), Y(u.trail[i + 1])); ctx.lineTo(X(x), Y(y)); ctx.stroke(); ctx.globalAlpha = 1; }
          if (u.target >= 0 && NUKE_R[u.type] && u.type !== UT.WARHEAD) { const tx = u.target % W, ty = Math.floor(u.target / W); ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(255,80,60,.85)'; ctx.beginPath(); ctx.arc(X(tx), Y(ty), Math.max(5, NUKE_R[u.type] * s), 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
          if (NUKE_R[u.type]) { ctx.beginPath(); ctx.arc(X(x), Y(y), Math.max(3, (u.type === UT.HYDRO ? 4.5 : 3.5) * us), 0, Math.PI * 2); ctx.fillStyle = FLICK[(flick + u.id) % 4]; ctx.fill(); }
          drawSprite(u, UNIT_COL[u.type]);
        }
      }
      // alliances active now: a soft gold arc between the two players' names (teammates are skipped);
      // new ones fade in, a betrayal flashes red for a moment
      // while tracking a player: only their alliances, donations and SAM ranges are shown, even with those views off
      const trk = P.track, onlyAl = trk && !P.showAllies;
      if ((P.showAllies || trk) && allies.length) {
        // colour by the time left: green with 5:00 or more, yellow at 2:30, red at 0:00 (smoothly in between);
        // thin line with a dark edge and a soft glow,
        // dots flowing along it, a small badge in the middle; hovering a player shows only theirs
        const AL_G = [64, 200, 90], AL_Y = [252, 204, 30], AL_R = [250, 70, 70];
        const timeCol = sec => { const f = Math.max(0, Math.min(1, sec / 300)), [A, B, k] = f >= 0.5 ? [AL_Y, AL_G, (f - 0.5) / 0.5] : [AL_R, AL_Y, f / 0.5]; return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',') + ')'; };
        const nm = namesAt(t), now = performance.now() / 1000; ctx.save(); ctx.lineCap = 'round';
        // when this alliance ends (game ticks): the last recorded expiry before t; older replays without
        // it: the expiry tick if it ran out, otherwise OpenFront's default 5 minutes from the start
        const expAt = iv => { let x = null; if (iv.exps) for (const [tk, ex] of iv.exps) { if (tk <= t + 5) x = ex; else break; } return x ?? (iv.to !== Infinity && !iv.broken ? iv.to : iv.from + 3000); };
        const focusOn = hoverSid; // any player under the mouse: their alliances bright, all others dimmed
        for (const iv of allies) {
          if (onlyAl && iv.a !== trk && iv.b !== trk) continue;
          // past its recorded expiry the alliance is over even when no expiry event came (e.g. a player died)
          const live = iv.from <= t && t < iv.to && (!iv.exps || t < expAt(iv) + 20), flash = iv.broken && t >= iv.to && t < iv.to + 60;
          if (!live && !flash) continue;
          const pa = bySid.get(iv.a), pb = bySid.get(iv.b); if (pa && pb && pa.team != null && pa.team === pb.team) continue;
          if (deathAt.get(iv.a) <= t || deathAt.get(iv.b) <= t) continue; // an eliminated player has no alliances
          const A = nm.get(iv.a), B = nm.get(iv.b); if (!A || !B) continue;
          const ax = X(A[0]), ay = Y(A[1]), bx = X(B[0]), by = Y(B[1]), dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy); if (L < 4) continue;
          const cx = (ax + bx) / 2 - dy * 0.18, cy = (ay + by) / 2 + dx * 0.18, mine = !focusOn || iv.a === focusOn || iv.b === focusOn;
          const col = live ? timeCol((expAt(iv) - t) / 10) : '#ff4d4d';
          const fade = live ? Math.min(1, (t - iv.from) / 30) : 1 - (t - iv.to) / 60, alpha = fade * (mine ? 1 : 0.12);
          const curve = () => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); };
          ctx.globalAlpha = alpha;
          curve(); ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke();
          ctx.shadowColor = col; ctx.shadowBlur = mine && focusOn ? 12 : 6;
          curve(); ctx.lineWidth = focusOn && mine ? 2.6 : 1.8; ctx.strokeStyle = col; if (!live) ctx.setLineDash([6, 5]); ctx.stroke(); ctx.setLineDash([]); ctx.shadowBlur = 0;
          if (live) { // dots flowing from one ally to the other and back
            const q = (u2) => { const m = 1 - u2; return [m * m * ax + 2 * m * u2 * cx + u2 * u2 * bx, m * m * ay + 2 * m * u2 * cy + u2 * u2 * by]; };
            ctx.fillStyle = '#fff'; for (let j = 0; j < 3; j++) { const u2 = ((now * 0.12 + j / 3) % 1); const [px, py] = q(u2); ctx.beginPath(); ctx.arc(px, py, 1.6, 0, Math.PI * 2); ctx.fill(); }
            // badge in the middle of the arc
            const [mx, my] = q(0.5); ctx.beginPath(); ctx.arc(mx, my, 10.5, 0, Math.PI * 2); ctx.fillStyle = 'rgba(9,13,19,.9)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke();
            ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('🤝', mx, my + 0.5);
            // countdown to the end of the alliance (game time), orange under 30 s, red under 10 s
            if (mine && (focusOn || L > 60)) { const left = Math.max(0, Math.ceil((expAt(iv) - t) / 10)), txt = Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
              ctx.font = '700 14px Inter,system-ui,sans-serif'; ctx.textAlign = 'left'; const tw = ctx.measureText(txt).width;
              ctx.fillStyle = 'rgba(9,13,19,.85)'; ctx.beginPath(); ctx.roundRect(mx + 13, my - 10, tw + 12, 20, 10); ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
              ctx.fillStyle = col; ctx.fillText(txt, mx + 19, my + 0.5); }
          }
          for (const [px, py] of [[ax, ay], [bx, by]]) { ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke(); }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
      // donations of the last minute (game time): an arrow from giver to receiver, green = troops,
      // gold = gold; several gifts between the same pair add up; fading out as they get older
      if ((P.showDonations || trk) && donations.length) {
        const nm = namesAt(t), pairs = new Map(), now = performance.now() / 1000, onlyDn = trk && !P.showDonations;
        for (const d of donations) { if (d.t > t) break; if (d.t < t - 600) continue; if (onlyDn && d.a !== trk && d.b !== trk) continue; const k = d.a + ':' + d.b + ':' + (d.gold ? 1 : 0); const q = pairs.get(k); if (q) { q.n += d.n; q.last = d.t; } else pairs.set(k, { ...d, last: d.t }); }
        ctx.save(); ctx.lineCap = 'round';
        for (const d of pairs.values()) {
          const A = nm.get(d.a), B = nm.get(d.b); if (!A || !B) continue;
          const ax = X(A[0]), ay = Y(A[1]), bx = X(B[0]), by = Y(B[1]), dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy); if (L < 6) continue;
          const off = d.gold ? -0.16 : 0.16, cx = (ax + bx) / 2 - dy * off, cy = (ay + by) / 2 + dx * off; // troops and gold bend to opposite sides
          const col = d.gold ? '#ffd23f' : '#51cf66', fade = Math.max(0.15, 1 - (t - d.last) / 600);
          const curve = () => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); };
          ctx.globalAlpha = fade; curve(); ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.stroke(); curve(); ctx.lineWidth = 2.4; ctx.strokeStyle = col; ctx.stroke();
          const q = u => { const m = 1 - u; return [m * m * ax + 2 * m * u * cx + u * u * bx, m * m * ay + 2 * m * u * cy + u * u * by]; };
          ctx.fillStyle = '#fff'; for (let j = 0; j < 3; j++) { const [px, py] = q((now * 0.35 + j / 3) % 1); ctx.beginPath(); ctx.arc(px, py, 2, 0, Math.PI * 2); ctx.fill(); } // flowing from giver to receiver
          // arrow head at the receiver
          const [p1x, p1y] = q(0.9), ang = Math.atan2(by - p1y, bx - p1x), H2 = 10, ex = bx - Math.cos(ang) * 6, ey = by - Math.sin(ang) * 6;
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - H2 * Math.cos(ang - 0.45), ey - H2 * Math.sin(ang - 0.45)); ctx.lineTo(ex - H2 * Math.cos(ang + 0.45), ey - H2 * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.stroke();
          const [mx, my] = q(0.5); drawText('+' + compact(d.gold ? d.n : d.n / 10) + (d.gold ? ' 💰' : ' 🪖'), 800, 12, col, 'rgba(0,0,0,.9)', 0.25, mx, my - 9);
        }
        ctx.restore();
      }
      // nuke history: an arc from the silo to where the bomb ended, blast ring sized by the bomb,
      // a cross where it was shot down; stays until the silo is destroyed or captured
      if (P.showNukes) {
        let hov = null, hd = 14; ctx.save(); ctx.lineCap = 'round';
        for (const n of nukeHistory()) {
          if (n.t > t) continue; const gone = n.silo ? n.silo.gone : n.end + 600; if (t >= gone) continue;
          const flying = t < n.end, atEnd = !flying && (n.shot || n.type === UT.MIRV), ex = atEnd ? n.ex : n.tx, ey = atEnd ? n.ey : n.ty; // hits land on the target
          const ax = X(n.sx), ay = Y(n.sy), bx = X(ex), by = Y(ey), dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
          const cx = (ax + bx) / 2 - dy * 0.2, cy = (ay + by) / 2 + dx * 0.2 - L * 0.12;
          const col = pal.get(n.owner)?.fillCss || '#fff', curve = () => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); };
          ctx.globalAlpha = 0.9; ctx.setLineDash(flying ? [6, 5] : []);
          curve(); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.stroke();
          curve(); ctx.lineWidth = n.type === UT.HYDRO ? 2.4 : 1.8; ctx.strokeStyle = col; ctx.stroke(); ctx.setLineDash([]);
          // silo end: small dot; bomb end: blast ring (radius of the bomb) or a red cross when shot down
          ctx.beginPath(); ctx.arc(ax, ay, 3, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.2; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.stroke();
          if (n.shot && !flying) { const k = 5; ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.beginPath(); ctx.moveTo(bx - k, by - k); ctx.lineTo(bx + k, by + k); ctx.moveTo(bx + k, by - k); ctx.lineTo(bx - k, by + k); ctx.stroke(); ctx.lineWidth = 2; ctx.strokeStyle = '#ff5252'; ctx.stroke(); }
          else { const R = Math.max(4, (NUKE_R[n.type] || 20) * s * 0.5); ctx.beginPath(); ctx.arc(bx, by, R, 0, Math.PI * 2); ctx.globalAlpha = flying ? 0.5 : 0.18; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.strokeStyle = col; ctx.stroke();
            ctx.beginPath(); ctx.arc(bx, by, 2.2, 0, Math.PI * 2); ctx.fillStyle = '#ffd23f'; ctx.fill(); }
          if (!flying && n.destroyed) {
            const gs = Math.max(7, Math.min(16, G.iconSize * Math.min(1, s / 3) * 0.6));
            for (const b of n.destroyed) { const gx = X(b.x), gy = Y(b.y), sp = structSprite(b.owner, STRUCT[b.type], false);
              ctx.globalAlpha = 0.45; ctx.filter = 'grayscale(1)'; if (sp) ctx.drawImage(sp, gx - gs / 2, gy - gs / 2, gs, gs); ctx.filter = 'none';
              ctx.globalAlpha = 0.85; const k = gs * 0.32; ctx.lineWidth = 1.6; ctx.strokeStyle = '#ff5252'; ctx.beginPath(); ctx.moveTo(gx - k, gy - k); ctx.lineTo(gx + k, gy + k); ctx.moveTo(gx + k, gy - k); ctx.lineTo(gx - k, gy + k); ctx.stroke(); }
            ctx.globalAlpha = 1; drawText('💥 ' + n.destroyed.reduce((a, b) => a + b.level, 0), 800, 11, '#ffd9d9', 'rgba(0,0,0,.85)', 0.25, bx, by - Math.max(4, (NUKE_R[n.type] || 20) * s * 0.5) - 8); ctx.globalAlpha = 0.9;
          }
          const d = Math.hypot(mouseX - bx, mouseY - by); if (d < hd) { hd = d; hov = { n, x: bx, y: by }; }
          const d2 = Math.hypot(mouseX - ax, mouseY - ay); if (d2 < hd) { hd = d2; hov = { n, x: ax, y: ay }; }
        }
        if (hov) { const n = hov.n, p = bySid.get(n.owner), tgt = state[n.ty * W + n.tx] & 4095, q = tgt && tgt !== n.owner ? bySid.get(tgt) : null;
          const kind = n.type === UT.HYDRO ? 'Hydrogen Bomb' : n.type === UT.MIRV ? 'MIRV' : 'Atom Bomb';
          const txt = (p ? (p.display || p.name) : '?') + ' · ' + kind + (q ? ' → ' + (q.display || q.name) : '') + ' · ' + fmtT(n.t) + (t < n.end ? ' · in flight' : n.shot ? ' · shot down' : '');
          // second line: the buildings this bomb destroyed, per type
          const BN = { [UT.CITY]: ['city', 'cities'], [UT.PORT]: ['port', 'ports'], [UT.FACTORY]: ['factory', 'factories'], [UT.DEFENSE]: ['defense post', 'defense posts'], [UT.SAM]: ['SAM', 'SAMs'], [UT.SILO]: ['silo', 'silos'] };
          let txt2 = ''; if (t >= n.end && !n.shot) { const cnt = new Map(); for (const b of n.destroyed || []) cnt.set(b.type, (cnt.get(b.type) || 0) + b.level); /* a level 4 city counts as 4 */
            txt2 = cnt.size ? 'Destroyed: ' + [...cnt].sort((a, b) => b[1] - a[1]).map(([ty, c]) => c + ' ' + (BN[ty] ? BN[ty][c === 1 ? 0 : 1] : 'building')).join(', ') : 'No buildings destroyed'; }
          ctx.globalAlpha = 1; ctx.font = '700 12px Inter,system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; const tw = Math.max(ctx.measureText(txt).width, ctx.measureText(txt2).width), bx = Math.min(hov.x + 12, vw - tw - 20), bh = txt2 ? 40 : 22, by = hov.y - 16;
          ctx.fillStyle = 'rgba(9,13,19,.92)'; ctx.beginPath(); ctx.roundRect(bx, by - 11, tw + 14, bh, 11); ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = pal.get(n.owner)?.fillCss || '#fff'; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.fillText(txt, bx + 7, by + 0.5); if (txt2) { ctx.fillStyle = n.destroyed ? '#ffb4b4' : '#9aa7b8'; ctx.fillText(txt2, bx + 7, by + 18.5); } }
        ctx.restore();
      }
      // tracking: a bomb that destroyed the tracked player's buildings (anyone's bomb) shows its blast, the
      // crossed-out buildings and a red callout "X nuked Y: −3 cities" for a minute of game time
      if (P.track && !P.showNukes) {
        ctx.save();
        for (const n of nukeHistory()) {
          if (n.shot || !n.destroyed || n.end > t || t > n.end + 600) continue; const mine = n.destroyed.filter(b => b.owner === P.track); if (!mine.length) continue;
          const cx = X(n.type === UT.MIRV ? n.ex : n.tx), cy = Y(n.type === UT.MIRV ? n.ey : n.ty), Rr = Math.max(6, (NUKE_R[n.type] || 20) * s), f = Math.max(0.25, 1 - (t - n.end) / 600);
          ctx.globalAlpha = 0.25 * f; ctx.fillStyle = '#ff3b30'; ctx.beginPath(); ctx.arc(cx, cy, Rr, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 0.8 * f; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#ff6b6b'; ctx.stroke(); ctx.setLineDash([]);
          const gs = Math.max(7, Math.min(16, G.iconSize * Math.min(1, s / 3) * 0.6));
          for (const b of mine) { const gx = X(b.x), gy = Y(b.y), sp = structSprite(b.owner, STRUCT[b.type], false); ctx.globalAlpha = 0.5 * f; ctx.filter = 'grayscale(1)'; if (sp) ctx.drawImage(sp, gx - gs / 2, gy - gs / 2, gs, gs); ctx.filter = 'none';
            ctx.globalAlpha = f; const k = gs * 0.32; ctx.lineWidth = 1.8; ctx.strokeStyle = '#ff4d4d'; ctx.beginPath(); ctx.moveTo(gx - k, gy - k); ctx.lineTo(gx + k, gy + k); ctx.moveTo(gx + k, gy - k); ctx.lineTo(gx - k, gy + k); ctx.stroke(); }
          const pa = bySid.get(n.owner), pb = bySid.get(P.track); ctx.globalAlpha = Math.min(1, f + 0.2);
          drawText('💥 ' + (pa ? (pa.display || pa.name) : '?') + ' nuked ' + (pb ? (pb.display || pb.name) : '?') + ': −' + bldText(mine).replace(/, /g, ', −'), 800, 12, '#ffb4b4', 'rgba(0,0,0,.9)', 0.25, cx, cy - Rr - 12);
        }
        ctx.restore();
      }
      // stray pixels: a pulsing ring in the owner's colour, the same size on screen at every zoom
      if (P.showStrays) {
        const now = performance.now() / 1000, pulse = 0.5 + 0.5 * Math.sin(now * 4); let hov = null, hd = 16;
        // pieces of one player closer than ~18 px on screen share one marker (with the piece count)
        const groups = [];
        for (const c of findStrays()) { const x = X(c.x), y = Y(c.y); if (x < -20 || y < -20 || x > vw + 20 || y > vh + 20) continue;
          const g = groups.find(q => q.o === c.o && Math.abs(q.x - x) < 18 && Math.abs(q.y - y) < 18);
          if (g) { g.x = (g.x * g.k + x * c.k) / (g.k + c.k); g.y = (g.y * g.k + y * c.k) / (g.k + c.k); g.k += c.k; g.n += c.n; } else groups.push({ o: c.o, x, y, k: c.k, n: c.n }); }
        ctx.save();
        for (const c of groups) { const x = c.x, y = c.y;
          const col = pal.get(c.o)?.fillCss || '#fff', r = 7 + 3 * pulse + Math.min(4, Math.sqrt(c.n) * s * 0.5) + (c.k > 1 ? 3 : 0);
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.lineWidth = 4.5; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.stroke(); ctx.lineWidth = 2.2; ctx.strokeStyle = col; ctx.stroke();
          ctx.globalAlpha = 0.35 * (1 - pulse); ctx.beginPath(); ctx.arc(x, y, r + 6 * pulse + 2, 0, Math.PI * 2); ctx.lineWidth = 1.5; ctx.stroke(); ctx.globalAlpha = 1;
          if (c.k > 1) { ctx.font = '800 10px Inter,system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(c.k, x, y + 0.5); ctx.fillStyle = '#fff'; ctx.fillText(c.k, x, y + 0.5); }
          else { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
          const d = Math.hypot(mouseX - x, mouseY - y); if (d < hd) { hd = d; hov = { c, x, y, r }; } }
        if (hov) { const p = bySid.get(hov.c.o), txt = (p ? (p.display || p.name) : '#' + hov.c.o) + ' · ' + (hov.c.k > 1 ? hov.c.k + ' pieces, ' : '') + hov.c.n + (hov.c.n === 1 ? ' tile' : ' tiles');
          ctx.font = '700 12px Inter,system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; const tw = ctx.measureText(txt).width, bx = hov.x + hov.r + 6, by = hov.y;
          ctx.fillStyle = 'rgba(9,13,19,.9)'; ctx.beginPath(); ctx.roundRect(bx, by - 11, tw + 14, 22, 11); ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = pal.get(hov.c.o)?.fillCss || '#fff'; ctx.stroke();
          ctx.fillStyle = '#fff'; ctx.fillText(txt, bx + 7, by + 0.5); }
        ctx.restore();
      }
      // names + troops, where OpenFront would place them
      if (P.showNames) {
        const nm = namesAt(t), crown = crownAt(t); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
        if (opts.ofLook) { drawOFNames(nm, stats, crown, s, X, Y, inView, awayNow); return; }
        for (const [sid, [x, y, size]] of nm) {
          const st = stats.get(sid); if (!st || st[0] <= 0) continue;
          // nameScaleFactor / cullThreshold relative to OpenFront's defaults (0.4 / 0.008)
          const fs = size * s * G.nameScaleFactor / 0.4; if (fs < 7 * G.cullThreshold / 0.008) continue; if (!inView(x, y, fs * 6)) continue;
          const p = bySid.get(sid); if (!p) continue;
          const f = Math.min(fs, 64), name = (awayNow.has(sid) ? '💤 ' : '') + (p.display || p.name); // 💤 = left the game
          // dark names: black text with a player-coloured outline; else white text, dark outline
          const fill = G.darkNames ? '#000' : sid === P.focus ? '#fff6c2' : '#fff', stroke = G.darkNames ? (pal.get(sid)?.fillCss || '#fff') : 'rgba(0,0,0,.55)', lwk = G.darkNames ? 1 / 5 : 1 / 6;
          drawText(name, 700, f, fill, stroke, lwk, X(x), Y(y));
          drawText(compact(st[1] / 10), 600, f * 0.72, fill, stroke, lwk, X(x), Y(y) + f * 0.95);
          const tIv = traitors.length && traitors.find(a => a.sid === sid && a.from <= t && t < a.to);
          if (tIv) { const sec = Math.ceil((tIv.to - t) / 10); drawText('🗡 TRAITOR 0:' + String(sec).padStart(2, '0'), 800, Math.max(9, f * 0.5), '#ff6b6b', 'rgba(0,0,0,.85)', 0.25, X(x), Y(y) + f * 1.75); }
          // the biggest player: a gold crown over the name, and how long they have held it just under it
          if (crown && crown.sid === sid && opts.ofLook) { // OpenFront: status-atlas crown, 1.1 name heights, its top 1.4 name heights above the name centre
            const sz = f * 1.1; if (statusAtlas.complete && statusAtlas.naturalWidth) ctx.drawImage(statusAtlas, 16, 16, 224, 224, X(x) - sz / 2, Y(y) - f * 1.4, sz, sz); }
          else if (crown && crown.sid === sid) { const w = Math.max(16, Math.min(46, f * 1.1)), sec = Math.max(0, Math.floor((t - crown.from) / 10)), tf = Math.max(9, Math.min(15, f * 0.42));
            const ty = Y(y) - f * 0.62 - tf * 0.7; drawText(Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'), 800, tf, '#ffe27a', 'rgba(0,0,0,.85)', 0.25, X(x), ty);
            ctx.save(); drawCrown(X(x), ty - tf * 0.75, w); ctx.restore(); }
        }
      }
    }

    // OpenFront names (NamePass, name.vert/frag.glsl, render-settings.json name.*): Overpass Bold; size from the
    // name size as floor(size * nameScaleFactor) * min(size / 4, 3); fill black for humans (grey 0.3 nations, 0.4 bots)
    // or the player colour with "coloured names"; a 1.4 px outline in the player colour; troops at 0.6 size, 1.1 lines
    // below; hovered player: white glow behind the name; the name plate under the mouse fades to hoverFadeAlpha
    function drawOFNames(nm, stats, crown, s, X, Y, inView, awayNow) {
      for (const [sid, [x, y, size]] of nm) {
        const st = stats.get(sid); if (!st || st[0] <= 0) continue;
        const p = bySid.get(sid); if (!p) continue;
        const b = Math.max(1, Math.floor(size)), nws = Math.max(4, Math.floor(b * G.nameScaleFactor)) * Math.min(b * 0.25, 3) / 48;
        const em = 48 * nws * s, cap = 36 * nws * s; // font size and line height in CSS px
        if (sid !== hoverSid && cap * 2 / Math.max(1, vw) < G.cullThreshold) continue; if (!inView(x, y, em * 6)) continue;
        const pc = pal.get(sid)?.fillCss || '#fff', shade = p.type === 'BOT' ? 102 : p.type === 'FAKEHUMAN' || p.type === 'NATION' ? 77 : 0;
        const fill = G.darkNames ? 'rgb(' + shade + ',' + shade + ',' + shade + ')' : pc, cx = X(x), cy = Y(y), name = (awayNow.has(sid) ? '💤 ' : '') + (p.display || p.name), ty = cy + cap * 1.1;
        const fade = mouseX > -1e8 && Math.abs(mouseY - (cy + cap * 0.4)) < cap * 1.2 && Math.abs(mouseX - cx) < em * name.length * 0.3;
        ctx.save(); if (fade) ctx.globalAlpha = G.hoverFade;
        if (sid === hoverSid && G.hoverGlowAlpha > 0 && G.hoverGlowWidth > 0) {
          const gw = G.hoverGlowWidth; ctx.globalAlpha *= G.hoverGlowAlpha * 0.45; drawText(name, 700, em, 'rgba(255,255,255,0)', '#fff', -2 * (1.4 + gw), cx, cy);
          ctx.globalAlpha = (fade ? G.hoverFade : 1) * G.hoverGlowAlpha * 0.75; drawText(name, 700, em, 'rgba(255,255,255,0)', '#fff', -2 * (1.4 + gw * 0.45), cx, cy);
          ctx.globalAlpha = fade ? G.hoverFade : 1;
        }
        drawText(name, 700, em, fill, pc, -2.8, cx, cy);
        drawText(compact(st[1] / 10), 700, em * 0.6, fill, pc, -2.8, cx, ty);
        if (crown && crown.sid === sid && statusAtlas.complete && statusAtlas.naturalWidth) { const sz = cap * 1.1; ctx.drawImage(statusAtlas, 16, 16, 224, 224, cx - sz / 2, cy - cap * 1.4, sz, sz); }
        ctx.restore();
      }
    }
    // Nuke window: while tracking, a bomb the tracked player launched is followed in a small window in the
    // bottom-left corner (its own low-res render: terrain + territory around the bomb and its target) until
    // it lands, and for about 4 s of game time after the blast.
    let pipCv = null, pipIm = null;
    function drawNukePip(t) {
      if (!P.track || !terrRGBA) return;
      // bombs of the tracked player, or aimed at them (target on their land during the flight, or they destroyed their buildings)
      const rel = [];
      for (const q of nukeHistory()) { if (q.t > t || t > (q.end === Infinity ? 1e12 : q.end + 60)) continue;
        if (t < q.end && q.owner !== P.track && (state[q.ty * W + q.tx] & 4095) === P.track) q.inc = P.track;
        const hit = q.owner !== P.track && (q.inc === P.track || (q.destroyed || []).some(b => b.owner === P.track));
        if (q.owner === P.track || hit) rel.push({ q, inc: hit }); }
      if (!rel.length) return;
      const tgtOf = q => q.type === UT.MIRV ? [q.ex, q.ey] : [q.tx, q.ty];
      // the latest one, plus every other bomb of the same side landing near the same spot: a salvo
      const last = rel[rel.length - 1], n = last.q, inc = last.inc, [lx, ly] = tgtOf(n);
      const grp = rel.filter(r => r.inc === inc && Math.hypot(tgtOf(r.q)[0] - lx, tgtOf(r.q)[1] - ly) <= Math.max(40, (NUKE_R[r.q.type] || 20) * 1.6)).map(r => r.q);
      const Rmax = Math.max(...grp.map(q => NUKE_R[q.type] || 20));
      let cx, cy, span;
      if (grp.length > 1) { // salvo: a fixed view of the impact area only
        const xs = grp.map(q => tgtOf(q)[0]), ys = grp.map(q => tgtOf(q)[1]);
        cx = (Math.min(...xs) + Math.max(...xs)) / 2; cy = (Math.min(...ys) + Math.max(...ys)) / 2;
        span = Math.max(70, Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + Rmax * 2.6);
      } else { // one bomb: the bomb and its target, shrinking as it closes in
        const u = t < n.end ? units.get(n.id) : null, px = u ? u.x : t < n.end ? n.sx : lx, py = u ? u.y : t < n.end ? n.sy : ly;
        cx = (px + lx) / 2; cy = (py + ly) / 2; span = Math.max(70, Math.min(700, Math.max(Math.abs(px - lx), Math.abs(py - ly)) * 1.25 + Rmax * 2.4));
      }
      const cw = 280, ch = 190, sc = Math.min(cw, ch) / span;
      // kept inside the map (no empty area around it)
      const x0 = Math.max(0, Math.min(W - cw / sc, cx - cw / sc / 2)), y0 = Math.max(0, Math.min(H - ch / sc, cy - ch / sc / 2));
      if (!pipCv) { pipCv = document.createElement('canvas'); pipCv.width = cw; pipCv.height = ch; pipIm = pipCv.getContext('2d').createImageData(cw, ch); }
      const d = pipIm.data;
      for (let j = 0; j < ch; j++) { const my = Math.floor(y0 + (j + 0.5) / sc); for (let i = 0; i < cw; i++) { const mx = Math.floor(x0 + (i + 0.5) / sc), o = (j * cw + i) * 4;
        if (mx < 0 || my < 0 || mx >= W || my >= H) { d[o] = 8; d[o + 1] = 12; d[o + 2] = 20; d[o + 3] = 255; continue; }
        const k = my * W + mx, own = state[k] & 4095, tr = k * 4; let r = terrRGBA[tr], g = terrRGBA[tr + 1], b = terrRGBA[tr + 2];
        if (state[k] & 8192) { r = 20; g = 140; b = 25; } else if (own) { const pc = pal.get(own); if (pc) { r = r * 0.45 + pc.fill[0] * 0.55; g = g * 0.45 + pc.fill[1] * 0.55; b = b * 0.45 + pc.fill[2] * 0.55; } }
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255; } }
      const pctx = pipCv.getContext('2d'); pctx.putImageData(pipIm, 0, 0);
      const PX = x => (x + 0.5 - x0) * sc, PY = y => (y + 0.5 - y0) * sc, col = pal.get(n.owner)?.fillCss || '#fff';
      pctx.lineCap = 'round';
      const cross = (x, y, k, w, c) => { pctx.lineWidth = w; pctx.strokeStyle = c; pctx.beginPath(); pctx.moveTo(x - k, y - k); pctx.lineTo(x + k, y + k); pctx.moveTo(x + k, y - k); pctx.lineTo(x - k, y + k); pctx.stroke(); };
      let nFly = 0, nHit = 0, nShot = 0; const lost = [], destroyed = [];
      for (const q of grp) {
        const flying = t < q.end, u = flying ? units.get(q.id) : null, [tx, ty] = tgtOf(q), R = NUKE_R[q.type] || 20;
        if (flying) nFly++; else if (q.shot) nShot++; else nHit++;
        // target ring (blast radius) while it flies
        if (flying) { pctx.setLineDash([5, 4]); pctx.lineWidth = 1.5; pctx.strokeStyle = 'rgba(255,80,60,.9)'; pctx.beginPath(); pctx.arc(PX(tx), PY(ty), R * sc, 0, Math.PI * 2); pctx.stroke(); pctx.setLineDash([]); }
        if (u && u.trail && u.trail.length > 2) { pctx.lineWidth = 2; pctx.strokeStyle = 'rgba(255,220,120,.85)'; pctx.beginPath(); for (let i = 0; i < u.trail.length; i += 2) pctx[i ? 'lineTo' : 'moveTo'](PX(u.trail[i]), PY(u.trail[i + 1])); pctx.stroke(); }
        if (u) { pctx.shadowColor = '#ffd23f'; pctx.shadowBlur = 12; pctx.fillStyle = '#fff'; pctx.beginPath(); pctx.arc(PX(u.x), PY(u.y), 4, 0, Math.PI * 2); pctx.fill(); pctx.shadowBlur = 0; pctx.lineWidth = 1.5; pctx.strokeStyle = col; pctx.stroke(); }
        else if (!flying && q.shot) cross(PX(q.ex), PY(q.ey), 7, 3, '#ff5252');
        else if (!flying) {
          const age = t - q.end, a2 = Math.min(1, age / 12), f = Math.max(0, 1 - age / 40); // blast: a flash growing to the radius, fading out; then the burnt area stays marked
          if (f > 0) { const g = pctx.createRadialGradient(PX(tx), PY(ty), 0, PX(tx), PY(ty), Math.max(4, R * sc * (0.4 + 0.6 * a2)));
            g.addColorStop(0, `rgba(255,255,230,${0.95 * f})`); g.addColorStop(0.4, `rgba(255,190,60,${0.8 * f})`); g.addColorStop(1, 'rgba(255,60,20,0)');
            pctx.fillStyle = g; pctx.beginPath(); pctx.arc(PX(tx), PY(ty), R * sc, 0, Math.PI * 2); pctx.fill(); }
          pctx.lineWidth = 1.2; pctx.strokeStyle = 'rgba(255,120,80,.6)'; pctx.beginPath(); pctx.arc(PX(tx), PY(ty), R * sc, 0, Math.PI * 2); pctx.stroke();
          for (const b of q.destroyed || []) { cross(PX(b.x), PY(b.y), 3.5, 2, b.owner === P.track ? '#ff4d4d' : 'rgba(220,220,220,.8)'); destroyed.push(b); if (b.owner === P.track) lost.push(b); }
        }
      }
      // frame in the bottom-left corner, above the playback bar
      const ins = (P.fitInsets && P.fitInsets()) || {}, bx = 60, by = vh - (ins.bottom || 0) - ch - 16;
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = 1;
      ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 16; ctx.fillStyle = '#0b1018'; ctx.beginPath(); ctx.roundRect(bx - 3, by - 25, cw + 6, ch + 28, 12); ctx.fill(); ctx.shadowBlur = 0;
      ctx.save(); ctx.beginPath(); ctx.roundRect(bx, by, cw, ch, 9); ctx.clip(); ctx.drawImage(pipCv, bx, by); ctx.restore();
      ctx.lineWidth = inc ? 2.5 : 1.5; ctx.strokeStyle = inc ? '#ff4d4d' : col; ctx.beginPath(); ctx.roundRect(bx - 3, by - 25, cw + 6, ch + 28, 12); ctx.stroke();
      // after a blast: what the tracked player lost (incoming) or what the bombs destroyed (their own)
      if (nHit) { const txt = inc ? (lost.length ? 'Lost: ' + bldText(lost) : 'No buildings lost') : (destroyed.length ? 'Destroyed: ' + bldText(destroyed) : 'No buildings destroyed');
        ctx.font = '700 11px Inter,system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; let tt = txt; while (ctx.measureText(tt).width > cw - 16 && tt.length > 8) tt = tt.slice(0, -2) + '…';
        const tw = ctx.measureText(tt).width; ctx.fillStyle = 'rgba(9,13,19,.85)'; ctx.beginPath(); ctx.roundRect(bx + 4, by + ch - 24, tw + 12, 20, 10); ctx.fill(); ctx.fillStyle = inc ? '#ff8787' : '#ffb4b4'; ctx.fillText(tt, bx + 10, by + ch - 14); }
      const p = bySid.get(n.owner), tgt = state[ly * W + lx] & 4095, q2 = tgt && tgt !== n.owner ? bySid.get(tgt) : null;
      const kind = n.type === UT.HYDRO ? 'Hydrogen Bomb' : n.type === UT.MIRV ? 'MIRV' : 'Atom Bomb', many = grp.length > 1;
      const st = many ? [nFly && nFly + ' in flight', nHit && nHit + ' hit', nShot && nShot + ' shot down'].filter(Boolean).join(' · ')
        : (inc && nFly ? 'INCOMING · ' : '') + (nFly ? 'in flight' : nShot ? 'shot down' : 'detonated');
      ctx.font = '700 12px Inter,system-ui,sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
      let lbl = '☢ ' + (p ? (p.display || p.name) : '?') + ' · ' + (many ? '×' + grp.length + ' ' + (grp.every(q => q.type === n.type) ? kind : 'bombs') : kind) + (q2 ? ' → ' + (q2.display || q2.name) : '');
      while (ctx.measureText(lbl + ' · ' + st).width > cw - 8 && lbl.length > 8) lbl = lbl.slice(0, -2) + '…';
      ctx.fillText(lbl, bx + 6, by - 12); ctx.fillStyle = nFly ? '#ffd23f' : nHit ? '#ffa94d' : '#ff8787'; ctx.textAlign = 'right'; ctx.fillText(st, bx + cw - 4, by - 12);
      ctx.restore();
    }

    // ----- main loop -----
    let last = null, uiT = 0, raf = 0, skipN = 0;
    function frame(ts) {
      raf = requestAnimationFrame(frame);
      if (!D || P.exporting) { last = null; return; }
      if (wheelZ) { const r = root.getBoundingClientRect(), z = wheelZ; wheelZ = null; if (P.track) P.stopTrack('manual'); zoomAt(z.cx - r.left, z.cy - r.top, z.f); }
      if (P.lowPower && (skipN++ & 1)) return; // time still advances by the whole gap on the next frame
      const dt = last == null ? 0 : Math.min(100, ts - last); last = ts;
      if (P.playing) { P.tick = P.tick + dt / TICK_MS * P.speed; if (P.tick >= D.header.ticks) { if (P.streaming) { P.tick = D.header.ticks; if (!P.waiting) { P.waiting = true; emit('wait', true); } } else if (opts.loop) P.tick %= D.header.ticks; else { P.tick = D.header.ticks; P.playing = false; emit('play', false); } } else if (P.waiting) { P.waiting = false; emit('wait', false); } }
      // smooth camera
      const k = 1 - Math.pow(0.0001, dt / 1000 * 1.6);
      cam.scale += (cam.ts - cam.scale) * k; cam.ox += (cam.tox - cam.ox) * k; cam.oy += (cam.toy - cam.oy) * k;
      if (Math.abs(cam.ts - cam.scale) < 1e-4) { cam.scale = cam.ts; cam.ox = cam.tox; cam.oy = cam.toy; }
      const t = P.tick, w0 = performance.now();
      seekTerritory(t); uploadTerritory(); seekRails(t); seekUnits(t);
      const stats = statsAt(t); updateTrack(t, stats);
      drawGL(); drawOverlay(t, stats); drawNukePip(t);
      P.frameMs = (P.frameMs || 0) * 0.9 + (performance.now() - w0) * 0.1;
      if (ts - uiT > 200) { uiT = ts; emit('ui', { t, stats }); }
      emit('tick', t);
    }

    // ----- live replays: add a piece (raw data), then bring the derived tables up to date -----
    function appendPiece(c) {
      const tl = D.timeline, L = D.live;
      tl.units.push(...c.units); tl.rails.push(...c.rails); tl.names.push(...c.names); tl.stats.push(...c.stats); tl.events.push(...c.events);
      D.header.frameTicks.push(...c.frameTicks);
      growBytes(L.terr, c.a); growBytes(L.moves, c.b); D.terr = L.terr.buf.subarray(0, L.terr.len); D.moves = L.moves.buf.subarray(0, L.moves.len);
      D.header.ticks = c.tick;
      if (c.end) { D.header.ticks = c.end.ticks; D.header.spawnEnd = c.end.spawnEnd || D.header.spawnEnd; tl.summary = c.end.summary; D.header.liveDone = true; P.streaming = false; }
    }
    // offsets / tick lists for the new records only (indexStream from where the old ones end)
    function extendIndex(off, bytes, n) {
      if (off.length >= n) return off;
      let start = 0; if (off.length) { const last = off.length - 1; start = off[last]; let p = start, c = 0, sh = 0, b; do { b = bytes[p++]; c |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); for (let k = c * 3; k > 0; k--) { while (bytes[p++] & 0x80); } start = p; }
      const more = indexStream(bytes.subarray(start), 3, n - off.length), out = new Uint32Array(n); out.set(off); for (let i = 0; i < more.length; i++) out[off.length + i] = more[i] + start; return out;
    }
    function grown() {
      terrOff = extendIndex(terrOff, D.terr, frameTicks.length);
      for (let k = unitTicks.length; k < D.timeline.units.length; k++) unitTicks.push(D.timeline.units[k][0]);
      moveOff = extendIndex(moveOff, D.moves, unitTicks.length);
      for (let k = statTicks.length; k < D.timeline.stats.length; k++) statTicks.push(D.timeline.stats[k][0]);
      for (let k = nameTicks.length; k < D.timeline.names.length; k++) nameTicks.push(D.timeline.names[k][0]);
      setupRails(); railIdx = -2; prescan();
      if (P.seekTo != null && (D.header.ticks >= P.seekTo || !P.streaming)) { P.tick = Math.min(P.seekTo, D.header.ticks); P.seekTo = null; }
      crownRuns = null; trPos = null; nukeHist = null; wsFuture = null; wsFrame = -2; peek = null;
      emit('live', liveInfo());
    }
    const liveInfo = () => ({ cached: !!D.header.cached, streaming: !!P.streaming, ticks: D.header.ticks, total: D.header.ticksTotal || D.header.ticks, done: !!D.header.liveDone || !D.header.live, error: !!P.liveError });
    P.liveInfo = () => D ? liveInfo() : null;

    // ----- public API -----
    P.play = () => { if (P.tick >= D.header.ticks && !P.streaming) P.tick = D.header.spawnEnd || 0; P.playing = true; emit('play', true); };
    P.pause = () => { P.playing = false; emit('play', false); };
    P.toggle = () => P.playing ? P.pause() : P.play();
    // while a replay is still arriving, a jump past the loaded part waits at its end and lands once that tick is in (grown)
    P.seek = t => { t = Math.max(0, t); if (P.streaming && t > D.header.ticks) { P.seekTo = t; P.tick = D.header.ticks; return; } P.seekTo = null; P.tick = Math.min(D.header.ticks, t); };
    P.setSpeed = s => { P.speed = s; };
    // new graphics settings (OpenFront format, as opts.gfx) without reloading: takes effect on the next frame
    P.setGfx = o => {
      const old = { ...G, ocean: String(G.ocean), land: JSON.stringify(G.land) }; Object.assign(G, gfxFrom(o));
      root.style.background = G.background || '';
      if (old.skins !== G.skins) P.showPatterns = G.skins;
      if (!prog) return;
      if (old.ocean !== String(G.ocean) || old.land !== JSON.stringify(G.land)) {
        terrRGBA = terrainRGBA(D.terrain, opts.sea, W, G.ocean, G.land);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, terrTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, terrRGBA);
      }
      if (old.classicBotColors !== G.classicBotColors) {
        setupPal();
        for (const p of players) { const c = pal.get(p.sid); palOrig.set([...c.fill, 255], p.sid * 4); palOrig.set([...c.border, 255], (4096 + p.sid) * 4); }
        palOrig.copyWithin(4096 * 2 * 4, 0, 4096 * 2 * 4); palette.set(palOrig); awayKey = '-'; // forces the away/traitor recolour to rerun
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, palTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 4, gl.RGBA, gl.UNSIGNED_BYTE, palette);
      }
      if (old.falloff !== G.falloff) lightSprite = null;
      spriteCache.clear(); structCache.clear();
    };
    P.redraw = () => { };
    P.data = () => D;
    P.players = () => players; P.teams = () => teams; P.teamOf = sid => teamOf.get(sid); P.player = sid => bySid.get(sid); P.palette = sid => pal.get(sid);
    P.feed = () => feed; P.marks = () => marks; P.kills = () => kills; P.allies = () => allies; P.strays = () => findStrays(); P.nukes = () => nukeHistory(); P.away = () => away; P.ghostTiles = sid => { const out = []; if (ghost) for (let i = 0; i < N; i++) if (ghost[i] === sid && (state[i] & 8192)) out.push(i); return out; }; P.traitors = () => traitors; P.donations = () => donations; P.statsAt = t => statsAt(t);
    // troop cap as OpenFront computes it (maxTroops): 2 * (tiles^0.6 * 1000 + 50000) + 250000 per city level (finished cities); bots a third
    P.troopCap = sid => { const p = bySid.get(sid), st = statsAt(P.tick).get(sid); if (!p || !st) return 0; let lv = 0; for (const u of units.values()) if (u.owner === sid && u.type === UT.CITY && !(u.flags & 1)) lv += u.level || 1;
      const m = 2 * (Math.pow(st[0], 0.6) * 1000 + 50000) + lv * 250000; return p.type === 'BOT' ? m / 3 : m; }; P.nukeLosses = (sid, t) => { let n = 0; for (const q of nukeHistory()) if (q.destroyed && q.end <= t) for (const b of q.destroyed) if (b.owner === sid) n += b.level || 1; return n; }; P.crown = t => crownAt(t ?? P.tick);
    P.structuresBy = () => { const c = new Map(); for (const u of units.values()) if (STRUCT[u.type] !== undefined) c.set(u.owner, (c.get(u.owner) || 0) + 1); return c; };
    P.statsAt = statsAt;
    P.debug = () => ({ cam: { ...cam }, units: units.size, unitFrame, terrFrame, vw, vh, railSegs: railSegs.length, railTiles: railMask ? railMask.reduce((a, b) => a + (b ? 1 : 0), 0) : 0 });
    // export (replay-export.js): draw one frame at tick t right now, with the whole map fitted
    P.renderFrame = t => { P.tick = t; seekTerritory(t); uploadTerritory(); seekRails(t); seekUnits(t); const st = statsAt(t); drawGL(); drawOverlay(t, st); return st; };
    let savedCam = null;
    P.setRenderSize = (w, h) => { // draw off-screen at w x h device pixels, whole map fitted
      if (!savedCam) savedCam = { ...cam };
      dpr = 1; vw = w; vh = h; for (const c of [glCv, ovCv]) { c.width = w; c.height = h; }
      fit(true);
    };
    P.restoreSize = () => { const s = savedCam; savedCam = null; resize(); if (s) Object.assign(cam, s); };
    P.mapRect = () => ({ x: cam.ox * dpr, y: cam.oy * dpr, w: W * cam.scale * dpr, h: H * cam.scale * dpr });
    P.canvases = () => [glCv, ovCv];
    // New data for the same map (Season 2: a rebuilt world), without a new WebGL context: territory, units, rails,
    // players and their colours / skins start over, the terrain texture stays. Returns false when it cannot.
    P.reload = nd => {
      if (!prog || !nd || !nd.header || nd.header.width !== W || nd.header.height !== H) return false;
      D = nd; const h = D.header;
      frameTicks = h.frameTicks; terrOff = indexStream(D.terr, 3, frameTicks.length);
      unitTicks = D.timeline.units.map(u => u[0]); moveOff = indexStream(D.moves, 3, unitTicks.length);
      statTicks = D.timeline.stats.map(x => x[0]); nameTicks = D.timeline.names.map(x => x[0]);
      terrKeys.clear(); terrFrame = -1; state.fill(0); ghost.fill(0); ovr = null; ovrDirty = false; fullDirty = true;
      unitKeys.clear(); units = new Map(); unitFrame = -1;
      pUnits = 0; pEvents = 0; pStats = 0; pMap.clear(); pHad.clear(); pGone.clear();
      effects = []; feed = []; marks = []; kills = []; allies = []; allyOpen.clear(); deathAt.clear(); away.length = 0; traitors.length = 0; donations.length = 0;
      railSegs = []; railEvTicks = []; railIdx = -2; railDone = 0; railLive.clear(); railMask.fill(0);
      setupPlayers();
      const maxSid = Math.max(1, ...players.map(p => p.sid)) + 1;
      palette.fill(0); meta.fill(0);
      if (maxSid + 64 > patH) { patH = maxSid + 64; patRows = new Uint8Array(1024 * patH); gl.deleteTexture(patTex); patTex = tex(gl, 5, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, 1024, patH, patRows); } else patRows.fill(0);
      for (const p of players) {
        const c = pal.get(p.sid);
        palette.set([...c.fill, 255], p.sid * 4); palette.set([...c.border, 255], (4096 + p.sid) * 4);
        if (p.pattern && p.pattern.d) try {
          const b = b64url(p.pattern.d); if (b[0] !== 0) throw 0;
          const scale = b[1] & 7, pw = (((b[2] & 3) << 5) | ((b[1] >> 3) & 31)) + 2, ph = ((b[2] >> 2) & 63) + 2;
          meta.set([255, pw, ph, scale], p.sid * 4); patRows.set(b.subarray(3, 3 + Math.min(1024, b.length - 3)), p.sid * 1024);
        } catch (e) { }
      }
      palette.copyWithin(4096 * 2 * 4, 0, 4096 * 2 * 4); meta.copyWithin(4096 * 4, 0, 4096 * 4); palOrig = palette.slice(); metaOrig = meta.slice(); ovFirst = maxSid;
      gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, palTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 4, gl.RGBA, gl.UNSIGNED_BYTE, palette);
      gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, metaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 4096, 2, gl.RGBA, gl.UNSIGNED_BYTE, meta);
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, patTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, patH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, patRows);
      setupRails(); prescan(); seekTerritory(h.ticks); seekUnits(h.ticks);
      return true;
    };
    P.snapshot = () => { drawGL(); const c = document.createElement('canvas'); c.width = glCv.width; c.height = glCv.height; const x = c.getContext('2d'); x.drawImage(glCv, 0, 0); x.drawImage(ovCv, 0, 0); return c; };
    P.destroy = () => { cancelAnimationFrame(raf); abort.abort(); ro.disconnect(); };
    // P.sleep(true) stops drawing (e.g. the map is scrolled out of view); P.sleep(false) goes on without a time jump
    let asleep = false;
    P.sleep = on => { asleep = !!on; if (asleep) { cancelAnimationFrame(raf); raf = 0; } else if (!raf && D) { last = null; raf = requestAnimationFrame(frame); } };

    const ro = new ResizeObserver(resize); ro.observe(root);
    const abort = new AbortController();
    (async () => {
      try {
        // opts.data: an already built replay (e.g. the simulated Clan Map in map-lab.js)
        let liveOff = 0, liveRest = new Uint8Array(0), pending = [], firstUsed = false, cacheReader = null;
        const join = (a, b) => { const all = new Uint8Array(a.length + b.length); all.set(a); all.set(b, a.length); return all; };
        // header + first data piece in `pending` -> D, played while the rest arrives (live or finished replay)
        const startPieces = () => {
          const head = pending.find(x => x.k === 'h');
          if (!head || !pending.some(x => x.k === 'c')) return false;
          D = { header: head.header, terrain: head.a, terr: new Uint8Array(0), moves: new Uint8Array(0), timeline: { unitEvery: 2, units: [], rails: [], names: [], stats: [], events: [] }, live: { terr: { buf: new Uint8Array(1 << 20), len: 0 }, moves: { buf: new Uint8Array(1 << 20), len: 0 } } };
          pending = pending.filter(x => x.k === 'c'); for (const c of pending) appendPiece(c); pending = [];
          P.streaming = !D.header.liveDone; return true;
        };
        // a finished replay: in pieces when the server has them (X-Format: pieces), playback starts after the
        // first one and the rest is read below; otherwise the whole file
        const loadFinished = async () => {
          const r = await fetch('/api/replay-player/' + encodeURIComponent(gameId) + '?pieces=1', { cache: 'no-store', signal: abort.signal });
          if (r.status !== 200) { D = parse(await fetchData(gameId, onStatus, abort.signal)); return; }
          const total = Number(r.headers.get('Content-Length')) || 0, reader = r.body.getReader(), pieced = r.headers.get('X-Format') === 'pieces', chunks = []; let got = 0;
          for (;;) {
            const { done, value } = await reader.read(); if (done) break;
            got += value.length; onStatus({ step: 'download', pct: total ? got / total : 0, bytes: got });
            if (!pieced) { chunks.push(value); continue; }
            liveRest = await livePieces(join(liveRest, value), pending);
            if (startPieces()) { D.header.cached = true; cacheReader = reader; return; }
          }
          if (pieced) throw new Error('replay file ended early');
          onStatus({ step: 'unpack' });
          D = parse(await new Response(new Blob(chunks).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
        };
        if (opts.data) D = opts.data;
        else {
          // a match nobody opened yet is computed on the server first; while that runs, its pieces are
          // played as they come (live), otherwise (cached, or not started) the whole file is loaded
          for (let tries = 0; !D && tries < 2000; tries++) {
            const first = await fetch('/api/replay-player/' + encodeURIComponent(gameId) + '?live=0', { cache: 'no-store', signal: abort.signal });
            const st = first.headers.get('X-Live-State');
            if (st === 'final' || !st) { await loadFinished(); break; }
            if (st === 'failed' || first.status >= 500) throw new Error('replay could not be computed');
            if (st !== 'running' && st !== 'done') { onStatus({ step: 'compute', state: st, position: Number(first.headers.get('X-Live-Position')) || 0 }); await new Promise(r => setTimeout(r, 1500)); continue; }
            // live: wait for the header and the first piece
            for (;;) {
              const res = firstUsed ? await fetch('/api/replay-player/' + encodeURIComponent(gameId) + '?live=' + liveOff, { cache: 'no-store', signal: abort.signal }) : first; firstUsed = true;
              const bytes = new Uint8Array(await res.arrayBuffer()); liveOff += bytes.length;
              liveRest = await livePieces(join(liveRest, bytes), pending);
              if (startPieces()) break;
              onStatus({ step: 'compute', state: 'running', live: true });
              await new Promise(r => setTimeout(r, 1200));
            }
          }
        }
        onStatus({ step: 'prepare' });
        await new Promise(r => setTimeout(r, 20));
        const h = D.header; W = h.width; H = h.height; N = W * H;
        frameTicks = h.frameTicks; terrOff = indexStream(D.terr, 3, frameTicks.length);
        unitTicks = D.timeline.units.map(u => u[0]); moveOff = indexStream(D.moves, 3, unitTicks.length);
        statTicks = D.timeline.stats.map(s => s[0]); nameTicks = D.timeline.names.map(s => s[0]);
        setupPlayers(); setupGL(); setupRails(); prescan();
        // one pass to the end builds the keyframes, so any later jump is instant
        seekTerritory(h.ticks); seekUnits(h.ticks);
        P.tick = h.spawnEnd || 0;
        resize(); fit(true);
        onStatus({ step: 'ready' });
        (opts.onReady || (() => {}))(P);
        if (!asleep) raf = requestAnimationFrame(frame);
        // finished replay in pieces: the rest as it downloads (tables brought up to date at most every 300 ms,
        // or at once when playback is waiting for it)
        if (cacheReader) {
          let got = [], lastGrow = 0;
          const flush = () => { for (const c of got) appendPiece(c); got = []; grown(); lastGrow = performance.now(); };
          for (;;) {
            const { done, value } = await cacheReader.read(); if (done) break;
            liveRest = await livePieces(join(liveRest, value), got);
            if (got.length && (P.waiting || performance.now() - lastGrow > 300)) flush();
          }
          if (got.length) flush();
          if (P.streaming) { P.streaming = false; P.liveError = true; emit('live', liveInfo()); }
        }
        // live: keep fetching pieces until the end piece arrives
        while (P.streaming) {
          await new Promise(r => setTimeout(r, 1500));
          const res = await fetch('/api/replay-player/' + encodeURIComponent(gameId) + '?live=' + liveOff, { cache: 'no-store', signal: abort.signal });
          const st = res.headers.get('X-Live-State');
          if (st === 'final' || st === 'failed' || !st) { P.streaming = false; P.liveError = st !== 'final'; emit('live', liveInfo()); break; } // live file gone: what is loaded stays
          const bytes = new Uint8Array(await res.arrayBuffer()); liveOff += bytes.length;
          const got = []; liveRest = await livePieces(join(liveRest, bytes), got);
          for (const c of got) if (c.k === 'c') { appendPiece(c); grown(); }
        }
      } catch (e) { if (e.name !== 'AbortError') onStatus({ step: 'error', error: e.message }); }
    })();
    return P;
  }
  // terrainRGBA, UT, UNIT_COL and NUKE_R are also used by pages that draw OpenFront units themselves (Nuke the Fleet)
  window.ReplayPlayer = { mount, fmtT, compact, esc, terrainRGBA, hsvDarken, UT, UNIT_COL, NUKE_R };
})();
