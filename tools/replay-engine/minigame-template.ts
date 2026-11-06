// Nuke the Fleet (public/minigames/nuke-the-fleet.html) on the real OpenFront engine.
// Bundled for the browser per OpenFront commit by tools/build-minigame-engine.js (__ENGINE__ = that
// checkout's src/core) into public/minigames/engine/nuke-fleet-<commit>.js and run in a Web Worker.
//
// A real OpenFront Game on the Surrounded map at full (Normal) size, so distances, ship speeds and
// nuke flight times are the game's own; the page runs it at OpenFront's 10 ticks per second.
// You hold the island in the middle with a Missile Silo; the 16 islands around it belong to four
// allied enemy teams with ports, which send warships (WarshipExecution + MoveWarshipExecution) and
// troop boats (TransportShipExecution) at you, plus warships that only patrol the open sea. Bombs are NukeExecution: the real launch from your silo,
// the real parabola (rocketDirectionUp = OpenFront's U key), real speed, silo cooldown, SAM interception.
// Practice rule: a blast never touches land. NukeExecution.detonate is replaced so it only sinks the
// ships inside the bomb's outer radius (OpenFront's unit rule) and leaves territory and buildings alone.
//
// Messages in:  init {manifest, map, map4x, opts}, cmd {...}, run {tps}, pause, step {n}
// Messages out: ready {w, h, players, islands, silo}, frame {tick, units, events, silo, owners?}
import { Config } from "__ENGINE__/configuration/Config";
import { ConstructionExecution } from "__ENGINE__/execution/ConstructionExecution";
import { MoveWarshipExecution } from "__ENGINE__/execution/MoveWarshipExecution";
import { NukeExecution } from "__ENGINE__/execution/NukeExecution";
import { TransportShipExecution } from "__ENGINE__/execution/TransportShipExecution";
import { WarshipExecution } from "__ENGINE__/execution/WarshipExecution";
import { Difficulty, GameMapSize, GameMapType, GameMode, GameType, PlayerInfo, PlayerType, UnitType } from "__ENGINE__/game/Game";
import { createGame } from "__ENGINE__/game/GameImpl";
import { loadTerrainMap } from "__ENGINE__/game/TerrainMapLoader";

// unit type -> the Replay Player's unit numbering (public/js/replay-player.js UT), so the page can use its sprites
const UT: Record<string, number> = { "Transport": 1, "Warship": 2, "Shell": 3, "SAMMissile": 4, "Port": 5, "Atom Bomb": 6, "Hydrogen Bomb": 7, "Trade Ship": 8, "Missile Silo": 9, "Defense Post": 10, "SAM Launcher": 11, "City": 12, "MIRV": 13, "MIRV Warhead": 14 };
const SHIPS = new Set(["Transport", "Warship", "Trade Ship"]);
const TEAMS = ["Red", "Purple", "Orange", "Teal"];

let game: any = null, W = 0, H = 0;
let me: any, enemies: any[] = [];
let islands: { id: number; owner: string; team: number; tiles: number[]; cx: number; cy: number; shore: number[]; port?: any }[] = [];
let events: any[] = [];
let ownersDirty = true, myTiles = 0;
const nukeDone = new Set<number>(); // ids of bombs that detonated and of the ships they sank

function post(msg: any, transfer: any[] = []) { (self as any).postMessage(msg, transfer); }

