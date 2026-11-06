// Map Creator (/map-creator.html): paint an OpenFront map and export it in the game's format.
// Cell values: 0 = water, 1..31 = land with height 0..30, 255 = impassable (void).
(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const T = (s, v) => (window.tp ? tp(s, v) : s); // i18n phrase (canvas, CSS tips, mixed strings)
  const WATER = 0, VOID = 255, MAX_SIDE = 4096;
  const CATEGORIES = ["fictional", "featured", "new", "world", "continental", "europe", "asia", "north_america", "africa", "south_america", "oceania", "antarctica", "countries", "cosmic", "arcade", "tournament"];
  const TEMPLATES = [["achiran","Achiran"],["aegean","Aegean"],["africa","Africa"],["alps","Alps"],["amazonriver","Amazon River"],["antarctica","Antarctica"],["archipelagosea","Archipelago Sea"],["arctic","Arctic"],["asia","Asia"],["australia","Australia"],["baikal","Baikal"],["baikalnukewars","Baikal (Nuke Wars)"],["bajacalifornia","Baja California"],["balkans","Balkans"],["balkhash","Balkhash"],["baltics","Baltics"],["beringsea","Bering Sea"],["beringstrait","Bering Strait"],["betweentwoseas","Between Two Seas"],["blacksea","Black Sea"],["bosphorusstraits","Bosphorus Straits"],["branchingpaths","Branching Paths"],["britannia","Britannia"],["britanniaclassic","Britannia (Classic)"],["capecod","Cape Cod"],["caribbean","Caribbean"],["caspiansea","Caspian Sea"],["caucasus","Caucasus"],["centralamerica","Central America"],["channelislands","Channel Islands"],["china","China"],["choppingblock","Chopping Block"],["clearwaterlakes","Clearwater Lakes"],["conakry","Conakry"],["crimea","Crimea"],["danishstraits","Danish Straits"],["deglaciatedantarctica","Deglaciated Antarctica"],["didier","Didier"],["didierfrance","Didier (France)"],["dyslexdria","Dyslexdria"],["eastasia","East Asia"],["europe","Europe"],["europeclassic","Europe (Classic)"],["falklandislands","Falkland Islands"],["faroeislands","Faroe Islands"],["fingerlakes","Finger Lakes"],["fourislands","Four Islands"],["france","France"],["gatewaytotheatlantic","Gateway to the Atlantic"],["germany","Germany"],["giantworldmap","Giant World Map"],["greatlakes","Great Lakes"],["gulfofguinea","Gulf of Guinea"],["gulfofmexico","Gulf of Mexico"],["gulfofstlawrence","Gulf of St. Lawrence"],["halkidiki","Halkidiki"],["hawaii","Hawaii"],["hecatestrait","Hecate Strait"],["hongkong","Hong Kong"],["iceland","Iceland"],["indiansubcontinent","Indian Subcontinent"],["irishsea","Irish Sea"],["italia","Italia"],["japan","Japan"],["juandefucastrait","Juan de Fuca Strait"],["korea","Korea"],["labyrinth","Labyrinth"],["lasvegasstrip","Las Vegas Strip"],["lemnos","Lemnos"],["levant","Levant"],["lisbon","Lisbon"],["losangeles","Los Angeles"],["luna","Luna"],["manicouagan","Manicouagan"],["marenostrum","Mare Nostrum"],["mars","Mars"],["mena","MENA"],["middleeast","Middle East"],["milkyway","Milky Way"],["mississippiriver","Mississippi River"],["montreal","Montreal"],["morethanluck","More Than Luck"],["newyorkcity","New York City"],["niledelta","Nile Delta"],["northamerica","North America"],["northwestpassage","Northwest Passage"],["oceania","Oceania"],["onion","Onion"],["pangaea","Pangaea"],["passage","Passage"],["pluto","Pluto"],["qingchina","Qing China"],["russia","Russia"],["sanfrancisco","San Francisco"],["scandinavia","Scandinavia"],["sierpinski","Sierpinski"],["sol","Sol"],["southamerica","South America"],["southeastasia","Southeast Asia"],["straitofgibraltar","Strait of Gibraltar"],["straitofhormuz","Strait of Hormuz"],["straitofmalacca","Strait of Malacca"],["surrounded","Surrounded"],["svalmel","Svalmel"],["taiwanstrait","Taiwan Strait"],["thebox","The Box"],["tierradelfuego","Tierra del Fuego"],["titan","Titan"],["tourney1","Tourney 1"],["tourney2","Tourney 2"],["tourney3","Tourney 3"],["tourney4","Tourney 4"],["tradersdream","Traders Dream"],["twolakes","Two Lakes"],["unitedstates","United States"],["venice","Venice"],["vietnam","Vietnam"],["warshipwarship","Warship Warship"],["world","World"],["worldinverted","World Inverted"],["yangtzeriver","Yangtze River"],["yellowsea","Yellow Sea"],["yenisei","Yenisei"]];
  const GH = "https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/";
  const RAW = GH + "map-generator/assets/maps/";
  const flagUrl = code => GH + "resources/flags/" + encodeURIComponent(code) + ".svg";

  // ---------- state ----------
  let W = 0, H = 0, cells = null, depth = null;
  let nations = []; // {name, flag, x, y, extra}
  let selNation = -1;
  const view = { zoom: 1, ox: 0, oy: 0 };
  let tool = "brush", terr = "plains";
  const brush = { size: 40, rough: 0.35, strength: 0.5, elev: 4, river: 4 };
  let gameView = false, gameCanvas = null, lastGen = null, genStale = true;
  let trace = null, traceOn = false, traceOpacity = 0.5;
  let flagCodes = new Map(); // lower-case name/code -> code

  // ---------- canvases ----------
  const stage = $("stage"), cv = $("view"), ctx = cv.getContext("2d");
  const mini = $("mini"), mctx = mini.getContext("2d");
  const mapCanvas = document.createElement("canvas");
  let mapCtx = null, mapImg = null, pix32 = null;
  let dpr = 1, cssW = 0, cssH = 0;

  // ---------- colours ----------
  function abgr(r, g, b) { return (255 << 24 | b << 16 | g << 8 | r) >>> 0; }
  const rgbCss = c => "rgb(" + c[0] + "," + c[1] + "," + c[2] + ")";
  const landRGB = [];
  for (let m = 0; m <= 30; m++) landRGB.push(OFMapGen.thumbnailColor(OFMapGen.LAND, m, 0).slice(0, 3));
  const SHALLOW = [104, 160, 222], DEEP = [30, 70, 128], SHORE_W = [124, 178, 236], COAST = [214, 206, 160];
  const VOID_A = [9, 11, 16], VOID_B = [20, 24, 34];
  const WATER_UI = [58, 118, 176];
  function valueRGB(v) { return v === WATER ? WATER_UI : v === VOID ? [0, 0, 0] : landRGB[Math.min(30, v - 1)]; }
  // OpenFront "play-layer" colours (map-making colour guide): the blue channel carries the height,
  // red/green only make the image readable. Water 00006a, void 000000.
  function playLayerRGB(v) {
    if (v === WATER) return [0, 0, 106];
    if (v === VOID) return [0, 0, 0];
    const m = v - 1;
    if (m < 10) return [190, 220 - 2 * m, 140 + 2 * m];
    if (m < 20) { const k = 2 * (m - 10); return [220 + k, 203 + k, 160 + k]; }
    const k = Math.round((m - 20) / 2); return [240 + k, 240 + k, 180 + 2 * (m - 20)];
  }
  const waterLut = new Uint32Array(64);
  for (let d = 0; d < 64; d++) {
    if (d === 0) { waterLut[d] = abgr(SHORE_W[0], SHORE_W[1], SHORE_W[2]); continue; }
    const t = Math.pow(Math.min(d, 48) / 48, 0.7);
    waterLut[d] = abgr(Math.round(SHALLOW[0] + (DEEP[0] - SHALLOW[0]) * t), Math.round(SHALLOW[1] + (DEEP[1] - SHALLOW[1]) * t), Math.round(SHALLOW[2] + (DEEP[2] - SHALLOW[2]) * t));
  }
  const isLand = v => v >= 1 && v <= 31;
  const hAt = v => isLand(v) ? v - 1 : 0;

  function terrainValue() {
    switch (terr) {
      case "water": return WATER;
      case "impassable": return VOID;
      case "plains": return 1 + 4;
      case "highland": return 1 + 14;
      case "mountain": return 1 + 25;
      default: return 1 + brush.elev;
    }
  }
  function describe(v) {
    if (v === WATER) return "Water";
    if (v === VOID) return "Void";
    const m = v - 1;
    return (m < 10 ? "Plains" : m < 20 ? "Highland" : "Mountain") + " · " + m;
  }

  // ---------- map setup & rendering ----------
  function snap4(n) { n = Math.max(200, Math.min(MAX_SIDE, Math.round(+n || 0))); return n - (n % 4); }
  function setMap(w, h, data) {
    W = w; H = h; cells = data || new Uint8Array(w * h);
    depth = new Uint8Array(W * H);
    mapCanvas.width = W; mapCanvas.height = H;
    mapCtx = mapCanvas.getContext("2d");
    mapImg = mapCtx.createImageData(W, H);
    pix32 = new Uint32Array(mapImg.data.buffer);
    before = null;
    computeDepth(); refreshAll();
    $("sSize").textContent = W + " × " + H;
    $("newW").value = W; $("newH").value = H;
    markChanged();
  }
  // Distance (in tiles, capped) from every water tile to the nearest land, for the depth shading.
  function computeDepth() {
    const n = W * H, q = new Int32Array(n);
    let head = 0, tail = 0;
    depth.fill(255);
    for (let i = 0; i < n; i++) if (isLand(cells[i])) { depth[i] = 0; q[tail++] = i; }
    while (head < tail) {
      const i = q[head++], d = depth[i] + 1;
      if (d > 62) continue;
      const x = i % W;
      if (x > 0 && depth[i - 1] === 255 && cells[i - 1] === WATER) { depth[i - 1] = d; q[tail++] = i - 1; }
      if (x < W - 1 && depth[i + 1] === 255 && cells[i + 1] === WATER) { depth[i + 1] = d; q[tail++] = i + 1; }
      if (i >= W && depth[i - W] === 255 && cells[i - W] === WATER) { depth[i - W] = d; q[tail++] = i - W; }
      if (i < n - W && depth[i + W] === 255 && cells[i + W] === WATER) { depth[i + W] = d; q[tail++] = i + W; }
    }
  }
  function shadePixel(x, y) {
    const i = y * W + x, v = cells[i];
    if (v === WATER) { const d = depth[i]; return waterLut[d === 255 ? 63 : Math.min(63, Math.max(0, d - 1))]; }
    if (v === VOID) { const c = ((x + y) & 7) === 0 ? VOID_B : VOID_A; return abgr(c[0], c[1], c[2]); }
    const m = v - 1, base = landRGB[Math.min(30, m)];
    const l = x > 0 ? cells[i - 1] : v, r = x < W - 1 ? cells[i + 1] : v, u = y > 0 ? cells[i - W] : v, dn = y < H - 1 ? cells[i + W] : v;
    const ul = x > 0 && y > 0 ? cells[i - W - 1] : v, dr = x < W - 1 && y < H - 1 ? cells[i + W + 1] : v;
    const f = 1 + Math.max(-0.22, Math.min(0.22, (hAt(ul) - hAt(dr) + (hAt(l) - hAt(r)) * 0.5 + (hAt(u) - hAt(dn)) * 0.5) * 0.03));
    let R = base[0] * f, G = base[1] * f, B = base[2] * f;
    if (l === WATER || r === WATER || u === WATER || dn === WATER) { R = R * 0.35 + COAST[0] * 0.65; G = G * 0.35 + COAST[1] * 0.65; B = B * 0.35 + COAST[2] * 0.65; }
    return abgr(Math.min(255, R) | 0, Math.min(255, G) | 0, Math.min(255, B) | 0);
  }
  function refreshRect(x0, y0, x1, y1) {
    x0 = Math.max(0, (x0 | 0) - 1); y0 = Math.max(0, (y0 | 0) - 1); x1 = Math.min(W - 1, (x1 | 0) + 1); y1 = Math.min(H - 1, (y1 | 0) + 1);
    if (x1 < x0 || y1 < y0) return;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) pix32[y * W + x] = shadePixel(x, y);
    mapCtx.putImageData(mapImg, 0, 0, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    miniDirty = true; requestDraw();
  }
  function refreshAll() {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) pix32[y * W + x] = shadePixel(x, y);
    mapCtx.putImageData(mapImg, 0, 0); miniDirty = true; requestDraw();
  }
  let depthTimer = 0;
  function scheduleShade() { clearTimeout(depthTimer); depthTimer = setTimeout(() => { computeDepth(); refreshAll(); }, 220); }

  // ---------- view ----------
  let needFit = false;
  function resize() {
    const r = stage.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1; cssW = r.width; cssH = r.height;
    const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    if (needFit && cssW >= 50 && cssH >= 50 && W) fit();
    requestDraw();
  }
  function fit() {
    needFit = false;
    resize();
    if (cssW < 50 || cssH < 50) { needFit = true; return; }
    const top = 64, bottom = 56;
    const z = Math.min((cssW - 48) / W, (cssH - top - bottom) / H);
    view.zoom = Math.max(0.02, z);
    view.ox = (cssW - W * view.zoom) / 2; view.oy = top + (cssH - top - bottom - H * view.zoom) / 2;
    requestDraw();
  }
  function zoomAt(f, sx, sy) {
    const nz = Math.max(0.02, Math.min(40, view.zoom * f));
    const mx = (sx - view.ox) / view.zoom, my = (sy - view.oy) / view.zoom;
    view.zoom = nz; view.ox = sx - mx * nz; view.oy = sy - my * nz;
    requestDraw();
  }
  const toMap = (sx, sy) => [(sx - view.ox) / view.zoom, (sy - view.oy) / view.zoom];

  let drawQueued = false, cursor = null;
  function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }
  function draw() {
    drawQueued = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!cells) return;
    $("sZoom").textContent = (view.zoom * 100 >= 10 ? Math.round(view.zoom * 100) : (view.zoom * 100).toFixed(1)) + "%";
    const mw = W * view.zoom, mh = H * view.zoom;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,.65)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 10; ctx.fillStyle = "#000";
    ctx.fillRect(view.ox, view.oy, mw, mh);
    ctx.restore();
    ctx.imageSmoothingEnabled = view.zoom < 1;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(gameView && gameCanvas ? gameCanvas : mapCanvas, view.ox, view.oy, mw, mh);
    if (trace && traceOn) { ctx.globalAlpha = traceOpacity; ctx.imageSmoothingEnabled = true; ctx.drawImage(trace, view.ox, view.oy, mw, mh); ctx.globalAlpha = 1; }
    ctx.strokeStyle = "rgba(140,190,255,.35)"; ctx.lineWidth = 1;
    ctx.strokeRect(view.ox - .5, view.oy - .5, mw + 1, mh + 1);
    if (view.zoom >= 8) drawPixelGrid();
    drawNations();
    drawCursor();
    drawMini();
  }
  function drawPixelGrid() {
    const z = view.zoom, x0 = Math.max(0, Math.floor(-view.ox / z)), y0 = Math.max(0, Math.floor(-view.oy / z));
    const x1 = Math.min(W, Math.ceil((cssW - view.ox) / z)), y1 = Math.min(H, Math.ceil((cssH - view.oy) / z));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { const sx = Math.round(view.ox + x * z) + .5; ctx.moveTo(sx, view.oy + y0 * z); ctx.lineTo(sx, view.oy + y1 * z); }
    for (let y = y0; y <= y1; y++) { const sy = Math.round(view.oy + y * z) + .5; ctx.moveTo(view.ox + x0 * z, sy); ctx.lineTo(view.ox + x1 * z, sy); }
    ctx.strokeStyle = "rgba(0,0,0,.16)"; ctx.stroke();
  }
  function drawNations() {
    ctx.font = "700 12px Inter, Segoe UI, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    const showLabels = view.zoom >= 0.6 || nations.length <= 30;
    nations.forEach((n, i) => {
      const sx = view.ox + (n.x + .5) * view.zoom, sy = view.oy + (n.y + .5) * view.zoom;
      if (sx < -60 || sy < -60 || sx > cssW + 60 || sy > cssH + 60) return;
      const bad = !isLand(cells[n.y * W + n.x]), sel = i === selNation;
      ctx.beginPath(); ctx.arc(sx, sy, sel ? 7.5 : 6, 0, Math.PI * 2);
      ctx.fillStyle = bad ? "#ff5d6c" : sel ? "#f2c400" : "#ffffff"; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = "#0b1220"; ctx.stroke();
      if (!showLabels && !sel) return;
      const label = n.name || T("Nation {n}", { n: i + 1 }), tw = ctx.measureText(label).width;
      const bx = sx - tw / 2 - 6, by = sy - 29;
      ctx.fillStyle = bad ? "rgba(70,14,22,.88)" : sel ? "rgba(60,48,6,.92)" : "rgba(8,12,20,.82)";
      roundRect(bx, by, tw + 12, 18, 6); ctx.fill();
      ctx.fillStyle = bad ? "#ffc2c8" : sel ? "#ffe680" : "#fff"; ctx.fillText(label, sx, by + 13);
    });
  }
  function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function drawCursor() {
    if (!cursor || tool === "pan" || panning || spaceDown) return;
    const [mx, my] = toMap(cursor.x, cursor.y);
    if (tool === "nation" || tool === "pick" || tool === "fill") {
      ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = 3.5; crosshair();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; crosshair();
      if (tool === "fill") { const c = valueRGB(terrainValue()); ctx.fillStyle = rgbCss(c); ctx.strokeStyle = "#0b1220"; ctx.lineWidth = 1.5; ctx.fillRect(cursor.x + 8, cursor.y + 8, 12, 12); ctx.strokeRect(cursor.x + 8, cursor.y + 8, 12, 12); }
      return;
    }
    const r = Math.max(0.5, (tool === "river" ? brush.river : brush.size) / 2) * view.zoom;
    const cx = view.ox + (Math.floor(mx) + .5) * view.zoom, cy = view.oy + (Math.floor(my) + .5) * view.zoom;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    if (tool === "brush" || tool === "erase" || tool === "river") {
      const c = valueRGB(tool === "brush" ? terrainValue() : WATER);
      ctx.fillStyle = "rgba(" + c[0] + "," + c[1] + "," + c[2] + ",.28)"; ctx.fill();
    }
    ctx.lineWidth = 3; ctx.strokeStyle = "rgba(0,0,0,.55)"; ctx.stroke();
    ctx.lineWidth = 1.5; ctx.strokeStyle = tool === "raise" ? "#ffe08a" : tool === "lower" ? "#b7f59a" : tool === "smooth" ? "#d9b3ff" : "#fff"; ctx.stroke();
    if (tool === "raise" || tool === "lower") { ctx.fillStyle = ctx.strokeStyle; ctx.font = "800 14px Inter,sans-serif"; ctx.textAlign = "center"; ctx.fillText(tool === "raise" ? "+" : "−", cx, cy + 5); }
    if (lastPoint && shiftDown && (tool === "brush" || tool === "erase" || tool === "river")) {
      ctx.setLineDash([5, 5]); ctx.beginPath();
      ctx.moveTo(view.ox + lastPoint[0] * view.zoom, view.oy + lastPoint[1] * view.zoom); ctx.lineTo(cx, cy);
      ctx.strokeStyle = "rgba(255,255,255,.8)"; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
  }
  function crosshair() { const x = cursor.x, y = cursor.y; ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 10); ctx.stroke(); }

  // ---------- minimap ----------
  let miniDirty = true, miniCache = null;
  function miniLayout() { const s = Math.min(170 / W, 110 / H); return { s, w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)) }; }
  function drawMini() {
    if (!W) return;
    const L = miniLayout();
    if (mini.width !== L.w || mini.height !== L.h) { mini.width = L.w; mini.height = L.h; miniDirty = true; }
    if (miniDirty) { mctx.imageSmoothingEnabled = true; mctx.imageSmoothingQuality = "high"; mctx.drawImage(gameView && gameCanvas ? gameCanvas : mapCanvas, 0, 0, L.w, L.h); miniCache = mctx.getImageData(0, 0, L.w, L.h); miniDirty = false; }
    else if (miniCache) mctx.putImageData(miniCache, 0, 0);
    const [x0, y0] = toMap(0, 0), [x1, y1] = toMap(cssW, cssH);
    mctx.fillStyle = "rgba(87,230,255,.08)"; mctx.fillRect(x0 * L.s, y0 * L.s, (x1 - x0) * L.s, (y1 - y0) * L.s);
    mctx.strokeStyle = "#57e6ff"; mctx.lineWidth = 1.5; mctx.strokeRect(x0 * L.s, y0 * L.s, (x1 - x0) * L.s, (y1 - y0) * L.s);
  }
  function miniNav(e) {
    const r = mini.getBoundingClientRect(), L = miniLayout();
    const mx = (e.clientX - r.left) / L.s, my = (e.clientY - r.top) / L.s;
    view.ox = cssW / 2 - mx * view.zoom; view.oy = cssH / 2 - my * view.zoom; requestDraw();
  }
  mini.addEventListener("pointerdown", e => { mini.setPointerCapture(e.pointerId); miniNav(e); mini.onpointermove = miniNav; });
  mini.addEventListener("pointerup", () => { mini.onpointermove = null; });

  // ---------- noise (value noise, seeded) ----------
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

  // ---------- undo ----------
  let before = null, beforeNations = null, dirty = null;
  const undoStack = [], redoStack = [];
  let undoBytes = 0;
  const UNDO_LIMIT = 220e6;
  function beginEdit() {
    if (!before || before.length !== cells.length) before = new Uint8Array(cells.length);
    before.set(cells);
    beforeNations = JSON.stringify(nations);
    dirty = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  }
  function touch(x0, y0, x1, y1) {
    if (x0 < dirty.x0) dirty.x0 = x0; if (y0 < dirty.y0) dirty.y0 = y0;
    if (x1 > dirty.x1) dirty.x1 = x1; if (y1 > dirty.y1) dirty.y1 = y1;
  }
  function crop(src, x0, y0, w, h) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) out.set(src.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + w), y * w);
    return out;
  }
  function endEdit(label) {
    const nAfter = JSON.stringify(nations);
    let entry = null;
    if (dirty && dirty.x1 >= dirty.x0) {
      const x0 = Math.max(0, dirty.x0), y0 = Math.max(0, dirty.y0), x1 = Math.min(W - 1, dirty.x1), y1 = Math.min(H - 1, dirty.y1);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      entry = { kind: "rect", x0, y0, w, h, before: crop(before, x0, y0, w, h), after: crop(cells, x0, y0, w, h) };
      scheduleShade();
    } else if (nAfter !== beforeNations) entry = { kind: "nations" };
    dirty = null;
    if (!entry) return;
    entry.nb = beforeNations; entry.na = nAfter; entry.label = label;
    pushUndo(entry);
    markChanged();
  }
  function snapshot() { return { W, H, cells: cells.slice(), nations: JSON.stringify(nations) }; }
  function pushFull(beforeSnap, label) { pushUndo({ kind: "full", b: beforeSnap, a: snapshot(), label }); markChanged(); }
  function entrySize(e) { return e.kind === "rect" ? e.before.length * 2 : e.kind === "full" ? e.b.cells.length + e.a.cells.length : 100; }
  function pushUndo(e) {
    undoStack.push(e); undoBytes += entrySize(e);
    redoStack.length = 0;
    while (undoBytes > UNDO_LIMIT && undoStack.length > 1) undoBytes -= entrySize(undoStack.shift());
    updateUndoButtons();
  }
  function applyEntry(e, dir) {
    if (e.kind === "rect") {
      const src = dir < 0 ? e.before : e.after;
      for (let y = 0; y < e.h; y++) cells.set(src.subarray(y * e.w, (y + 1) * e.w), (e.y0 + y) * W + e.x0);
      refreshRect(e.x0, e.y0, e.x0 + e.w - 1, e.y0 + e.h - 1); scheduleShade();
    } else if (e.kind === "full") {
      const s = dir < 0 ? e.b : e.a;
      if (s.W !== W || s.H !== H) { setMap(s.W, s.H, s.cells.slice()); fit(); } else { cells.set(s.cells); computeDepth(); refreshAll(); }
    }
    nations = JSON.parse(dir < 0 ? (e.kind === "full" ? e.b.nations : e.nb) : (e.kind === "full" ? e.a.nations : e.na));
    selNation = -1; leaveGameView(true); renderNations(); markChanged();
  }
  function undo() { const e = undoStack.pop(); if (!e) return; undoBytes -= entrySize(e); applyEntry(e, -1); redoStack.push(e); updateUndoButtons(); toast("Undo: " + e.label); }
  function redo() { const e = redoStack.pop(); if (!e) return; applyEntry(e, 1); undoStack.push(e); undoBytes += entrySize(e); updateUndoButtons(); toast("Redo: " + e.label); }
  function updateUndoButtons() { $("undoBtn").disabled = !undoStack.length; $("redoBtn").disabled = !redoStack.length; }

  // ---------- painting ----------
  function stamp(cx, cy) {
    const isRiver = tool === "river";
    const r = Math.max(0.5, (isRiver ? brush.river : brush.size) / 2), R = Math.ceil(r * (1 + (isRiver ? 0 : brush.rough) * 0.6)) + 1;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
    if (x1 < x0 || y1 < y0) return;
    const freq = 1 / Math.max(3, r * 0.45), rough = brush.size >= 4 && !isRiver ? brush.rough : 0;
    const val = tool === "erase" || isRiver ? WATER : terrainValue();
    const st = brush.strength;
    let src = null;
    const sx0 = Math.max(0, x0 - 1), sy0 = Math.max(0, y0 - 1), sw = Math.min(W - 1, x1 + 1) - sx0 + 1;
    if (tool === "smooth") src = crop(cells, sx0, sy0, sw, Math.min(H - 1, y1 + 1) - sy0 + 1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const dx = x + .5 - cx, dy = y + .5 - cy, d = Math.sqrt(dx * dx + dy * dy);
      let edge = r;
      if (rough) edge = r * (1 + rough * 0.6 * (fbm(x * freq, y * freq, 3, 7) * 2 - 1));
      if (d > edge) continue;
      const i = y * W + x, v = cells[i];
      if (tool === "brush" || tool === "erase") { cells[i] = val; continue; }
      if (isRiver) { if (v !== VOID) cells[i] = WATER; continue; }
      const fall = 1 - d / Math.max(edge, 0.5);
      if (tool === "raise" || tool === "lower") {
        if (!isLand(v)) continue;
        const delta = st * fall * 2.2 * (tool === "raise" ? 1 : -1);
        const m = v - 1 + Math.trunc(delta) + (Math.random() < Math.abs(delta % 1) ? Math.sign(delta) : 0);
        cells[i] = 1 + Math.max(0, Math.min(30, m));
      } else if (tool === "smooth") {
        if (v === VOID || Math.random() > st * (0.35 + fall * 0.65)) continue;
        let land = 0, sum = 0, n = 0, voids = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox, ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nv = src[(ny - sy0) * sw + (nx - sx0)]; n++;
          if (isLand(nv)) { land++; sum += nv - 1; } else if (nv === VOID) voids++;
        }
        if (land * 2 > n) {
          const avg = sum / land, cur = isLand(v) ? v - 1 : avg;
          cells[i] = 1 + Math.round(cur + (avg - cur) * 0.6);
        } else if (land * 2 < n - voids) cells[i] = WATER;
      }
    }
    touch(x0, y0, x1, y1);
    refreshRect(x0, y0, x1, y1);
  }
  function strokeTo(a, b) {
    const step = tool === "river" ? Math.max(0.5, brush.river * 0.3) : Math.max(1, brush.size * (tool === "brush" || tool === "erase" ? 0.2 : 0.3));
    const dx = b[0] - a[0], dy = b[1] - a[1], dist = Math.hypot(dx, dy), n = Math.max(1, Math.ceil(dist / step));
    for (let k = 1; k <= n; k++) stamp(a[0] + dx * k / n, a[1] + dy * k / n);
  }
  function floodFill(sx, sy) {
    const start = sy * W + sx, from = cells[start], val = terrainValue();
    const cls = v => v === WATER ? 0 : v === VOID ? 2 : 1, fc = cls(from);
    if (from === val || (fc !== 1 && cls(val) === fc)) return 0;
    const seen = new Uint8Array(W * H), q = new Int32Array(W * H);
    let head = 0, tail = 0, n = 0, x0 = sx, x1 = sx, y0 = sy, y1 = sy;
    q[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const i = q[head++], x = i % W, y = (i / W) | 0;
      cells[i] = val; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && !seen[i - 1] && cls(cells[i - 1]) === fc) { seen[i - 1] = 1; q[tail++] = i - 1; }
      if (x < W - 1 && !seen[i + 1] && cls(cells[i + 1]) === fc) { seen[i + 1] = 1; q[tail++] = i + 1; }
      if (y > 0 && !seen[i - W] && cls(cells[i - W]) === fc) { seen[i - W] = 1; q[tail++] = i - W; }
      if (y < H - 1 && !seen[i + W] && cls(cells[i + W]) === fc) { seen[i + W] = 1; q[tail++] = i + W; }
    }
    touch(x0, y0, x1, y1); refreshRect(x0, y0, x1, y1);
    return n;
  }

  // ---------- pointer ----------
  let drawing = false, panning = false, panStart = null, lastPoint = null, shiftDown = false, spaceDown = false, dragNation = -1;
  function localXY(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function nationAt(sx, sy) {
    for (let i = nations.length - 1; i >= 0; i--) {
      const n = nations[i], nx = view.ox + (n.x + .5) * view.zoom, ny = view.oy + (n.y + .5) * view.zoom;
      if (Math.hypot(nx - sx, ny - sy) < 11) return i;
    }
    return -1;
  }
  cv.addEventListener("contextmenu", e => e.preventDefault());
  cv.addEventListener("pointerdown", e => {
    if (!cells) return;
    cv.setPointerCapture(e.pointerId);
    const p = localXY(e); cursor = p;
    if (e.button === 1 || spaceDown || tool === "pan") { panning = true; panStart = { x: p.x, y: p.y, ox: view.ox, oy: view.oy }; stage.classList.add("panning"); return; }
    const [fx, fy] = toMap(p.x, p.y), mx = Math.floor(fx), my = Math.floor(fy);
    const inside = mx >= 0 && my >= 0 && mx < W && my < H;
    if (tool === "nation") {
      const hit = nationAt(p.x, p.y);
      if (e.button === 2) { if (hit >= 0) { beginEdit(); nations.splice(hit, 1); selNation = -1; endEdit("remove nation"); renderNations(); requestDraw(); } return; }
      if (hit >= 0) { beginEdit(); dragNation = hit; selNation = hit; renderNations(); requestDraw(); return; }
      if (!inside) return;
      beginEdit();
      nations.push({ name: "Nation " + (nations.length + 1), flag: "", x: mx, y: my });
      selNation = nations.length - 1; endEdit("add nation"); renderNations(); requestDraw();
      return;
    }
    if (e.button === 2 || tool === "pick" || e.altKey) { if (inside) pickAt(mx, my); return; }
    if (e.button !== 0 || (!inside && tool === "fill")) return;
    leaveGameView(true);
    if (tool === "fill") {
      beginEdit(); const n = floodFill(mx, my); endEdit("fill");
      if (n) toast("Filled " + fmt(n) + " tiles");
      return;
    }
    beginEdit(); drawing = true;
    const pt = [fx, fy];
    if (e.shiftKey && lastPoint && (tool === "brush" || tool === "erase" || tool === "river")) strokeTo(lastPoint, pt); else stamp(fx, fy);
    lastPoint = pt;
  });
  cv.addEventListener("pointermove", e => {
    const p = localXY(e); cursor = p;
    if (panning) { view.ox = panStart.ox + p.x - panStart.x; view.oy = panStart.oy + p.y - panStart.y; requestDraw(); return; }
    const [fx, fy] = toMap(p.x, p.y), mx = Math.floor(fx), my = Math.floor(fy);
    if (mx >= 0 && my >= 0 && mx < W && my < H) {
      const v = cells[my * W + mx];
      $("sx").textContent = mx; $("sy").textContent = my;
      $("sTerr").innerHTML = '<span class="sw" style="background:' + rgbCss(valueRGB(v)) + '"></span>' + describe(v);
    } else { $("sx").textContent = "–"; $("sy").textContent = "–"; }
    if (dragNation >= 0) {
      nations[dragNation].x = Math.max(0, Math.min(W - 1, mx)); nations[dragNation].y = Math.max(0, Math.min(H - 1, my));
      requestDraw(); return;
    }
    if (drawing) {
      let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (!evs.length) evs = [e];
      for (const ev of evs) {
        const q = localXY(ev); let pt = toMap(q.x, q.y);
        if (tool === "river") { const k = 0.28; pt = [lastPoint[0] + (pt[0] - lastPoint[0]) * k, lastPoint[1] + (pt[1] - lastPoint[1]) * k]; }
        strokeTo(lastPoint, pt); lastPoint = pt;
      }
    }
    requestDraw();
  });
  function pointerEnd() {
    if (panning) { panning = false; stage.classList.remove("panning"); }
    if (dragNation >= 0) { dragNation = -1; endEdit("move nation"); renderNations(); }
    if (drawing) { drawing = false; endEdit(toolName(tool).toLowerCase()); }
  }
  cv.addEventListener("pointerup", pointerEnd);
  cv.addEventListener("pointercancel", pointerEnd);
  cv.addEventListener("pointerleave", () => { cursor = null; requestDraw(); });
  cv.addEventListener("wheel", e => {
    e.preventDefault();
    const p = localXY(e);
    if (e.shiftKey && !e.ctrlKey) { view.ox -= e.deltaY; requestDraw(); }
    else zoomAt(Math.pow(1.0018, -e.deltaY), p.x, p.y);
  }, { passive: false });

  function pickAt(x, y) {
    const v = cells[y * W + x];
    if (v === WATER) setTerr("water"); else if (v === VOID) setTerr("impassable");
    else setElev(v - 1);
    if (tool === "pick" || tool === "erase") setTool("brush");
    toast("Picked " + describe(v));
  }

  // ---------- keyboard ----------
  const KEYS = { b: "brush", e: "erase", f: "fill", r: "raise", l: "lower", s: "smooth", v: "river", n: "nation", i: "pick", h: "pan" };
  window.addEventListener("keydown", e => {
    if (e.target.matches("input, select, textarea")) { if (e.key === "Escape") e.target.blur(); return; }
    if (e.key === "Escape") { closeModals(); return; }
    if (document.querySelector(".modal.on")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === " ") { spaceDown = true; stage.classList.add("tool-pan"); e.preventDefault(); requestDraw(); return; }
    if (e.key === "Shift") { shiftDown = true; requestDraw(); return; }
    if (KEYS[k]) { setTool(KEYS[k]); return; }
    if (k === "[" || k === "]") { if (tool === "river") setParam("river", brush.river + (k === "]" ? 1 : -1)); else setParam("size", brush.size + (k === "]" ? 1 : -1) * Math.max(1, Math.round(brush.size * 0.15))); return; }
    if (k === "1") setTerr("plains"); else if (k === "2") setTerr("highland"); else if (k === "3") setTerr("mountain");
    else if (k === "w") setTerr("water"); else if (k === "x") setTerr("impassable");
    else if (k === "0") fit(); else if (k === "+" || k === "=") zoomAt(1.25, cssW / 2, cssH / 2); else if (k === "-") zoomAt(0.8, cssW / 2, cssH / 2);
    else if (k === "g") toggleGameView(); else if (k === "t" && trace) { setTrace(!traceOn); toast(traceOn ? "Overlay shown" : "Overlay hidden"); }
    else if (e.key === "?") openModal("helpModal");
    else if ((k === "delete" || k === "backspace") && selNation >= 0) { beginEdit(); nations.splice(selNation, 1); selNation = -1; endEdit("remove nation"); renderNations(); requestDraw(); }
  });
  window.addEventListener("keyup", e => {
    if (e.key === " ") { spaceDown = false; stage.classList.toggle("tool-pan", tool === "pan"); requestDraw(); }
    if (e.key === "Shift") { shiftDown = false; requestDraw(); }
  });

  // ---------- tools, terrain, brush params ----------
  const TOOL_INFO = {
    brush: ["Brush", "M18.4 2.6a2 2 0 0 1 3 3L12 15l-4 1 1-4z"], erase: ["Eraser", "M5.5 14.5l8-8a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8L13 19H8.5z"],
    fill: ["Fill", "M19 11l-8-8-8.5 8.5a2.1 2.1 0 0 0 0 3L7 19a2.1 2.1 0 0 0 3 0z"], raise: ["Raise", "M3 20l6-9 4 5 3-4 5 8zM17 3v6M14 6l3-3 3 3"],
    lower: ["Lower", "M3 20l6-9 4 5 3-4 5 8zM17 3v6M14 6l3 3 3-3"], smooth: ["Smooth", "M2 12c2-3 4-3 6 0s4 3 6 0 4-3 6 0"],
    river: ["River", "M4 3c3 3-2 6 1 9s7 1 9 4-1 5 1 5"],
    nation: ["Nations", "M5 22V3M5 4h12l-2.5 4L17 12H5"], pick: ["Eyedropper", "M2 22l1-4 9.5-9.5 3 3L6 21z"], pan: ["Pan", "M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"],
  };
  const toolName = t => TOOL_INFO[t][0];
  const TERRS = [["plains", "Plains"], ["highland", "Highland"], ["mountain", "Mountain"], ["water", "Water"], ["impassable", "Void"]];
  function terrColor(t) { return rgbCss(t === "water" ? WATER_UI : t === "impassable" ? [0, 0, 0] : t === "plains" ? landRGB[4] : t === "highland" ? landRGB[14] : t === "mountain" ? landRGB[25] : landRGB[brush.elev]); }
  function slider(name, label, min, max, val, unit) {
    return '<div class="field"><span class="lbl">' + label + '</span><input type="range" data-bind="' + name + '" min="' + min + '" max="' + max + '" value="' + val + '" aria-label="' + label + '"><b data-out="' + name + '">' + val + unit + "</b></div>";
  }
  function renderOpts() {
    const [title, path] = TOOL_INFO[tool];
    let h = '<div class="ttl"><svg class="i" viewBox="0 0 24 24"><path d="' + path + '"/></svg>' + title + "</div>";
    const sep = '<div class="vsep"></div>';
    if (tool === "brush" || tool === "fill") {
      h += sep + '<div class="chips">' + TERRS.map(([k, n]) => '<button class="chip" data-terr="' + k + '" aria-pressed="' + (terr === k) + '"><i style="background:' + terrColor(k) + '"></i>' + n + "</button>").join("") +
        (terr === "land" ? '<button class="chip" aria-pressed="true"><i style="background:' + terrColor("land") + '"></i>Height ' + brush.elev + "</button>" : "") + "</div>";
    }
    if (tool === "brush" || tool === "erase") h += sep + slider("size", "Size", 1, 300, brush.size, "") + slider("rough", "Rough", 0, 100, Math.round(brush.rough * 100), "%");
    if (tool === "raise" || tool === "lower" || tool === "smooth") h += sep + slider("size", "Size", 1, 300, brush.size, "") + slider("strength", "Strength", 5, 100, Math.round(brush.strength * 100), "%");
    if (tool === "river") h += sep + slider("river", "Width", 1, 16, brush.river, "") + '<span class="hint">Draws a smooth water line · Shift+click for straight parts</span>';
    if (tool === "nation") h += sep + '<span class="hint">Click land to add · drag to move · right-click to remove</span><span class="lbl">' + nations.length + " placed</span>";
    if (tool === "pick") h += sep + '<span class="hint">Click the map to copy its terrain to the brush</span>';
    if (tool === "pan") h += sep + '<span class="hint">Drag to move · wheel to zoom</span>';
    if (tool === "fill") h += '<span class="hint">Fills the connected land, sea or void area</span>';
    if (tool === "erase") h += '<span class="hint">Paints water</span>';
    $("opts").innerHTML = h;
  }
  $("opts").addEventListener("input", e => { const b = e.target.dataset.bind; if (b) setParam(b, +e.target.value, true); });
  $("opts").addEventListener("click", e => { const c = e.target.closest("[data-terr]"); if (c) setTerr(c.dataset.terr); });
  function setParam(name, v, fromOpts) {
    if (name === "size") { brush.size = Math.max(1, Math.min(300, Math.round(v))); v = brush.size; $("size").value = v; $("sizeVal").textContent = v + " px"; }
    if (name === "rough") { brush.rough = v / 100; $("rough").value = v; $("roughVal").textContent = v + "%"; }
    if (name === "river") { brush.river = Math.max(1, Math.min(16, Math.round(v))); v = brush.river; }
    if (name === "strength") { brush.strength = v / 100; $("strength").value = v; $("strVal").textContent = v + "%"; }
    document.querySelectorAll('#opts [data-out="' + name + '"]').forEach(o => o.textContent = v + (name === "size" || name === "river" ? "" : "%"));
    if (!fromOpts) document.querySelectorAll('#opts [data-bind="' + name + '"]').forEach(o => o.value = v);
    requestDraw();
  }
  function setTool(t) {
    tool = t;
    document.querySelectorAll(".rail [data-tool]").forEach(b => b.setAttribute("aria-pressed", b.dataset.tool === t));
    stage.classList.toggle("tool-pan", t === "pan");
    if (t === "nation") showTab("nations");
    else if (["brush", "erase", "fill", "raise", "lower", "smooth", "river"].includes(t) && document.querySelector('.tab[data-tab="nations"][aria-selected="true"]')) showTab("paint");
    renderOpts(); requestDraw();
  }
  function setTerr(t) {
    terr = t;
    document.querySelectorAll("#pal [data-terr]").forEach(b => b.setAttribute("aria-pressed", b.dataset.terr === t));
    if (t === "plains") markRamp(4); else if (t === "highland") markRamp(14); else if (t === "mountain") markRamp(25); else if (t === "land") markRamp(brush.elev); else markRamp(-1);
    if (tool !== "brush" && tool !== "fill") setTool("brush"); else renderOpts();
  }
  function setElev(m) { brush.elev = m; setTerr("land"); }
  let rampM = 4;
  function markRamp(m) {
    rampM = m;
    document.querySelectorAll("#ramp span").forEach((s, i) => s.classList.toggle("on", i === m));
    $("elevVal").textContent = m < 0 ? T(terr === "water" ? "Water" : "Void").toLowerCase() :m + " · " + (m < 10 ? "plains" : m < 20 ? "highland" : "mountain");
  }
  document.querySelectorAll("#pal [data-terr]").forEach(b => { b.querySelector("i").style.background = terrColor(b.dataset.terr); b.addEventListener("click", () => setTerr(b.dataset.terr)); });
  for (let m = 0; m <= 30; m++) {
    const s = document.createElement("span"); s.style.background = rgbCss(landRGB[m]); s.title = "Height " + m;
    s.addEventListener("click", () => setElev(m)); $("ramp").appendChild(s);
  }
  document.querySelectorAll(".rail [data-tool]").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
  $("size").addEventListener("input", e => setParam("size", +e.target.value));
  $("rough").addEventListener("input", e => setParam("rough", +e.target.value));
  $("strength").addEventListener("input", e => setParam("strength", +e.target.value));
  $("undoBtn").addEventListener("click", undo);
  $("redoBtn").addEventListener("click", redo);
  $("fitBtn").addEventListener("click", fit);
  $("zoomIn").addEventListener("click", () => zoomAt(1.25, cssW / 2, cssH / 2));
  $("zoomOut").addEventListener("click", () => zoomAt(0.8, cssW / 2, cssH / 2));
  $("gameViewBtn").addEventListener("click", toggleGameView);
  $("traceBtn").addEventListener("click", () => setTrace(!traceOn));
  $("traceOp").addEventListener("input", e => setTraceOpacity(+e.target.value));
  $("traceOpBar").addEventListener("input", e => setTraceOpacity(+e.target.value));
  $("traceClear").addEventListener("click", clearTrace);

  // tabs
  function showTab(name) {
    document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.tab === name));
    document.querySelectorAll(".pane").forEach(p => p.classList.toggle("on", p.dataset.pane === name));
    if (name === "export") updateChecks();
  }
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => showTab(t.dataset.tab)));

  // modals
  function openModal(id) { $(id).classList.add("on"); }
  function closeModals() { document.querySelectorAll(".modal.on").forEach(m => m.classList.remove("on")); i2mSrc = null; }
  document.querySelectorAll(".modal").forEach(m => m.addEventListener("pointerdown", e => { if (e.target === m) closeModals(); }));
  $("helpBtn").addEventListener("click", () => openModal("helpModal"));
  $("helpClose").addEventListener("click", closeModals);
  $("newBtn").addEventListener("click", () => openModal("startModal"));
  $("startClose").addEventListener("click", closeModals);
  $("stContinue").addEventListener("click", closeModals);

  // ---------- map meta ----------
  CATEGORIES.forEach(c => { const o = document.createElement("option"); o.value = c; o.textContent = c.replace(/_/g, " "); $("mapCat").appendChild(o); });
  function folderName() { return ($("mapName").value.toLowerCase().replace(/[^a-z0-9]/g, "")) || "custommap"; }
  function mapId() {
    const words = $("mapName").value.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const id = words.map(w => w[0].toUpperCase() + w.slice(1)).join("");
    return !id ? "CustomMap" : /^[A-Za-z]/.test(id) ? id : "Map" + id;
  }
  function updateMeta() { $("mapFolder").value = folderName(); $("mapId").value = mapId(); updateFileTree(); scheduleSave(); updateChecks(); }
  $("mapName").addEventListener("input", updateMeta);
  $("mapName").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
  $("mapCat").addEventListener("change", scheduleSave);

  // ---------- new map ----------
  document.querySelectorAll("[data-preset]").forEach(b => b.addEventListener("click", () => { const [w, h] = b.dataset.preset.split("x"); $("newW").value = w; $("newH").value = h; }));
  function newMap(fill, w, h) {
    w = snap4(w || $("newW").value); h = snap4(h || $("newH").value);
    const b = cells ? snapshot() : null;
    const data = new Uint8Array(w * h); if (fill) data.fill(fill);
    nations = nations.filter(n => n.x < w && n.y < h);
    leaveGameView(true);
    setMap(w, h, data); fit();
    if (b) pushFull(b, "new map");
    renderNations();
  }
  $("newWater").addEventListener("click", () => newMap(0));
  $("newLand").addEventListener("click", () => newMap(1 + 4));

  // ---------- world generator ----------
  const WG = WorldGen.PRESETS, WG_KEYS = Object.keys(WG);
  const WG_SLIDERS = [["wgLand", "land", v => v + "%"], ["wgCount", "count", v => v], ["wgScale", "scale", v => T(v < 34 ? "Small" : v < 67 ? "Medium" : "Large").toLowerCase()], ["wgRough", "rough", v => v + "%"], ["wgDetail", "detail", v => v + "%"], ["wgIslands", "islands", v => v + "%"], ["wgMtn", "mtn", v => v + "%"], ["wgRanges", "ranges", v => v + "%"], ["wgRivers", "rivers", v => v]];
  const wg = { preset: "continents", sym: "none", edge: "ocean" };
  let wgTimer = 0, wgThumbTimer = 0, wgOpened = false;
  function wgParams() {
    const p = { preset: wg.preset, sym: wg.sym, edge: wg.edge, seed: +$("wgSeed").value | 0 };
    for (const [id, key] of WG_SLIDERS) p[key] = +$(id).value;
    return p;
  }
  function wgSize() { return $("wgSize").value.split("x").map(Number); }
  function wgSetPreset(k, keepSliders) {
    wg.preset = k;
    document.querySelectorAll("#wgPresets [data-p]").forEach(b => b.setAttribute("aria-pressed", b.dataset.p === k));
    if (!keepSliders) for (const [id, key] of WG_SLIDERS) $(id).value = WG[k][key];
    $("wgCountRow").hidden = !["continents", "fractured", "highlands"].includes(k);
    $("wgDesc").textContent = T(WG[k].name) + " · " + T(WG[k].desc);
    wgUpdate();
  }
  function wgSeg(id, key) {
    document.querySelectorAll("#" + id + " [data-v]").forEach(b => b.addEventListener("click", () => {
      wg[key] = b.dataset.v;
      document.querySelectorAll("#" + id + " [data-v]").forEach(x => x.setAttribute("aria-pressed", x === b));
      wgUpdate(true);
    }));
  }
  // Small previews: land shaded by height, coastal water lighter.
  function paintCells(canvas, out, w, h) {
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext("2d"), img = g.createImageData(w, h), d = img.data;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      const v = out[i], q = i * 4; let c;
      if (v === WATER) {
        const coast = (x > 0 && isLand(out[i - 1])) || (x < w - 1 && isLand(out[i + 1])) || (y > 0 && isLand(out[i - w])) || (y < h - 1 && isLand(out[i + w]));
        c = coast ? SHORE_W : [44, 96, 158];
      } else if (v === VOID) c = [9, 11, 16];
      else {
        const base = landRGB[v - 1], ul = x > 0 && y > 0 ? out[i - w - 1] : v, dr = x < w - 1 && y < h - 1 ? out[i + w + 1] : v;
        const f = 1 + Math.max(-0.2, Math.min(0.2, (hAt(ul) - hAt(dr)) * 0.04));
        c = [base[0] * f, base[1] * f, base[2] * f];
      }
      d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  }
  function wgUpdate(thumbsToo) {
    for (const [id, , f] of WG_SLIDERS) $(id + "Val").textContent = f(+$(id).value);
    clearTimeout(wgTimer);
    wgTimer = setTimeout(() => {
      const [fw, fh] = wgSize(), pw = 440, ph = Math.round(pw * fh / fw);
      const out = WorldGen.generate(pw, ph, wgParams());
      paintCells($("wgCanvas"), out, pw, ph);
      let land = 0, voids = 0;
      for (const v of out) { if (isLand(v)) land++; else if (v === VOID) voids++; }
      $("wgInfo").textContent = "Map " + fw + " × " + fh + " · about " + Math.round(land / out.length * 100) + "% land (≈ " + fmt(Math.round(land / out.length * fw * fh)) + " land tiles)" + (voids ? " · " + Math.round(voids / out.length * 100) + "% void" : "") + " · seed " + $("wgSeed").value;
    }, 50);
    if (thumbsToo) { clearTimeout(wgThumbTimer); wgThumbTimer = setTimeout(wgThumbs, 250); }
  }
  function wgThumbs() {
    const seed = +$("wgSeed").value | 0;
    document.querySelectorAll("#wgPresets [data-p]").forEach(b => {
      const k = b.dataset.p, p = Object.assign({}, WG[k], { preset: k, seed, sym: wg.sym, edge: wg.edge });
      paintCells(b.querySelector("canvas"), WorldGen.generate(128, 80, p), 128, 80);
    });
  }
  $("wgPresets").innerHTML = WG_KEYS.map(k => '<button class="wgp" data-p="' + k + '" aria-pressed="false" title="' + WG[k].desc + '"><canvas width="128" height="80"></canvas>' + WG[k].name + "</button>").join("");
  document.querySelectorAll("#wgPresets [data-p]").forEach(b => b.addEventListener("click", () => wgSetPreset(b.dataset.p)));
  for (const [id] of WG_SLIDERS) $(id).addEventListener("input", () => wgUpdate());
  $("wgSize").addEventListener("change", () => wgUpdate());
  $("wgSeed").addEventListener("input", () => wgUpdate(true));
  $("wgDice").addEventListener("click", () => { $("wgSeed").value = Math.floor(Math.random() * 1e6); wgUpdate(true); });
  wgSeg("wgSym", "sym"); wgSeg("wgEdge", "edge");
  $("wgSurprise").addEventListener("click", () => {
    const k = WG_KEYS[Math.floor(Math.random() * WG_KEYS.length)];
    $("wgSeed").value = Math.floor(Math.random() * 1e6);
    wgSetPreset(k);
    const jig = (id, amt, lo, hi) => { $(id).value = Math.max(lo, Math.min(hi, +$(id).value + Math.round((Math.random() - 0.5) * 2 * amt))); };
    jig("wgLand", 10, 10, 92); jig("wgRough", 25, 0, 100); jig("wgDetail", 20, 0, 100); jig("wgMtn", 25, 0, 100);
    jig("wgRanges", 30, 0, 100); jig("wgIslands", 15, 0, 100); jig("wgScale", 20, 0, 100);
    wgUpdate(true);
  });
  function openWorldGen(preset) {
    closeModals(); openModal("genModal");
    if (!+$("wgSeed").value) $("wgSeed").value = Math.floor(Math.random() * 1e6);
    wgSetPreset(preset || wg.preset, !preset && wgOpened);
    wgOpened = true; wgThumbs();
  }
  $("wgOpen").addEventListener("click", () => openWorldGen());
  $("genClose").addEventListener("click", closeModals);
  $("wgCancel").addEventListener("click", closeModals);
  $("wgOk").addEventListener("click", () => {
    const p = wgParams(), [fw, fh] = wgSize(), name = WG[p.preset].name;
    closeModals(); busy(T("Generating {x}…", { x: T(name).toLowerCase() }));
    setTimeout(() => {
      try { applyCells(fw, fh, WorldGen.generate(fw, fh, p), "generate " + name.toLowerCase()); toast(T("{x} generated · seed {seed}", { x: T(name), seed: p.seed })); }
      catch (err) { toast("Generator failed: " + err.message, true); }
      unbusy();
    }, 30);
  });
  $("wgQuick").innerHTML = WG_KEYS.slice(0, 9).map(k => '<button class="btn2" data-p="' + k + '">' + WG[k].name + "</button>").join("");
  $("wgQuick").addEventListener("click", e => { const b = e.target.closest("[data-p]"); if (b) openWorldGen(b.dataset.p); });
  WG_KEYS.forEach(k => { const o = document.createElement("option"); o.value = k; o.textContent = WG[k].name; $("stShape").appendChild(o); });

  // ---------- images ----------
  async function decodeImage(blob) {
    try { return await createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" }); }
    catch (_) { return await createImageBitmap(blob); }
  }
  function bitmapPixels(bmp, w, h) {
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingEnabled = w !== bmp.width || h !== bmp.height; x.imageSmoothingQuality = "high";
    x.drawImage(bmp, 0, 0, w, h);
    return x.getImageData(0, 0, w, h).data;
  }
  // OpenFront rules (alpha<20 or blue 106 = water, #000 = void, else height from blue 140..200).
  function cellsFromOpenFront(px, n) {
    const out = new Uint8Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = px[p], g = px[p + 1], b = px[p + 2], a = px[p + 3];
      if (a < 20 || b === 106) out[i] = WATER;
      else if (r === 0 && g === 0 && b === 0) out[i] = VOID;
      else out[i] = 1 + Math.ceil((Math.min(200, Math.max(140, b)) - 140) / 2);
    }
    return out;
  }
  // An OpenFront source image (greyscale or play-layer colours): blue 106 water, blue 140..200 land.
  function looksOpenFront(px) {
    let n = 0, key = 0, ofish = 0;
    for (let p = 0; p < px.length; p += 4 * 7) {
      n++; const b = px[p + 2];
      if (b === 106 || px[p + 3] < 20) key++;
      if (b === 106 || (b >= 140 && b <= 200) || (px[p] === 0 && px[p + 1] === 0 && b === 0) || px[p + 3] < 20) ofish++;
    }
    return key / n > 0.03 && ofish / n > 0.97;
  }
  function applyCells(w, h, data, label) {
    const b = snapshot();
    leaveGameView(true);
    if (w !== W || h !== H) { setMap(w, h, data); fit(); } else { cells.set(data); computeDepth(); refreshAll(); }
    // A map built from a picture or a template is a new map: its old spawns would land in random places.
    nations = []; selNation = -1; renderNations(); clearTrace(true);
    pushFull(b, label);
  }
  function setTrace(on) {
    traceOn = on; $("traceBtn").setAttribute("aria-pressed", on);
    $("traceOpBar").hidden = !trace || !on;
    requestDraw();
  }
  function setTraceOpacity(v) {
    traceOpacity = v / 100; $("traceOp").value = v; $("traceOpBar").value = v; $("traceOpVal").textContent = v + "%";
    requestDraw();
  }
  function clearTrace(quiet) {
    if (!trace) return;
    trace = null; traceOn = false; $("traceBtn").hidden = true; $("traceOpRow").hidden = true; $("traceOpBar").hidden = true;
    saveOverlay(null); requestDraw();
    if (quiet !== true) toast("Overlay removed");
  }
  // The picture a map was built from stays as a see-through overlay, so it is easy to fix things by hand.
  function useTrace(bmp, blob, quiet) {
    trace = bmp; $("traceBtn").hidden = false; $("traceOpRow").hidden = false; setTrace(true);
    if (blob) saveOverlay(blob);
    if (!quiet) toast("Overlay on: your image sits over the map · press T to hide it");
  }

  // ---------- image to map ----------
  // Classes while building: 0 water, 1 land (height from the pipeline), 2 highland, 3 mountain, 4 void.
  const PAL_TERR = [["water", "Water"], ["plains", "Land"], ["highland", "Highland"], ["mountain", "Mountain"], ["void", "Void"]];
  const PAL_CLS = { water: 0, plains: 1, highland: 2, mountain: 3, void: 4 };
  let i2mBlob = null;
  let i2mSrc = null, i2mPrevPx = null, i2mPW = 0, i2mPH = 0, i2mMode = "bright", i2mView = "result", i2mTimer = 0, i2mName = "";
  let i2mPal = [], i2mLut = null;
  const i2mAspect = () => i2mSrc.height / i2mSrc.width;
  function i2mFinalSize() {
    if (i2mMode === "openfront") { let w = i2mSrc.width, h = i2mSrc.height; const s = Math.min(1, MAX_SIDE / Math.max(w, h)); w = Math.floor(w * s); h = Math.floor(h * s); return [Math.max(200, w - w % 4), Math.max(200, h - h % 4)]; }
    let w = +$("i2mSize").value, h = Math.round(w * i2mAspect());
    if (h > MAX_SIDE) { h = MAX_SIDE; w = Math.round(h / i2mAspect()); }
    return [snap4(w), snap4(h)];
  }
  async function openImageToMap(blob, name) {
    try {
      busy("Reading image…");
      const bmp = await decodeImage(blob);
      unbusy();
      i2mName = name || "image"; i2mBlob = blob;
      const s = Math.min(1, 460 / Math.max(bmp.width, bmp.height));
      i2mPW = Math.max(40, Math.round(bmp.width * s)); i2mPH = Math.max(40, Math.round(bmp.height * s));
      i2mPrevPx = bitmapPixels(bmp, i2mPW, i2mPH);
      const sw = Math.min(bmp.width, 600), of = looksOpenFront(bitmapPixels(bmp, sw, Math.max(1, Math.round(sw * bmp.height / bmp.width))));
      const asp = bmp.height / bmp.width;
      $("i2mSize").value = snap4(Math.min(MAX_SIDE, Math.sqrt(2.4e6 / asp)));
      buildPalette(i2mPrevPx, i2mPW, i2mPH);
      closeModals(); i2mSrc = bmp;
      // Flat-colour pictures (political maps, logos, drawings) read best by colour, photos and heightmaps by brightness.
      const big = i2mPal.filter(p => p.share > 0.02);
      const flat = big.length <= 8 && big.reduce((s, p) => s + p.share, 0) > 0.88 && big.some(p => p.terr === "water");
      // Light border (white paper, bright sky) usually means the land is the dark part.
      $("i2mInv").checked = borderLum(i2mPrevPx, i2mPW, i2mPH) > 0.55;
      const phys = !of && PhysicalMap.looksPhysical(i2mPrevPx);
      setI2mMode(of ? "openfront" : phys ? "physical" : flat ? "color" : "bright", true);
      openModal("imgModal");
      updateI2m();
    } catch (err) { unbusy(); toast("Could not read that image: " + err.message, true); }
  }
  function borderLum(px, w, h) {
    let s = 0, n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x += (y === 0 || y === h - 1) ? 1 : w - 1) {
      const p = (y * w + x) * 4; if (px[p + 3] < 20) continue;
      s += (px[p] * 0.299 + px[p + 1] * 0.587 + px[p + 2] * 0.114) / 255; n++;
    }
    return n ? s / n : 0;
  }
  // Main colours of the image (merged when close). The colour that touches the border most and
  // blue-ish colours start as water, everything else as land.
  function buildPalette(px, w, h) {
    const bins = new Map(), edge = new Map(); let total = 0;
    for (let y = 0, p = 0; y < h; y++) for (let x = 0; x < w; x++, p += 4) {
      if (px[p + 3] < 20) continue;
      const k = (px[p] >> 4) << 8 | (px[p + 1] >> 4) << 4 | (px[p + 2] >> 4);
      bins.set(k, (bins.get(k) || 0) + 1); total++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge.set(k, (edge.get(k) || 0) + 1);
    }
    const sorted = [...bins.entries()].sort((a, b) => b[1] - a[1]), pal = [];
    for (const [k, cnt] of sorted) {
      const rgb = [((k >> 8) & 15) * 16 + 8, ((k >> 4) & 15) * 16 + 8, (k & 15) * 16 + 8];
      let near = null;
      for (const p of pal) if (Math.hypot(p.rgb[0] - rgb[0], p.rgb[1] - rgb[1], p.rgb[2] - rgb[2]) < 56) { near = p; break; }
      if (near) { near.count += cnt; near.edge += edge.get(k) || 0; continue; }
      if (pal.length < 10) pal.push({ rgb, count: cnt, edge: edge.get(k) || 0 });
    }
    let border = null; for (const p of pal) if (!border || p.edge > border.edge) border = p;
    for (const p of pal) {
      p.share = p.count / Math.max(1, total);
      const [r, g, b] = p.rgb, blue = b > r + 25 && b > g - 10;
      p.terr = blue || (p === border && p.edge > 0) ? "water" : "plains";
    }
    i2mPal = pal; i2mLut = null;
    renderPalette();
  }
  function renderPalette() {
    $("i2mPal").innerHTML = i2mPal.map((p, i) => '<div class="prow" data-i="' + i + '"><i style="background:' + rgbCss(p.rgb) + '"></i><span>' + Math.round(p.share * 100) + '%</span><select data-i="' + i + '" aria-label="Terrain for this colour">' +
      PAL_TERR.map(([k, n]) => '<option value="' + k + '"' + (p.terr === k ? " selected" : "") + ">" + n + "</option>").join("") + "</select></div>").join("");
  }
  $("i2mPal").addEventListener("change", e => { const i = e.target.dataset.i; if (i != null) { i2mPal[i].terr = e.target.value; updateI2m(); } });
  // Nearest palette entry for each 12-bit colour, cached.
  function palIndex(r, g, b) {
    if (!i2mLut) i2mLut = new Int16Array(4096).fill(-1);
    const k = (r >> 4) << 8 | (g >> 4) << 4 | (b >> 4);
    let v = i2mLut[k];
    if (v < 0) {
      const cr = (r >> 4) * 16 + 8, cg = (g >> 4) * 16 + 8, cb = (b >> 4) * 16 + 8; let best = 1e9;
      i2mPal.forEach((p, i) => { const d = (p.rgb[0] - cr) ** 2 + (p.rgb[1] - cg) ** 2 + (p.rgb[2] - cb) ** 2; if (d < best) { best = d; v = i; } });
      i2mLut[k] = v;
    }
    return v;
  }
  function setI2mMode(m, silent) {
    i2mMode = m;
    document.querySelectorAll("#i2mMode [data-m]").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m));
    const of = m === "openfront";
    $("i2mColRow").hidden = m !== "color";
    $("i2mLevelRow").hidden = m !== "bright"; $("i2mInvRow").hidden = m !== "bright";
    const ph = m === "physical";
    $("i2mOutRow").hidden = !ph; $("i2mRivRow").hidden = !ph; $("i2mRivWRow").hidden = !ph || !$("i2mRiv").checked;
    for (const id of ["i2mSmoothRow", "i2mIslRow", "i2mLakeRow", "i2mHT", "i2mHRow", "i2mMtnRow", "i2mVarRow", "i2mSizeRow"]) $(id).hidden = of;
    $("i2mHRow").hidden = of || ph; // physical maps take heights from their colours
    $("i2mBox").classList.toggle("pick", m === "color");
    $("i2mLevelVal").textContent = $("i2mLevel").value + "%";
    if (!silent) updateI2m();
  }
  function i2mParams(finalW, finalH, w, h) {
    const isl = +$("i2mIsl").value, lake = +$("i2mLake").value;
    const area = (w * h) / (finalW * finalH);
    return {
      mode: i2mMode, level: $("i2mLevel").value / 100, inv: $("i2mInv").checked, smooth: $("i2mSmooth").value / 100,
      minIsl: Math.round(Math.pow(isl / 100, 2) * 5000 * area), minLake: Math.round(Math.pow(lake / 100, 2) * 2000 * area),
      heights: $("i2mH").value, mtn: $("i2mMtn").value / 100, vari: $("i2mVar").value / 100,
      outside: $("i2mOut").value, rivers: $("i2mRiv").checked, riverWidth: +$("i2mRivW").value, scale: w / finalW,
      islPx: Math.round(Math.pow(isl / 100, 2) * 5000), lakePx: Math.round(Math.pow(lake / 100, 2) * 2000),
    };
  }
  function boxBlur(a, w, h, r) {
    if (r < 1) return a;
    const tmp = new Float32Array(a.length), out = new Float32Array(a.length), d = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let s = 0; const row = y * w;
      for (let k = -r; k <= r; k++) s += a[row + Math.min(w - 1, Math.max(0, k))];
      for (let x = 0; x < w; x++) { tmp[row + x] = s / d; s += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    return out;
  }
  // Flips connected areas of `kind` (1 land / 0 water) smaller than min tiles; sea touching the border stays.
  function removeSmall(land, w, h, kind, min) {
    if (min < 1) return;
    const n = w * h, seen = new Uint8Array(n), q = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (seen[s] || land[s] !== kind) continue;
      let head = 0, tail = 0, edge = false; q[tail++] = s; seen[s] = 1;
      while (head < tail) {
        const i = q[head++], x = i % w;
        if (x === 0 || x === w - 1 || i < w || i >= n - w) edge = true;
        if (x > 0 && !seen[i - 1] && land[i - 1] === kind) { seen[i - 1] = 1; q[tail++] = i - 1; }
        if (x < w - 1 && !seen[i + 1] && land[i + 1] === kind) { seen[i + 1] = 1; q[tail++] = i + 1; }
        if (i >= w && !seen[i - w] && land[i - w] === kind) { seen[i - w] = 1; q[tail++] = i - w; }
        if (i < n - w && !seen[i + w] && land[i + w] === kind) { seen[i + w] = 1; q[tail++] = i + w; }
      }
      if (tail < min && !(kind === 0 && edge)) for (let k = 0; k < tail; k++) land[q[k]] = 1 - kind;
    }
  }
  function i2mBuild(px, w, h, p) {
    const n = w * h;
    if (p.mode === "openfront") return cellsFromOpenFront(px, n);
    if (p.mode === "physical") return PhysicalMap.build(px, w, h, p);
    const lum = new Float32Array(n), alpha = new Uint8Array(n), cls = new Uint8Array(n);
    for (let i = 0, q = 0; i < n; i++, q += 4) {
      alpha[i] = px[q + 3] >= 20 ? 1 : 0;
      lum[i] = (px[q] * 0.299 + px[q + 1] * 0.587 + px[q + 2] * 0.114) / 255;
    }
    // Auto contrast (colour guide: stretch heightmaps before use): 2nd..98th percentile -> 0..1.
    const hist = new Uint32Array(256); let cnt = 0;
    for (let i = 0; i < n; i++) if (alpha[i]) { hist[Math.min(255, lum[i] * 255 | 0)]++; cnt++; }
    let lo = 0, hi = 255, acc = 0;
    for (let b = 0; b < 256; b++) { acc += hist[b]; if (acc >= cnt * 0.02) { lo = b; break; } }
    acc = 0; for (let b = 255; b >= 0; b--) { acc += hist[b]; if (acc >= cnt * 0.02) { hi = b; break; } }
    const span = Math.max(1, hi - lo) / 255, lo01 = lo / 255;
    for (let i = 0; i < n; i++) { let v = Math.min(1, Math.max(0, (lum[i] - lo01) / span)); if (p.inv && p.mode === "bright") v = 1 - v; lum[i] = v; }
    const L = new Float32Array(n);
    if (p.mode === "color") {
      const map = i2mPal.map(e => PAL_CLS[e.terr]);
      for (let i = 0, q = 0; i < n; i++, q += 4) {
        cls[i] = alpha[i] ? map[palIndex(px[q], px[q + 1], px[q + 2])] : 0;
        L[i] = cls[i] >= 1 && cls[i] <= 3 ? 1 : 0;
      }
    } else for (let i = 0; i < n; i++) L[i] = alpha[i] ? lum[i] : 0;
    const r = Math.round(p.smooth * p.smooth * w / 90);
    const B = r ? boxBlur(boxBlur(L, w, h, r), w, h, r) : L;
    const thr = p.mode === "color" ? 0.5 : p.level;
    const land = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (cls[i] === 4) { land[i] = 2; continue; }
      land[i] = B[i] >= thr && alpha[i] ? 1 : 0;
    }
    removeSmall(land, w, h, 1, p.minIsl);
    removeSmall(land, w, h, 0, p.minLake);
    for (let i = 0; i < n; i++) if (land[i] === 1 && (cls[i] === 0 || cls[i] === 4)) cls[i] = 1; else if (land[i] === 0) cls[i] = 0;
    // heights
    const hgt = new Float32Array(n);
    if (p.heights === "coast") {
      const dist = new Float32Array(n).fill(-1), q = new Int32Array(n); let head = 0, tail = 0;
      for (let i = 0; i < n; i++) if (land[i] !== 1) { dist[i] = 0; q[tail++] = i; }
      if (!tail) for (let i = 0; i < n; i++) { const x = i % w, y = (i / w) | 0; if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { dist[i] = 0; q[tail++] = i; } }
      while (head < tail) {
        const i = q[head++], x = i % w, d = dist[i] + 1;
        if (x > 0 && dist[i - 1] < 0) { dist[i - 1] = d; q[tail++] = i - 1; }
        if (x < w - 1 && dist[i + 1] < 0) { dist[i + 1] = d; q[tail++] = i + 1; }
        if (i >= w && dist[i - w] < 0) { dist[i - w] = d; q[tail++] = i - w; }
        if (i < n - w && dist[i + w] < 0) { dist[i + w] = d; q[tail++] = i + w; }
      }
      const reach = Math.max(4, 0.16 * Math.min(w, h));
      for (let i = 0; i < n; i++) hgt[i] = land[i] === 1 ? Math.min(1, dist[i] / reach) : 0;
    } else if (p.heights === "bright") {
      let a = 1, b = 0;
      for (let i = 0; i < n; i++) if (land[i] === 1) { if (lum[i] < a) a = lum[i]; if (lum[i] > b) b = lum[i]; }
      const sp = b - a || 1;
      for (let i = 0; i < n; i++) if (land[i] === 1) hgt[i] = (lum[i] - a) / sp;
    }
    const out = new Uint8Array(n), fs = 6 / w; // noise in map-relative units, so the preview matches the final map
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      if (land[i] === 2) { out[i] = VOID; continue; }
      if (land[i] !== 1) { out[i] = WATER; continue; }
      let v = hgt[i];
      if (p.heights !== "flat") v = Math.pow(v, 1.35) * (0.25 + p.mtn * 1.1);
      if (p.vari) v += (fbm(x * fs, y * fs, 4, 99) - 0.5) * p.vari * (p.heights === "flat" ? 0.5 : 0.8) * (0.3 + v);
      v = Math.max(0, Math.min(1, v));
      const c = cls[i];
      const m = c === 2 ? 10 + Math.round(v * 9) : c === 3 ? 20 + Math.round(v * 10) : Math.round(v * 30);
      out[i] = 1 + m;
    }
    return out;
  }
  function updateI2m() {
    clearTimeout(i2mTimer);
    i2mTimer = setTimeout(renderI2m, 40);
    for (const [id, lab] of [["i2mLevel", "i2mLevelVal"], ["i2mSmooth", "i2mSmoothVal"], ["i2mMtn", "i2mMtnVal"], ["i2mVar", "i2mVarVal"]]) $(lab).textContent = $(id).value + "%";
    if (!i2mSrc) return;
    const [fw, fh] = i2mFinalSize(), p = i2mParams(fw, fh, i2mPW, i2mPH);
    $("i2mIslVal").textContent = fmt(p.islPx) + " px"; $("i2mLakeVal").textContent = fmt(p.lakePx) + " px";
    $("i2mSizeVal").textContent = fw + " × " + fh;
    const area = fw * fh;
    $("i2mSizeHint").textContent = fmt(area) + " pixels · " + (area < 2e6 ? "smaller than the recommended 2–3 million" : area > 3e6 ? "larger than the recommended 2–3 million" : "in the recommended 2–3 million range");
  }
  function renderI2m() {
    if (!i2mSrc) return;
    const c = $("i2mCanvas"), g = c.getContext("2d");
    c.width = i2mPW; c.height = i2mPH;
    const [fw, fh] = i2mFinalSize();
    const out = i2mBuild(i2mPrevPx, i2mPW, i2mPH, i2mParams(fw, fh, i2mPW, i2mPH));
    const img = g.createImageData(i2mPW, i2mPH), d = img.data;
    let land = 0;
    for (let i = 0, q = 0; i < out.length; i++, q += 4) {
      const v = out[i], col = v === WATER ? [52, 108, 168] : v === VOID ? [14, 16, 22] : valueRGB(v);
      if (isLand(v)) land++;
      if (i2mView === "source") { d[q] = i2mPrevPx[q]; d[q + 1] = i2mPrevPx[q + 1]; d[q + 2] = i2mPrevPx[q + 2]; }
      else if (i2mView === "mix") { d[q] = (col[0] + i2mPrevPx[q]) / 2; d[q + 1] = (col[1] + i2mPrevPx[q + 1]) / 2; d[q + 2] = (col[2] + i2mPrevPx[q + 2]) / 2; }
      else { d[q] = col[0]; d[q + 1] = col[1]; d[q + 2] = col[2]; }
      d[q + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    $("i2mInfo").textContent = i2mName + " · " + i2mSrc.width + " × " + i2mSrc.height + " → map " + fw + " × " + fh + " · about " + Math.round(land / out.length * 100) + "% land (≈ " + fmt(Math.round(land / out.length * fw * fh)) + " land tiles)" + (i2mMode === "openfront" ? " · read exactly like OpenFront's generator" : "");
  }
  document.querySelectorAll("#i2mMode [data-m]").forEach(b => b.addEventListener("click", () => setI2mMode(b.dataset.m)));
  document.querySelectorAll("#i2mView [data-v]").forEach(b => b.addEventListener("click", () => {
    i2mView = b.dataset.v; document.querySelectorAll("#i2mView [data-v]").forEach(x => x.setAttribute("aria-pressed", x === b)); renderI2m();
  }));
  for (const id of ["i2mLevel", "i2mSmooth", "i2mIsl", "i2mLake", "i2mMtn", "i2mVar", "i2mSize"]) $(id).addEventListener("input", updateI2m);
  for (const id of ["i2mInv", "i2mH", "i2mOut"]) $(id).addEventListener("change", updateI2m);
  $("i2mRiv").addEventListener("change", () => { $("i2mRivWRow").hidden = !$("i2mRiv").checked; updateI2m(); });
  $("i2mRivW").addEventListener("input", () => { $("i2mRivWVal").textContent = $("i2mRivW").value + " px"; updateI2m(); });
  $("i2mCanvas").addEventListener("click", e => {
    if (i2mMode !== "color") return;
    const c = $("i2mCanvas"), r = c.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / r.width * i2mPW), y = Math.floor((e.clientY - r.top) / r.height * i2mPH), q = (y * i2mPW + x) * 4;
    const k = palIndex(i2mPrevPx[q], i2mPrevPx[q + 1], i2mPrevPx[q + 2]);
    document.querySelectorAll("#i2mPal .prow").forEach((row, i) => row.classList.toggle("hl", i === k));
    const row = document.querySelector('#i2mPal .prow[data-i="' + k + '"]');
    if (row) { row.scrollIntoView({ block: "nearest" }); row.querySelector("select").focus(); }
  });
  $("imgClose").addEventListener("click", closeModals);
  $("i2mCancel").addEventListener("click", closeModals);
  $("i2mTrace").addEventListener("click", () => { const b = i2mSrc, blob = i2mBlob; closeModals(); if (b) useTrace(b, blob); });
  $("i2mOk").addEventListener("click", () => {
    if (!i2mSrc) return;
    const src = i2mSrc, blob = i2mBlob, [fw, fh] = i2mFinalSize(), p = i2mParams(fw, fh, fw, fh), name = i2mName;
    closeModals(); busy("Building the map…");
    setTimeout(() => {
      try {
        const px = bitmapPixels(src, fw, fh);
        applyCells(fw, fh, i2mBuild(px, fw, fh, p), "image to map");
        const base = name.replace(/[.][a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
        if (base && name !== "pasted image") { $("mapName").value = base.split(" ").filter(Boolean).map(t => t[0].toUpperCase() + t.slice(1)).join(" ").slice(0, 40); updateMeta(); }
        useTrace(src, blob, true); setTraceOpacity(35);
        toast("Map created from " + name + " · the image is shown as an overlay (T hides it)");
      } catch (err) { toast("Could not build the map: " + err.message, true); }
      unbusy();
    }, 30);
  });
  // entry points: file inputs, drop, paste
  $("impFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) openImageToMap(f, f.name); });
  $("stFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) openImageToMap(f, f.name); });
  stage.addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); stage.classList.add("drop"); } });
  stage.addEventListener("dragleave", () => stage.classList.remove("drop"));
  stage.addEventListener("drop", e => {
    e.preventDefault(); stage.classList.remove("drop");
    const f = [...e.dataTransfer.files].find(f => f.type.startsWith("image/"));
    if (f) openImageToMap(f, f.name);
    else { const j = [...e.dataTransfer.files].find(f => f.name.endsWith(".json")); if (j) loadInfoFile(j); }
  });
  window.addEventListener("paste", e => {
    if (e.target.matches && e.target.matches("input, textarea")) return;
    const it = [...(e.clipboardData ? e.clipboardData.items : [])].find(i => i.type.startsWith("image/"));
    if (it) { e.preventDefault(); openImageToMap(it.getAsFile(), "pasted image"); }
  });

  // ---------- nations from info.json ----------
  function applyInfo(info, keepName) {
    if (!info || typeof info !== "object") throw new Error("not an info.json");
    beginEdit();
    const conv = extra => n => ({ name: String(n.name || ""), flag: String(n.flag || ""), x: Math.max(0, Math.min(W - 1, n.coordinates[0] | 0)), y: Math.max(0, Math.min(H - 1, n.coordinates[1] | 0)), extra });
    const has = n => Array.isArray(n.coordinates);
    nations = [...(info.nations || []).filter(has).map(conv(false)), ...(info.additionalNations || []).filter(has).map(conv(true))];
    endEdit("load nations");
    if (!keepName && info.name) $("mapName").value = String(info.name);
    if (Array.isArray(info.categories) && CATEGORIES.includes(info.categories[0])) $("mapCat").value = info.categories[0];
    updateMeta(); renderNations(); requestDraw();
  }
  async function loadInfoFile(f) {
    try { applyInfo(JSON.parse(await f.text())); toast("Loaded " + nations.length + " nations"); }
    catch (err) { toast("Could not read info.json: " + err.message, true); }
  }
  $("infoFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) loadInfoFile(f); });

  // ---------- official templates ----------
  for (const sel of [$("tplSel"), $("stTpl")]) TEMPLATES.forEach(([f, n]) => { const o = document.createElement("option"); o.value = f; o.textContent = n; sel.appendChild(o); });
  $("stTpl").value = "britannia";
  $("tplSel").addEventListener("change", () => { $("tplBtn").disabled = !$("tplSel").value; });
  $("tplBtn").addEventListener("click", () => openTemplate($("tplSel").value));
  $("stTplBtn").addEventListener("click", () => { closeModals(); openTemplate($("stTpl").value); });
  async function openTemplate(f) {
    if (!f) return;
    busy("Downloading " + ((TEMPLATES.find(t => t[0] === f) || [])[1] || f) + "…");
    try {
      const [img, info] = await Promise.all([
        fetch(RAW + f + "/image.png").then(r => { if (!r.ok) throw new Error("HTTP " + r.status); return r.blob(); }),
        fetch(RAW + f + "/info.json").then(r => r.ok ? r.json() : null).catch(() => null),
      ]);
      const bmp = await decodeImage(img);
      const w = bmp.width - bmp.width % 4, h = bmp.height - bmp.height % 4;
      const all = cellsFromOpenFront(bitmapPixels(bmp, bmp.width, bmp.height), bmp.width * bmp.height);
      const data = new Uint8Array(w * h); // crop to multiples of 4 like the generator does
      for (let y = 0; y < h; y++) data.set(all.subarray(y * bmp.width, y * bmp.width + w), y * w);
      applyCells(w, h, data, "open " + f);
      if (info) { applyInfo(info, true); $("mapName").value = (info.display_name || info.name || f) + " Remix"; updateMeta(); }
      toast("Opened " + (info && info.name || f) + " · " + nations.length + " nations");
    } catch (err) { toast("Could not download the map: " + err.message, true); }
    finally { unbusy(); }
  }

  // ---------- start screen ----------
  $("stBlank").addEventListener("click", () => { const [w, h] = $("stSize").value.split("x"); closeModals(); newMap(0, +w, +h); toast("Blank ocean · pick the brush and paint land"); });
  $("stGen").addEventListener("click", () => { $("wgSeed").value = Math.floor(Math.random() * 1e6); openWorldGen($("stShape").value); });

  // ---------- flags (OpenFront's own list, 880+ flags) ----------
  fetch("/js/map-creator-flags.json").then(r => r.json()).then(list => {
    const dl = $("flagList"), frag = document.createDocumentFragment();
    for (const [code, name] of list) {
      const o = document.createElement("option"); o.value = code; if (name !== code) o.label = name; frag.appendChild(o);
      flagCodes.set(code.toLowerCase(), code); flagCodes.set(name.toLowerCase(), code);
    }
    dl.appendChild(frag); renderNations();
  }).catch(() => {});
  const flagCode = s => flagCodes.get(String(s || "").trim().toLowerCase()) || "";

  // ---------- nations list ----------
  function renderNations() {
    const box = $("nList"); box.textContent = "";
    $("nCount").textContent = nations.length;
    if (!nations.length) box.innerHTML = '<div class="empty">No nations yet.<br>Choose the flag tool and click on land to place a spawn.</div>';
    nations.forEach((n, i) => {
      const row = document.createElement("div"); row.className = "nrow" + (i === selNation ? " sel" : "");
      const dot = document.createElement("span"); dot.className = "dot" + (isLand(cells[n.y * W + n.x]) ? "" : " bad"); dot.title = "Show on the map";
      const name = document.createElement("input"); name.value = n.name; name.placeholder = "Nation " + (i + 1); name.setAttribute("aria-label", "Nation name");
      const fl = document.createElement("div"); fl.className = "fl";
      const flag = document.createElement("input"); flag.value = n.flag; flag.placeholder = "flag"; flag.setAttribute("list", "flagList"); flag.setAttribute("aria-label", "Flag");
      const code = flagCode(n.flag);
      if (code) { const im = document.createElement("img"); im.src = flagUrl(code); im.alt = ""; im.loading = "lazy"; im.onerror = () => im.remove(); fl.appendChild(im); } else flag.style.paddingLeft = "8px";
      fl.appendChild(flag);
      const del = document.createElement("button"); del.textContent = "✕"; del.title = "Remove"; del.setAttribute("aria-label", "Remove nation");
      const focus = () => { selNation = i; box.querySelectorAll(".nrow").forEach((r, k) => r.classList.toggle("sel", k === i)); centerOn(n.x, n.y); };
      dot.addEventListener("click", focus); name.addEventListener("focus", focus);
      name.addEventListener("change", () => { beginEdit(); n.name = name.value.trim(); endEdit("rename nation"); requestDraw(); });
      flag.addEventListener("change", () => { beginEdit(); n.flag = flagCode(flag.value) || flag.value.trim(); endEdit("nation flag"); renderNations(); });
      del.addEventListener("click", () => { beginEdit(); nations.splice(i, 1); selNation = -1; endEdit("remove nation"); renderNations(); requestDraw(); });
      row.append(dot, name, fl, del); box.appendChild(row);
    });
    if (tool === "nation") renderOpts();
    updateChecks();
  }
  function centerOn(x, y) {
    const sx = view.ox + x * view.zoom, sy = view.oy + y * view.zoom;
    if (sx < 60 || sy < 80 || sx > cssW - 60 || sy > cssH - 60) { view.ox = cssW / 2 - x * view.zoom; view.oy = cssH / 2 - y * view.zoom; }
    requestDraw();
  }
  $("nClear").addEventListener("click", () => { if (!nations.length) return; beginEdit(); nations = []; selNation = -1; endEdit("remove all nations"); renderNations(); requestDraw(); });

  // ---------- checks ----------
  let checkTimer = 0;
  function markChanged() { genStale = true; miniDirty = true; clearTimeout(checkTimer); checkTimer = setTimeout(updateChecks, 300); scheduleSave(); }
  function countLand() { let n = 0, v = 0; for (let i = 0; i < cells.length; i++) { const c = cells[i]; if (c === VOID) v++; else if (c) n++; } return [n, v]; }
  const fmt = n => n.toLocaleString("en-US");
  function updateChecks() {
    if (!cells) return;
    const [land, voids] = countLand(), area = W * H;
    const stats = [["Size", W + " × " + H], ["Pixels", fmt(area)], ["Land tiles", fmt(land) + " <small>" + Math.round(land / area * 100) + "%</small>"], ["Nations", nations.length]];
    if (voids) stats.push(["Void tiles", fmt(voids)]);
    if (lastGen && !genStale) stats.push(["Land in game", fmt(lastGen.map.numLandTiles)]);
    $("stats").innerHTML = stats.map(([k, v]) => '<div class="stat"><div class="k">' + k + '</div><div class="v">' + v + "</div></div>").join("");
    const out = [], add = (cls, t) => out.push('<div class="' + cls + '">' + t + "</div>");
    if (!land) add("bad", "The map has no land. OpenFront rejects maps with 0 land tiles.");
    else if (land > 3e6) add("warn", "More than 3 million land tiles: OpenFront says this can hurt performance.");
    else add("ok", "Land tiles within the limit (max 3,000,000).");
    if (area < 2e6) add("warn", "Smaller than the recommended 2–3 million pixels (fine for testing, small in game).");
    else if (area > 3e6) add("warn", "Larger than the recommended 2–3 million pixels.");
    else add("ok", "Map size in the recommended 2–3 million pixel range.");
    const offLand = nations.filter(n => !isLand(cells[n.y * W + n.x])).length;
    if (!nations.length) add("warn", "No nations yet. Bots still spawn, but most maps place nation spawns.");
    else if (offLand) add("warn", offLand + (offLand > 1 ? " nations are" : " nation is") + " not on land (red on the map).");
    else add("ok", "All " + nations.length + " nations stand on land.");
    const names = nations.map(n => n.name.trim().toLowerCase()).filter(Boolean);
    if (new Set(names).size !== names.length) add("warn", "Two nations share a name.");
    const badFlags = flagCodes.size ? nations.filter(n => n.flag && !flagCode(n.flag)).length : 0;
    if (badFlags) add("warn", badFlags + (badFlags > 1 ? " flags are" : " flag is") + " not in OpenFront's flag list.");
    if (!$("mapName").value.trim()) add("bad", "Give the map a name (top left).");
    if (lastGen && !genStale) {
      const s = lastGen.stats;
      add(s.islands ? "warn" : "ok", s.islands ? fmt(s.islands) + (s.islands > 1 ? " islands" : " island") + " under 30 tiles (" + fmt(s.islandTiles) + " tiles) will be removed by the game." : "No islands under 30 tiles.");
      add(s.lakes ? "warn" : "ok", s.lakes ? fmt(s.lakes) + (s.lakes > 1 ? " lakes" : " lake") + " under 200 tiles (" + fmt(s.lakeTiles) + " tiles) will be filled in." : "No lakes under 200 tiles.");
    } else add("warn", "Run the game's map generator to see what it will remove.");
    $("checks").innerHTML = out.join("");
  }
  function updateFileTree() {
    const f = folderName();
    $("fileTree").textContent = f + "-openfront-map.zip\n├ map-generator/assets/maps/" + f + "/\n│  ├ image.png\n│  └ info.json\n└ resources/maps/" + f + "/\n   ├ manifest.json\n   ├ map.bin · map4x.bin · map16x.bin\n   └ thumbnail.webp";
  }

  // ---------- generation (worker) ----------
  let worker = null, jobId = 0;
  const jobs = new Map();
  function runGenerator() {
    if (!worker) {
      worker = new Worker("/js/map-creator-worker.js");
      worker.onmessage = e => {
        const j = jobs.get(e.data.id); if (!j) return;
        if (e.data.progress) { $("busyMsg").textContent = e.data.progress + "…"; return; }
        jobs.delete(e.data.id);
        e.data.error ? j.reject(new Error(e.data.error)) : j.resolve(e.data.result);
      };
    }
    const rgba = sourceRGBA(), id = ++jobId;
    return new Promise((resolve, reject) => { jobs.set(id, { resolve, reject }); worker.postMessage({ id, rgba, width: W, height: H }, [rgba.buffer]); });
  }
  // The image.png the official generator reads, in the play-layer colours of the colour guide.
  function sourceRGBA() {
    const px = new Uint8ClampedArray(W * H * 4), lut = [];
    for (let v = 0; v < 256; v++) lut.push(playLayerRGB(v === WATER || v === VOID ? v : Math.min(v, 31)));
    for (let i = 0, p = 0; i < cells.length; i++, p += 4) { const c = lut[cells[i]]; px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = 255; }
    return px;
  }
  async function ensureGenerated() {
    if (lastGen && !genStale) return lastGen;
    busy("Running the OpenFront map generator…");
    try { lastGen = await runGenerator(); genStale = false; buildGameCanvas(); updateChecks(); return lastGen; }
    finally { unbusy(); }
  }
  function buildGameCanvas() {
    const m = lastGen.map;
    gameCanvas = document.createElement("canvas"); gameCanvas.width = m.width; gameCanvas.height = m.height;
    const g = gameCanvas.getContext("2d"), img = g.createImageData(m.width, m.height), p32 = new Uint32Array(img.data.buffer);
    const glut = new Uint32Array(256);
    for (let b = 0; b < 256; b++) { const c = OFMapGen.tileColor(b); glut[b] = abgr(c[0], c[1], c[2]); }
    for (let i = 0; i < m.data.length; i++) p32[i] = glut[m.data[i]];
    g.putImageData(img, 0, 0);
    const t = lastGen.thumb, tc = document.createElement("canvas"); tc.width = t.width; tc.height = t.height;
    tc.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(t.data), t.width, t.height), 0, 0);
    lastGen.thumbCanvas = tc;
    $("thumbPrev").src = tc.toDataURL("image/png"); $("thumbPrev").style.display = "block";
  }
  async function toggleGameView() {
    if (gameView) { leaveGameView(); return; }
    try { await ensureGenerated(); gameView = true; $("gameViewBtn").setAttribute("aria-pressed", "true"); miniDirty = true; requestDraw(); toast("Game view: exactly what OpenFront will load"); }
    catch (err) { toast("Generator failed: " + err.message, true); }
  }
  function leaveGameView(silent) {
    if (!gameView) return;
    gameView = false; $("gameViewBtn").setAttribute("aria-pressed", "false"); miniDirty = true; requestDraw();
    if (!silent) toast("Editor view");
  }
  $("checkBtn").addEventListener("click", async () => {
    try { await ensureGenerated(); toast("Checked: " + fmt(lastGen.map.numLandTiles) + " land tiles in game"); }
    catch (err) { toast("Generator failed: " + err.message, true); }
  });

  // ---------- export ----------
  function infoJson() {
    const info = { id: mapId(), name: $("mapName").value.trim() || "Custom Map", translation_key: "map." + folderName(), categories: [$("mapCat").value] };
    // additionalNations (kept from official maps) only spawn in bigger lobbies.
    const conv = (n, i) => { const o = { coordinates: [n.x, n.y], name: n.name || "Nation " + (i + 1) }; if (n.flag) o.flag = n.flag; return o; };
    const main = nations.filter(n => !n.extra), extra = nations.filter(n => n.extra);
    if (main.length) info.nations = main.map(conv);
    if (extra.length) info.additionalNations = extra.map((n, i) => conv(n, main.length + i));
    return info;
  }
  // Go's json.MarshalIndent sorts keys; prettier then keeps short number arrays on one line.
  function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach(k => o[k] = sortKeys(v[k])); return o; } return v; }
  function prettyJson(o) { return JSON.stringify(o, null, 2).replace(/\[\s+(-?\d+),\s+(-?\d+)\s+\]/g, "[$1, $2]") + "\n"; }
  function canvasBlob(c, type, q) { return new Promise(r => c.toBlob(r, type, q)); }
  async function imagePngBlob() {
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    c.getContext("2d").putImageData(new ImageData(sourceRGBA(), W, H), 0, 0);
    return canvasBlob(c, "image/png");
  }
  function download(blob, name) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  $("pngBtn").addEventListener("click", async () => download(await imagePngBlob(), "image.png"));
  $("infoBtn").addEventListener("click", () => download(new Blob([prettyJson(infoJson())], { type: "application/json" }), "info.json"));
  async function exportZip() {
    const [land] = countLand();
    if (!land) { toast("Paint some land first: OpenFront rejects maps without land.", true); return; }
    try {
      const g = await ensureGenerated();
      busy("Packing the .zip…");
      const folder = folderName(), info = infoJson();
      const manifest = sortKeys(Object.assign({}, info, {
        map: { width: g.map.width, height: g.map.height, num_land_tiles: g.map.numLandTiles },
        map4x: { width: g.map4x.width, height: g.map4x.height, num_land_tiles: g.map4x.numLandTiles },
        map16x: { width: g.map16x.width, height: g.map16x.height, num_land_tiles: g.map16x.numLandTiles },
      }));
      const thumb = await canvasBlob(g.thumbCanvas, "image/webp", 0.45);
      const png = await imagePngBlob();
      const enc = new TextEncoder();
      const files = [
        [folder + "/README.txt", enc.encode(readme(folder, info, g))],
        [folder + "/map-generator/assets/maps/" + folder + "/image.png", new Uint8Array(await png.arrayBuffer())],
        [folder + "/map-generator/assets/maps/" + folder + "/info.json", enc.encode(prettyJson(info))],
        [folder + "/resources/maps/" + folder + "/manifest.json", enc.encode(prettyJson(manifest))],
        [folder + "/resources/maps/" + folder + "/map.bin", g.map.data],
        [folder + "/resources/maps/" + folder + "/map4x.bin", g.map4x.data],
        [folder + "/resources/maps/" + folder + "/map16x.bin", g.map16x.data],
      ];
      if (thumb && thumb.type === "image/webp") files.push([folder + "/resources/maps/" + folder + "/thumbnail.webp", new Uint8Array(await thumb.arrayBuffer())]);
      download(makeZip(files), folder + "-openfront-map.zip");
      toast("Downloaded " + folder + "-openfront-map.zip");
    } catch (err) { toast("Export failed: " + err.message, true); }
    finally { unbusy(); }
  }
  $("zipBtn").addEventListener("click", exportZip);
  $("zipBtn2").addEventListener("click", exportZip);
  function readme(folder, info, g) {
    return [
      "OpenFront map: " + info.name,
      "Made with the TeamStats.pro Map Creator (https://teamstats.pro/map-creator.html)",
      "",
      "Size " + g.map.width + " x " + g.map.height + ", " + g.map.numLandTiles + " land tiles, " + ((info.nations || []).length + (info.additionalNations || []).length) + " nations.",
      "",
      "map-generator/assets/maps/" + folder + "/   source files (image.png in play-layer colours + info.json)",
      "resources/maps/" + folder + "/              game files, the same bytes `go run . --maps=" + folder + "` writes",
      "",
      "How to add it to OpenFront (https://github.com/openfrontio/OpenFrontIO):",
      "1. Copy both folders into the same paths of your OpenFrontIO checkout.",
      "2. In map-generator/ run: go run . --maps=" + folder,
      "   (this also registers the map in src/core/game/Maps.gen.ts and resources/lang/en.json)",
      "3. Start the game locally (npm run dev) and pick the map in a private lobby.",
      "4. Add licence/credits to CREDITS.md and open a pull request.",
      "",
      "The game cannot load a custom map from a file yet; maps ship through the repository.",
      "",
    ].join("\r\n");
  }
  // Minimal ZIP writer (stored, no compression) with CRC-32.
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(d) { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  function makeZip(files) {
    const parts = [], central = [], enc = new TextEncoder();
    const now = new Date(), time = now.getHours() << 11 | now.getMinutes() << 5 | (now.getSeconds() >> 1);
    const date = (now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
    let offset = 0;
    for (const [name, data] of files) {
      const nb = enc.encode(name), crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
      h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, nb, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, nb.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, nb);
      offset += 30 + nb.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + p.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, e.buffer], { type: "application/zip" });
  }

  // ---------- busy / toast ----------
  let toastTimer = 0;
  function toast(msg, bad) {
    const el = $("toast"); el.textContent = msg; el.classList.toggle("bad", !!bad); el.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("on"), bad ? 7000 : 3200);
  }
  function busy(msg) { $("busyMsg").textContent = msg; $("busy").classList.add("on"); }
  function unbusy() { $("busy").classList.remove("on"); }
  // data-tip-down tooltips are CSS attr() text the i18n engine does not watch: translated here, English kept on the element
  function setTip(el, en) { el.__tipEn = en; el.dataset.tipDown = T(en); }
  function translateTips() { document.querySelectorAll("[data-tip-down]").forEach(el => setTip(el, el.__tipEn != null ? el.__tipEn : el.dataset.tipDown)); }

  // ---------- autosave (IndexedDB, this browser only) ----------
  let saveTimer = 0;
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open("map-creator", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("s");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      if (!cells) return;
      try { const d = await db(); d.transaction("s", "readwrite").objectStore("s").put({ W, H, cells, nations, name: $("mapName").value, cat: $("mapCat").value }, "autosave"); }
      catch (_) { /* storage blocked: the editor still works */ }
    }, 1200);
  }
  async function saveOverlay(blob) {
    try { const d = await db(), st = d.transaction("s", "readwrite").objectStore("s"); blob ? st.put(blob, "overlay") : st.delete("overlay"); } catch (_) { /* storage blocked */ }
  }
  async function restoreOverlay() {
    try {
      const d = await db();
      const blob = await new Promise(res => { const r = d.transaction("s").objectStore("s").get("overlay"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
      if (blob) { useTrace(await decodeImage(blob), null, true); setTrace(false); setTraceOpacity(35); }
    } catch (_) { /* no overlay */ }
  }
  async function restore() {
    try {
      const d = await db();
      return await new Promise(res => { const r = d.transaction("s").objectStore("s").get("autosave"); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    } catch (_) { return null; }
  }

  // ---------- submit to the Map Gallery ----------
  // Logged-in (Discord) users submit the map to /map-gallery.html. ?gallery=<id> (from the gallery)
  // opens that map; for its creator Submit then updates it. &download=1 also downloads the .zip.
  const GAL = (() => {
    let me = null, configured = false, editing = null, type = "fictional";
    // Real = a map of a real place, Fictional = made up; a new map starts from its OpenFront category
    const REAL_CATS = ["world", "continental", "europe", "asia", "north_america", "africa", "south_america", "oceania", "antarctica", "countries"];
    const meReady = fetch("/api/me", { credentials: "same-origin", cache: "no-store" }).then(r => r.ok ? r.json() : null)
      .then(d => { me = d && d.user; configured = !!(d && d.configured); }).catch(() => {});
    function api(path, body) {
      return fetch(path, body ? { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { credentials: "same-origin", cache: "no-store" })
        .then(r => r.json().catch(() => ({})).then(d => { if (!r.ok) throw new Error(d.error || "Something went wrong."); return d; }));
    }
    async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
    function toB64(u8) { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
    function thumbCanvas() {
      const k = Math.min(1, 720 / W, 480 / H), c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
      const g = c.getContext("2d"); g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(mapCanvas, 0, 0, c.width, c.height);
      return c;
    }
    function thumbData(c) { let u = c.toDataURL("image/webp", 0.82); if (!u.startsWith("data:image/webp")) u = c.toDataURL("image/png"); return u; }
    function setType(v) { type = v === "real" ? "real" : "fictional"; $("subType").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.v === type)); }
    $("subType").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setType(b.dataset.v); });
    function sync() { $("submitLbl").textContent = editing ? "Update" : "Submit"; setTip($("submitBtn"), editing ? "Update “" + editing.name + "” in the Map Gallery" : "Submit this map to the Map Gallery"); }
    async function send(asNew) {
      const [land] = countLand();
      if (!land) { $("subErr").textContent = "Paint some land first."; return; }
      const updating = !!editing && !asNew;
      $("subErr").textContent = ""; $("subGo").disabled = $("subAsNew").disabled = true;
      busy(updating ? "Updating the gallery map…" : "Uploading to the Map Gallery…");
      try {
        const body = { name: $("subName").value, description: $("subDesc").value, type, private: $("subPrivate").checked,
          category: $("mapCat").value, nations, w: W, h: H, cells: toB64(await pipe(cells, new CompressionStream("deflate"))), thumb: thumbData(thumbCanvas()) };
        const r = await api(updating ? "/api/maps/" + encodeURIComponent(editing.id) : "/api/maps", body);
        editing = { id: r.item.id, name: r.item.name };
        history.replaceState(null, "", location.pathname + "?gallery=" + encodeURIComponent(editing.id));
        sync(); closeModals();
        toast(updating ? "Gallery map updated" : "Submitted to the Map Gallery");
        setTimeout(() => { location.href = "/map-gallery.html?item=" + encodeURIComponent(r.item.id); }, 900);
      } catch (e) { $("subErr").textContent = e.message; }
      finally { unbusy(); $("subGo").disabled = $("subAsNew").disabled = false; }
    }
    async function open() {
      const body = $("submitBody");
      body.querySelectorAll(".gate").forEach(x => x.remove());
      [...body.children].forEach(x => x.hidden = false);
      openModal("submitModal");
      await meReady;
      if (!me) {
        [...body.children].forEach(x => x.hidden = true);
        const g = document.createElement("div"); g.className = "gate";
        g.innerHTML = configured ? "Log in with Discord to submit maps to the gallery. Your map stays saved in this browser.<br><a href=\"/auth/discord?next=" + encodeURIComponent(location.pathname + location.search) + "\">Log in with Discord</a>"
          : "Discord login is not set up on this server, so maps cannot be submitted here.";
        body.appendChild(g); return;
      }
      $("submitPrev").src = thumbData(thumbCanvas());
      $("subErr").textContent = "";
      const [land] = countLand();
      $("subNote").textContent = W + " × " + H + " tiles · " + land.toLocaleString("en-US") + " land · " + nations.length + " nations" + (nations.length ? "" : " (add nations in the Nations tab so bots spawn)");
      if (editing) {
        $("submitTitle").textContent = "Update your gallery map"; $("submitLead").textContent = "Saves the current map over “" + editing.name + "”, or submit it as a new map.";
        $("subGo").textContent = "Update"; $("subAsNew").hidden = false;
      } else {
        $("submitTitle").textContent = "Submit to the Map Gallery"; $("submitLead").textContent = "Share this map with other players. Logged-in players can rate it and comment.";
        $("subGo").textContent = "Submit"; $("subAsNew").hidden = true;
        $("subName").value = $("mapName").value.trim() || "My Map";
        setType(REAL_CATS.includes($("mapCat").value) ? "real" : "fictional");
      }
      $("subName").focus();
    }
    $("submitBtn").addEventListener("click", open);
    $("submitClose").addEventListener("click", closeModals);
    $("subGo").addEventListener("click", () => send(false));
    $("subAsNew").addEventListener("click", () => send(true));
    // Opened from the gallery: load the map (and for its creator, remember it so Submit updates it).
    async function load(id, download) {
      busy("Opening the gallery map…");
      try {
        const it = (await api("/api/maps/" + encodeURIComponent(id))).item;
        if (it.canEdit) {
          editing = { id: it.id, name: it.name };
          $("subName").value = it.name; $("subDesc").value = it.description || ""; setType(it.type); $("subPrivate").checked = it.private;
          sync();
        }
        // a reload keeps the edits made since (the autosave has them), unless the gallery map changed
        const key = "mapCreator.galleryLoaded." + it.id + "." + it.updatedAt;
        let seen = false; try { seen = sessionStorage.getItem(key) === "1"; sessionStorage.setItem(key, "1"); } catch (_) { /* */ }
        if (!seen || download) {
          const gz = new Uint8Array(await (await fetch(it.files.cells, { credentials: "same-origin" })).arrayBuffer());
          const data = await pipe(gz, new DecompressionStream("deflate"));
          if (data.length !== it.w * it.h) throw new Error("the map data is damaged");
          applyCells(it.w, it.h, data, "gallery map");
          nations = (it.nationList || []).map(n => ({ name: n.name, flag: n.flag, x: n.x, y: n.y, extra: !!n.extra })); renderNations();
          $("mapName").value = it.name; if (it.category && [...$("mapCat").options].some(o => o.value === it.category)) $("mapCat").value = it.category;
          updateMeta(); fit();
          toast("Opened “" + it.name + "” from the Map Gallery");
        }
        unbusy();
        if (download) await exportZip();
      } catch (e) { unbusy(); toast("Could not open the gallery map: " + e.message, true); }
    }
    return { load };
  })();

  // ---------- start ----------
  window.addEventListener("resize", resize);
  new ResizeObserver(resize).observe(stage);
  resize(); renderOpts(); setTerr("plains"); updateFileTree(); translateTips();
  window.addEventListener("langchange", () => {
    translateTips(); markRamp(rampM); requestDraw();
    for (const [id, , f] of WG_SLIDERS) $(id + "Val").textContent = f(+$(id).value);
    if (WG[wg.preset]) $("wgDesc").textContent = T(WG[wg.preset].name) + " · " + T(WG[wg.preset].desc);
  });
  (async () => {
    const s = await restore();
    const q = new URLSearchParams(location.search), tpl = q.get("template");
    if (s && s.cells && s.W && s.H && s.cells.length === s.W * s.H) {
      nations = s.nations || []; $("mapName").value = s.name || "My Map"; if (s.cat) $("mapCat").value = s.cat;
      setMap(s.W, s.H, new Uint8Array(s.cells));
      if (!tpl) toast("Welcome back: your last map was restored");
      restoreOverlay();
    } else {
      setMap(2000, 1500, WorldGen.generate(2000, 1500, Object.assign({}, WorldGen.PRESETS.continents, { preset: "continents", seed: 1337, sym: "none", edge: "ocean" })));
      if (!tpl && !q.has("nostart") && !q.has("generator") && !q.has("image")) openModal("startModal");
    }
    updateMeta(); renderNations(); fit();
    // Deep links: ?template=<folder> opens an official map, &view=game shows the game view.
    if (tpl && TEMPLATES.some(t => t[0] === tpl)) { $("tplSel").value = tpl; $("tplBtn").disabled = false; await openTemplate(tpl); }
    if (q.get("view") === "game") toggleGameView();
    // ?image=/path.png (same site only) opens Image to map with that picture, &mode= picks the reader.
    const imgPath = q.get("image");
    if (imgPath && imgPath.startsWith("/") && !imgPath.startsWith("//")) {
      try {
        const blob = await (await fetch(imgPath)).blob();
        await openImageToMap(blob, imgPath.split("/").pop());
        const m = q.get("mode"); if (m && document.querySelector('#i2mMode [data-m="' + m + '"]')) setI2mMode(m);
      } catch (_) { /* bad link: ignore */ }
    }
    // ?generator=<style> opens the world generator on that style.
    const gen = q.get("generator");
    if (gen !== null) openWorldGen(WorldGen.PRESETS[gen] ? gen : undefined);
    // ?gallery=<id> opens a map from the Map Gallery, &download=1 downloads its .zip.
    const galId = q.get("gallery");
    if (galId) { closeModals(); await GAL.load(galId, q.get("download") === "1"); }
  })();
})();