// ---------- setup ----------
async function init(d: any) {
  const loader = {
    getMapData() {
      return {
        mapBin: async () => new Uint8Array(d.map), map4xBin: async () => new Uint8Array(d.map4x),
        map16xBin: async () => { throw new Error("normal size only"); },
        manifest: async () => JSON.parse(JSON.stringify(d.manifest)), webpPath: "",
        layerPng: async () => { throw new Error("no layers"); },
      } as any;
    },
  };
  const gameConfig: any = {
    gameMap: GameMapType.Surrounded, gameMapSize: GameMapSize.Normal, difficulty: Difficulty.Medium,
    donateGold: false, donateTroops: false, gameType: GameType.Singleplayer, gameMode: GameMode.FFA,
    nations: "disabled", bots: 0, infiniteGold: true, infiniteTroops: true, instantBuild: true, randomSpawn: false,
    waterNukes: false, spawnImmunityDuration: 0, disabledUnits: [],
  };
  const config = new Config(gameConfig, null, false, false);
  const map = await loadTerrainMap(GameMapType.Surrounded, GameMapSize.Normal, loader as any, false);
  const infos = [new PlayerInfo("You", PlayerType.Human, "you00000", "you00000"),
    ...TEAMS.map((t, i) => new PlayerInfo(t + " Fleet", PlayerType.Human, "enemy00" + i, "enemy00" + i))];
  game = createGame(infos, [], map.gameMap, map.miniGameMap, config);
  W = game.width(); H = game.height();
  me = game.player("you00000"); enemies = TEAMS.map((_, i) => game.player("enemy00" + i));
  // the enemy teams are allies (their warships would fight each other otherwise)
  for (let a = 0; a < enemies.length; a++) for (let b = a + 1; b < enemies.length; b++) { const r = enemies[a].createAllianceRequest(enemies[b]); if (r) r.accept(); }
  findIslands();
  // the island nearest the centre is yours; the ring is split into four teams of neighbouring islands
  const mid = islands.reduce((a, b) => (Math.hypot(a.cx - W / 2, a.cy - H / 2) < Math.hypot(b.cx - W / 2, b.cy - H / 2) ? a : b));
  mid.owner = "you"; mid.team = -1;
  const ring = islands.filter((i) => i !== mid).sort((a, b) => ang(a) - ang(b));
  ring.forEach((isl, k) => { isl.owner = "enemy"; isl.team = Math.floor(k * TEAMS.length / ring.length); });
  for (const isl of islands) {
    const p = isl.owner === "you" ? me : enemies[isl.team];
    for (const t of isl.tiles) game.conquer(p, t);
    if (!p.hasSpawned()) p.setSpawnTile(isl.tiles[0]);
  }
  myTiles = me.numTilesOwned();
  game.endSpawnPhase();
  build(me, UnitType.MissileSilo, innerTile(mid));
  // ports on the shore that faces the middle; built without PortExecution, so no trade ships ever sail
  for (const isl of ring) { const p = enemies[isl.team], at = p.canBuild(UnitType.Port, facingShore(isl)); if (at !== false) isl.port = p.buildUnit(UnitType.Port, at, {}); }
  for (let i = 0; i < 3; i++) tick();
  const silo = me.units(UnitType.MissileSilo)[0];
  if (silo && d.opts?.siloLevel > 1) while (silo.level() < d.opts.siloLevel) silo.increaseLevel();
  patchNukes();
  post({
    type: "ready", w: W, h: H,
    players: [me, ...enemies].map((p, i) => ({ sid: p.smallID(), name: p.name(), role: i === 0 ? "you" : "enemy", team: i - 1 })),
    islands: islands.map((i) => ({ id: i.id, owner: i.owner, team: i.team, cx: Math.round(i.cx), cy: Math.round(i.cy), n: i.tiles.length, port: i.port ? { x: game.x(i.port.tile()), y: game.y(i.port.tile()) } : null })),
    silo: silo ? { x: game.x(silo.tile()), y: game.y(silo.tile()), level: silo.level() } : null,
  });
  sendFrame(true);
}
const ang = (i: any) => Math.atan2(i.cy - H / 2, i.cx - W / 2);
function build(p: any, type: UnitType, tile: number) { game.addExecution(new ConstructionExecution(p, type, tile)); }

// Practice blast: OpenFront's unit rule only (every ship within the outer radius sinks), no land touched.
function patchNukes() {
  const proto: any = NukeExecution.prototype;
  proto.detonate = function () {
    const nuke = this.nuke, dst = this.dst, mag = game.config().nukeMagnitudes(nuke.type()), outer2 = mag.outer * mag.outer;
    const killed: any[] = [];
    for (const u of game.units()) {
      if (!SHIPS.has(u.type()) || !u.isActive()) continue;
      if (game.euclideanDistSquared(dst, u.tile()) < outer2) {
        killed.push({ id: u.id(), type: UT[u.type()] || 0, owner: u.owner().smallID(), x: game.x(u.tile()), y: game.y(u.tile()) });
        nukeDone.add(u.id());
        u.delete(true, this.player);
      }
    }
    this.active = false;
    nuke.setReachedTarget();
    nuke.delete(false);
    nukeDone.add(nuke.id());
    events.push({ k: "det", id: nuke.id(), type: UT[nuke.type()], owner: nuke.owner().smallID(), x: game.x(dst), y: game.y(dst), inner: mag.inner, outer: mag.outer, killed });
  };
}

// Land components; the ones that do not touch the map edge are the islands (the land outside the
// sea circle touches the edge).
function findIslands() {
  const seen = new Uint8Array(W * H), list: any[] = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] || !game.isLand(s)) continue;
    const tiles: number[] = [], q = [s]; seen[s] = 1; let edge = false;
    while (q.length) {
      const t = q.pop()!; tiles.push(t);
      const x = game.x(t), y = game.y(t); if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
      for (const n of game.neighbors(t)) if (!seen[n] && game.isLand(n)) { seen[n] = 1; q.push(n); }
    }
    if (!edge && tiles.length > 5000) {
      let sx = 0, sy = 0; for (const t of tiles) { sx += game.x(t); sy += game.y(t); }
      list.push({ id: list.length, owner: "", team: -1, tiles, cx: sx / tiles.length, cy: sy / tiles.length, shore: tiles.filter((t) => game.isOceanShore(t)) });
    }
  }
  islands = list;
}
// a land tile deep inside the island, near its centre
function innerTile(isl: any) {
  let best = isl.tiles[0], bd = -1e9;
  const shore = isl.shore.filter((_: any, i: number) => i % 3 === 0);
  for (let k = 0; k < isl.tiles.length; k += 11) {
    const t = isl.tiles[k], x = game.x(t), y = game.y(t); let d = 1e9;
    for (const s of shore) { const dd = Math.abs(game.x(s) - x) + Math.abs(game.y(s) - y); if (dd < d) d = dd; }
    const score = Math.min(d, 60) - Math.hypot(x - isl.cx, y - isl.cy) * 0.5;
    if (score > bd) { bd = score; best = t; }
  }
  return best;
}
// the shore tile of an island closest to the map centre
function facingShore(isl: any) {
  let best = isl.shore[0], bd = 1e9;
  for (const t of isl.shore) { const d = Math.hypot(game.x(t) - W / 2, game.y(t) - H / 2); if (d < bd) { bd = d; best = t; } }
  return best;
}
function seaNear(x: number, y: number, r = 8) {
  let best = -1, bd = 1e9;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
    const t = game.ref(xx, yy); if (!game.isWater(t)) continue;
    const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = t; }
  }
  return best;
}
const clampX = (x: number) => Math.max(0, Math.min(W - 1, Math.round(x)));
const clampY = (y: number) => Math.max(0, Math.min(H - 1, Math.round(y)));

// ---------- commands from the page ----------
const pendingMoves: { ex: any; owner: any; to: number; at: number }[] = [];
function cmd(c: any) {
  switch (c.op) {
    case "nuke": { // your silo launches an Atom (a) or Hydrogen (h) bomb at x,y; up = the arc bends north (U key)
      const type = c.kind === "h" ? UnitType.HydrogenBomb : UnitType.AtomBomb, t = game.ref(clampX(c.x), clampY(c.y));
      if (me.canBuild(type, t) === false) { events.push({ k: "nofire", kind: c.kind }); break; }
      game.addExecution(new NukeExecution(type, me, t, null, -1, 0, c.up !== false));
      events.push({ k: "fired", kind: c.kind, x: c.x, y: c.y });
      break;
    }
    case "warship": { // a warship leaves the port of island c.island and sails to x,y (near your coast)
      const isl = islands.find((i) => i.id === c.island); if (!isl || !isl.port || !isl.port.isActive()) break;
      const owner = enemies[isl.team], start = seaNear(game.x(isl.port.tile()), game.y(isl.port.tile()));
      if (start < 0) break;
      const ex = new WarshipExecution({ owner, patrolTile: start } as any);
      game.addExecution(ex);
      pendingMoves.push({ ex, owner, to: game.ref(clampX(c.x), clampY(c.y)), at: game.ticks() });
      break;
    }
    case "patrol": { // a warship that only patrols the sea around x,y (OpenFront's own patrol behaviour)
      const isl = islands.find((i) => i.id === c.island); if (!isl || !isl.port || !isl.port.isActive()) break;
      const to = seaNear(clampX(c.x), clampY(c.y), 12); if (to < 0) break;
      const ex = new WarshipExecution({ owner: enemies[isl.team], patrolTile: to } as any);
      game.addExecution(ex);
      pendingMoves.push({ ex, owner: enemies[isl.team], to: -1, at: game.ticks() });
      break;
    }
    case "transport": { // a boat with troops from team c.team heads for your shore at x,y
      const owner = enemies[c.team % enemies.length];
      game.addExecution(new TransportShipExecution(owner, game.ref(clampX(c.x), clampY(c.y)), c.troops || 1000));
      break;
    }
    case "remove": { const u = game.units().find((u: any) => u.id() === c.id); if (u && u.isActive()) { nukeDone.add(u.id()); u.delete(false); } break; }
    case "sam": { // an enemy SAM launcher next to the port of island c.island
      const isl = islands.find((i) => i.id === c.island); if (!isl || !isl.port) break;
      const px = game.x(isl.port.tile()), py = game.y(isl.port.tile()), dx = isl.cx - px, dy = isl.cy - py, L = Math.hypot(dx, dy) || 1;
      build(enemies[isl.team], UnitType.SAMLauncher, game.ref(clampX(px + dx / L * 25), clampY(py + dy / L * 25)));
      break;
    }
    case "siloLevel": { const s = me.units(UnitType.MissileSilo)[0]; if (s) while (s.level() < c.level) s.increaseLevel(); break; }
  }
}

// ---------- ticking ----------
function tick() {
  game.executeNextTick();
  for (let i = pendingMoves.length - 1; i >= 0; i--) {
    const m = pendingMoves[i], ship = m.ex.warship;
    if (!ship && game.ticks() - m.at < 5) continue; // not built yet (or it could not be built: dropped)
    if (ship && ship.isActive() && m.to < 0) events.push({ k: "pw", id: ship.id() });
    else if (ship && ship.isActive()) { game.addExecution(new MoveWarshipExecution(m.owner, [ship.id()], m.to)); events.push({ k: "ws", id: ship.id(), tx: game.x(m.to), ty: game.y(m.to) }); }
    pendingMoves.splice(i, 1);
  }
  // a boat that got ashore took some of your land: give it back (land never changes in this game)
  if (game.ticks() % 10 === 0 && me.numTilesOwned() < myTiles) {
    const mid = islands.find((i) => i.owner === "you")!;
    for (const t of mid.tiles) if (game.owner(t) !== me) game.conquer(me, t);
    ownersDirty = true;
  }
}
let lastUnits = new Map<number, number>();
function sendFrame(forceOwners = false) {
  const list: number[] = [], alive = new Map<number, number>();
  for (const u of game.units()) {
    const ty = UT[u.type()]; if (!ty || !u.isActive()) continue;
    const t = u.tile(), tgt = u.targetTile?.();
    alive.set(u.id(), ty);
    list.push(u.id(), ty, u.owner().smallID(), game.x(t), game.y(t), tgt === undefined || tgt === null ? -1 : tgt, Math.round(u.health?.() ?? 0), u.level?.() ?? 1);
  }
  // units gone since the last frame without a blast: boats that landed, bombs shot down by a SAM
  for (const [id, ty] of lastUnits) if (!alive.has(id) && !nukeDone.has(id)) events.push({ k: "gone", id, type: ty });
  lastUnits = alive;
  // silo: how many bombs it can launch now (one per level, each slot cools down SiloCooldown ticks)
  const silo = me.units(UnitType.MissileSilo)[0];
  const q = silo ? silo.missileTimerQueue() : [], cd = game.config().SiloCooldown();
  const siloState = silo ? { level: silo.level(), ready: Math.max(0, silo.level() - q.length), next: q.length ? Math.max(0, cd - (game.ticks() - Math.min(...q))) : 0, cd } : null;
  const msg: any = { type: "frame", tick: game.ticks(), units: Int32Array.from(list), events, silo: siloState };
  const tr: any[] = [msg.units.buffer];
  if (ownersDirty || forceOwners) {
    ownersDirty = false;
    const own = new Uint8Array(W * H);
    for (let t = 0; t < W * H; t++) own[t] = game.ownerID(t);
    msg.owners = own; tr.push(own.buffer);
  }
  post(msg, tr);
  events = [];
}

let timer: any = null, tps = 10;
function run(rate: number) {
  stop(); tps = rate;
  let acc = 0, last = performance.now();
  timer = setInterval(() => {
    const now = performance.now(); acc += (now - last) * tps / 1000; last = now;
    let n = 0;
    while (acc >= 1 && n < 4) { acc -= 1; n++; try { tick(); } catch (e: any) { post({ type: "error", error: String(e?.stack || e) }); stop(); return; } }
    if (acc > 4) acc = 0;
    if (n) sendFrame();
  }, 1000 / Math.max(tps, 10) / 2);
}
function stop() { if (timer) clearInterval(timer); timer = null; }

(self as any).onmessage = async (e: any) => {
  const d = e.data;
  try {
    if (d.type === "init") await init(d);
    else if (d.type === "cmd") for (const c of [].concat(d.cmd)) cmd(c);
    else if (d.type === "run") run(d.tps || 10);
    else if (d.type === "pause") stop();
    else if (d.type === "step") { for (let i = 0; i < (d.n || 1); i++) tick(); sendFrame(); }
  } catch (err: any) { post({ type: "error", error: String(err?.stack || err) }); }
};
