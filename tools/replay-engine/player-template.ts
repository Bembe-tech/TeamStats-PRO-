// Replay Player recorder, bundled once per OpenFront commit (see replay-player-engine.js):
// __ENGINE__ / __CLIENT__ are replaced with that checkout's src/core and src/client paths.
// Reads a full game record (JSON on stdin), replays every turn with the real game engine
// and writes everything the site's Replay Player draws, taken from the same update
// stream the OpenFront client renders from:
//   - terrain bytes (full map resolution)
//   - tile owner / fallout changes every FRAME ticks, full resolution (run-length coded)
//   - units (structures, ships, trains, nukes) as per-frame state deltas
//   - railroad construction / destruction / snap events with their tiles
//   - OpenFront's own name placement (x, y, size) per player
//   - per-player tiles / troops / gold every STAT ticks, conquest events
//   - player colours from OpenFront's own theme (same allocator order as the client)
import * as fs from "fs";
import * as zlib from "zlib";
import * as path from "path";
import { createGameRunner } from "__ENGINE__/GameRunner";
import { decompressGameRecord } from "__ENGINE__/Util";
import { GameMapType, PlayerType } from "__ENGINE__/game/Game";
import { GameUpdateType } from "__ENGINE__/game/GameUpdates";
import { NukeExecution } from "__ENGINE__/execution/NukeExecution";
import { AttackExecution } from "__ENGINE__/execution/AttackExecution";
import { AllianceRejectExecution } from "__ENGINE__/execution/alliance/AllianceRejectExecution";
import { AllianceRequestExecution } from "__ENGINE__/execution/alliance/AllianceRequestExecution";
import { SettingsTheme } from "__CLIENT__/theme/ThemeProvider";
import { createThemeSettings } from "__CLIENT__/render/gl/RenderSettings";

const [mapsDir, outFile, frameArg, liveFile] = process.argv.slice(2);
const FRAME = Number(frameArg) || 2, STAT = 10;

function loader() {
  const read = (key: string, f: string) => async () => new Uint8Array(fs.readFileSync(path.join(mapsDir, key, f)));
  return {
    getMapData(map: GameMapType) {
      const key = Object.keys(GameMapType).find((k) => (GameMapType as any)[k] === map)!.toLowerCase();
      return {
        mapBin: read(key, "map.bin"), map4xBin: read(key, "map4x.bin"), map16xBin: read(key, "map16x.bin"),
        manifest: async () => JSON.parse(fs.readFileSync(path.join(mapsDir, key, "manifest.json"), "utf8")),
        webpPath: "", layerPng: async () => { throw new Error("no layers in headless mode"); },
      } as any;
    },
  };
}

// growable byte writer with LEB128 varints
class Out {
  buf = Buffer.alloc(1 << 20); n = 0;
  need(k: number) { if (this.n + k > this.buf.length) { const b = Buffer.alloc(Math.max(this.buf.length * 2, this.n + k)); this.buf.copy(b, 0, 0, this.n); this.buf = b; } }
  v(x: number) { this.need(5); while (x >= 0x80) { this.buf[this.n++] = (x & 0x7f) | 0x80; x >>>= 7; } this.buf[this.n++] = x; }
  bytes() { return this.buf.subarray(0, this.n); }
}

const UT: Record<string, number> = { "Transport": 1, "Warship": 2, "Shell": 3, "SAMMissile": 4, "Port": 5, "Atom Bomb": 6, "Hydrogen Bomb": 7, "Trade Ship": 8, "Missile Silo": 9, "Defense Post": 10, "SAM Launcher": 11, "City": 12, "MIRV": 13, "MIRV Warhead": 14, "Train": 15, "Factory": 16 };
const TT: Record<string, number> = { Engine: 1, TailEngine: 2, Carriage: 3 };

async function main() {
  const record = JSON.parse(fs.readFileSync(0, "utf8"));
  const t0 = Date.now();
  decompressGameRecord(record);

  const cur = { tick: 0 };
  const dirty: number[] = [];
  const rails: any[] = [], events: any[] = [], names: any[] = [];
  let spawnEnd = 0;
  const allyExp = new Map<any, number>(), dcState = new Map<number, boolean>();
  const RC = (GameUpdateType as any).RailroadConstructionEvent, RD = (GameUpdateType as any).RailroadDestructionEvent, RS = (GameUpdateType as any).RailroadSnapEvent;
  const ARQ = (GameUpdateType as any).AllianceRequest, AEX = (GameUpdateType as any).AllianceExtension;
  const ALR = (GameUpdateType as any).AllianceRequestReply, ALB = (GameUpdateType as any).BrokeAlliance, ALX = (GameUpdateType as any).AllianceExpired;
  const DON = (GameUpdateType as any).DonateEvent;
  const CQ = (GameUpdateType as any).ConquestEvent, SPE = (GameUpdateType as any).SpawnPhaseEnd, WIN = (GameUpdateType as any).Win;
  let game: any = null;
  const sidOf = (pid: any) => { try { const p = game.player(pid); return p ? p.smallID() : 0; } catch { return 0; } };
  const onUpdate = (gu: any) => {
    if (!gu || gu.errMsg) return;
    cur.tick = gu.tick;
    const p = gu.packedTileUpdates;
    if (p) for (let i = 0; i < p.length; i += 2) dirty.push(p[i]);
    const u = gu.updates || {};
    for (const e of (RC !== undefined && u[RC]) || []) rails.push([gu.tick, "c", e.id, Array.from(e.tiles)]);
    for (const e of (RD !== undefined && u[RD]) || []) rails.push([gu.tick, "d", e.id]);
    for (const e of (RS !== undefined && u[RS]) || []) rails.push([gu.tick, "s", e.originalId, e.newId1, Array.from(e.tiles1), e.newId2, Array.from(e.tiles2)]);
    for (const e of (CQ !== undefined && u[CQ]) || []) events.push([gu.tick, "k", sidOf(e.conquerorId), sidOf(e.conqueredId)]);
    if (SPE !== undefined && (u[SPE] || []).length && !spawnEnd) spawnEnd = gu.tick;
    for (const e of (WIN !== undefined && u[WIN]) || []) events.push([gu.tick, "w", e.winner]);
    // alliances (small IDs): formed, broken (traitor first), expired
    // alliance requests sent: [tick, "ar", from, to]; extension clicks: [tick, "ext", player, alliance id]
    for (const e of (ARQ !== undefined && u[ARQ]) || []) events.push([gu.tick, "ar", e.requestorID, e.recipientID]);
    for (const e of (AEX !== undefined && u[AEX]) || []) events.push([gu.tick, "ext", e.playerID, e.allianceID]);
    for (const e of (ALR !== undefined && u[ALR]) || []) if (e.accepted && e.request) events.push([gu.tick, "al", e.request.requestorID, e.request.recipientID]);
    for (const e of (ALB !== undefined && u[ALB]) || []) events.push([gu.tick, "ab", e.traitorID, e.betrayedID]);
    for (const e of (ALX !== undefined && u[ALX]) || []) events.push([gu.tick, "ax", e.player1ID, e.player2ID]);
    // donations: [tick, "dn", from, to, 1 = gold / 0 = troops, amount]
    for (const e of (DON !== undefined && u[DON]) || []) events.push([gu.tick, "dn", sidOf(e.senderId), sidOf(e.recipientId), e.donationType === "gold" ? 1 : 0, Number(e.amount)]);
    // alliance expiry times: [tick, "ae", a, b, expiresAt] whenever an alliance appears or is extended
    if (game && gu.tick % 5 === 0) {
      try {
        for (const pl of game.players()) for (const al of pl.alliances()) {
          const exp = al.expiresAt(), id = al.id(); if (allyExp.get(id) === exp) continue; allyExp.set(id, exp);
          events.push([gu.tick, "ae", al.requestor().smallID(), al.recipient().smallID(), exp]);
        }
      } catch {}
      // players who left the game (disconnected) or came back: [tick, "dc", sid, 1 | 0]
      try {
        for (const pl of game.players()) { const d = !!pl.isDisconnected?.(), sid = pl.smallID(); if ((dcState.get(sid) || false) !== d) { dcState.set(sid, d); events.push([gu.tick, "dc", sid, d ? 1 : 0]); } }
      } catch {}
    }
    if (gu.playerNameViewData && game) {
      const snap: any[] = [];
      for (const [pid, nv] of Object.entries<any>(gu.playerNameViewData)) { const sid = sidOf(pid); if (sid && nv) snap.push([sid, Math.round(nv.x), Math.round(nv.y), Math.round(nv.size * 10) / 10]); }
      names.push([gu.tick, snap]);
    }
  };
  const runner = await createGameRunner(record.info, undefined, loader() as any, onUpdate);
  game = runner.game;
  const agg = hookStats(game);
  // how each alliance request ended: [tick, "rq", from, to, a accepted | r rejected (clicked) | x expired (no answer) | c cancelled (attack, nuke...), ticks it was open]
  {
    let why = "";
    const wrapProto = (C: any, m: string, tag: string) => { const p = C?.prototype; if (!p || typeof p[m] !== "function") return; const o = p[m]; p[m] = function (this: any) { const w = why; why = tag; try { return o.apply(this, arguments as any); } finally { why = w; } }; };
    wrapProto(AllianceRejectExecution, "init", "r"); wrapProto(AllianceRequestExecution, "tick", "x");
    const rq = (req: any, out: string) => { try { events.push([game.ticks(), "rq", req.requestor().smallID(), req.recipient().smallID(), out, game.ticks() - Number(req.createdAt())]); } catch {} };
    if (typeof game.acceptAllianceRequest === "function") { const o = game.acceptAllianceRequest; game.acceptAllianceRequest = function (req: any) { rq(req, "a"); return o.apply(this, arguments as any); }; }
    if (typeof game.rejectAllianceRequest === "function") { const o = game.rejectAllianceRequest; game.rejectAllianceRequest = function (req: any) { rq(req, why || "c"); return o.apply(this, arguments as any); }; }
  }
  const W = game.width(), H = game.height(), N = W * H;
  const gmap: any = game.map();
  const terrain: Uint8Array = gmap.terrain;
  const STATE_MASK = 0xfff | (1 << 13); // owner smallID + fallout bit
  const shown = new Uint16Array(N); // state last written to the file
  const mark = new Uint32Array(N); let stamp = 0;

  // ---- territory frames ----
  const terr = new Out(), frameTicks: number[] = [];
  const writeFrame = () => {
    stamp++;
    const idx: number[] = [];
    for (const t of dirty) { if (mark[t] === stamp) continue; mark[t] = stamp; const s = gmap.state ? gmap.state[t] & STATE_MASK : (game.ownerID(t) | (game.hasFallout?.(t) ? 1 << 13 : 0)); if (s !== shown[t]) idx.push(t); }
    dirty.length = 0;
    idx.sort((a, b) => a - b);
    // runs of consecutive cells with the same new value
    const runs: number[] = [];
    let pos = 0;
    for (let k = 0; k < idx.length;) {
      const start = idx[k], val = gmap.state ? gmap.state[start] & STATE_MASK : 0;
      let len = 1;
      while (k + len < idx.length && idx[k + len] === start + len && (gmap.state[idx[k + len]] & STATE_MASK) === val) len++;
      runs.push(start - pos, len, val);
      for (let j = 0; j < len; j++) shown[start + j] = val;
      pos = start + len; k += len;
    }
    terr.v(runs.length / 3); for (const r of runs) terr.v(r);
    frameTicks.push(cur.tick);
  };

  // ---- units ----
  // Every UNIT_EVERY ticks: JSON [tick, full[], removed[]] (new or changed units) and, in a
  // binary section, the moves of units whose only change is their tile:
  // count, then per move (id gap, dx, dy) as varints (zigzag for dx / dy), sorted by id.
  const UNIT_EVERY = 2; // smooth units at x1 (was 4)
  const units: any[] = [], mv = new Out();
  const zz = (n: number) => (n << 1) ^ (n >> 31);
  const last = new Map<number, string>(), lastTile = new Map<number, number>();
  const snapUnits = () => {
    const full: any[] = [], moves: number[] = [], removed: number[] = [];
    const seen = new Set<number>();
    for (const u of game.units()) {
      const id = u.id(); seen.add(id); agg.seen(u);
      if (!u.isActive?.() && u.isActive) continue;
      const tile = u.tile();
      const tt = u.trainType?.();
      const flags = (u.isUnderConstruction?.() ? 1 : 0) | (u.hasTrainStation?.() ? 2 : 0) | (u.isLoaded?.() ? 4 : 0) | (u.reachedTarget?.() ? 8 : 0);
      const target = u.targetTile?.() ?? -1;
      // warships: veterancy (0-3) and health in tenths, for the rank pips and the health bar
      const ws = u.type() === "Warship", vet = ws ? Number(u.veterancy?.() ?? 0) : 0;
      const hp = ws && u.maxHealth ? Math.max(0, Math.min(10, Math.round(10 * Number(u.health?.() ?? 0) / Math.max(1, Number(u.maxHealth()))))) : 10;
      const key = [UT[u.type()] || 0, u.owner().smallID(), u.level?.() ?? 1, flags, tt ? TT[tt] || 0 : 0, target, vet, hp].join(",");
      if (last.get(id) !== key) { last.set(id, key); lastTile.set(id, tile); full.push([id, tile, ...key.split(",").map(Number)]); }
      else if (lastTile.get(id) !== tile) { moves.push(id, tile, lastTile.get(id)!); lastTile.set(id, tile); }
    }
    for (const id of last.keys()) if (!seen.has(id)) { removed.push(id); last.delete(id); lastTile.delete(id); }
    units.push([cur.tick, full, removed]);
    const order: number[] = []; for (let k = 0; k < moves.length; k += 3) order.push(k);
    order.sort((a, b) => moves[a] - moves[b]);
    mv.v(order.length); let prevId = 0;
    for (const k of order) {
      const id = moves[k], to = moves[k + 1], from = moves[k + 2];
      const dx = (to % W) - (from % W), dy = Math.floor(to / W) - Math.floor(from / W);
      mv.v(id - prevId); mv.v(zz(dx)); mv.v(zz(dy)); prevId = id;
    }
  };

  // ---- player stats ----
  const stats: any[] = [];
  const snapStats = () => {
    const rows: number[] = [];
    // bots (often hundreds) only every 5th sample; humans and nations every sample
    const withBots = cur.tick % (STAT * 5) === 0;
    for (const p of game.allPlayers()) { const tiles = p.numTilesOwned(); if (!tiles && !p.isAlive()) continue; if (!withBots && p.type() === PlayerType.Bot) continue; rows.push(p.smallID(), tiles, Math.round(p.troops()), Math.round(Number(p.gold()))); }
    stats.push([cur.tick, rows]);
  };


  const makeHeader = () => {
  // ---- players & colours (OpenFront theme, allocated in the client's order) ----
  const theme: any = new SettingsTheme(createThemeSettings("default"));
  // second theme for the "classicBotColors" graphics setting: teamless tribes from the classic bot pool
  const classicTheme: any = new SettingsTheme(createThemeSettings("default"));
  const hasClassic = "useClassicBotColors" in classicTheme; if (hasClassic) classicTheme.useClassicBotColors = true;
  const recPlayers = new Map<string, any>((record.info.players || []).map((p: any) => [p.clientID, p]));
  const players: any[] = [];
  const teamMode = game.allPlayers().some((p: any) => p.team?.() != null && p.type() !== PlayerType.Bot);
  for (const p of game.allPlayers()) {
    const view = { team: () => p.team?.() ?? null, type: () => p.type(), id: () => p.id() };
    const base = theme.territoryColor(view);
    const cid = p.clientID?.() || null;
    const cos = cid ? recPlayers.get(cid)?.cosmetics || {} : {};
    const pattern = cos.pattern;
    const border0 = theme.borderColor(base);
    let fill = base, border = border0, classic: any = null;
    if (hasClassic && p.type() === PlayerType.Bot && view.team() === null) { const c = classicTheme.territoryColor(view); classic = { fill: c.toHex(), border: classicTheme.borderColor(c).toHex() }; }
    if (view.team() === null) fill = colorOf(cos.color?.color ?? pattern?.colorPalette?.primaryColor, base);
    border = colorOf(pattern?.colorPalette?.secondaryColor ?? cos.color?.color, border0);
    players.push({
      sid: p.smallID(), id: p.id(), cid, name: p.name(), display: p.displayName?.() ?? p.name(), clan: recPlayers.get(cid)?.clanTag ?? null,
      type: p.type(), team: view.team(), fill: fill.toHex(), border: border.toHex(),
      pattern: pattern?.patternData ? { d: pattern.patternData } : null, flag: cos.flag || null, classic,
      spawn: p.spawnTile?.() ?? null,
    });
  }
  function colorOf(hex: string | undefined, fallback: any) { if (!hex) return fallback; try { const c = new fallback.constructor(hex); return c.isValid() ? c : fallback; } catch { return fallback; } }
  return {
    v: 1, gameId: record.info.gameID, start: record.info.start ?? null, end: record.info.end ?? null, gitCommit: record.gitCommit, map: record.info.config?.gameMap, mode: record.info.config?.gameMode,
    width: W, height: H, frame: FRAME, stat: STAT, ticks: game.ticks(), spawnEnd, land: game.numLandTiles(), teamMode,
    teamColors: Object.fromEntries([...new Set(players.map((p) => p.team).filter((t) => t != null))].map((t) => [t, theme.teamColor(t).toHex()])),
    players, frameTicks,
  };
  };

  // ---- live stream (argv[4]): the replay in pieces while it is being computed, so the site can play it at once.
  // File = frames of [u32 length][gzip(piece)]; piece = [u32 json length][json][u32 a][a bytes][u32 b][b bytes].
  // First piece {k:"h"} after the spawn phase: header (players, colours) + terrain bytes. Then every LIVE_EVERY
  // ticks {k:"c"} with what is new: frameTicks, units, rails, names, stats, events + territory and move bytes.
  // The last piece also has end: { ticks, summary }. The finished .bin.gz is still written as before.
  const LIVE_EVERY = 300, LIVE_FIRST = 60; let liveSent = false, liveLast = 0; // a short first piece: the player starts sooner
  const lc = { terr: 0, mv: 0, frames: 0, units: 0, rails: 0, names: 0, stats: 0, events: 0 };
  const u32l = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const piece = (json: any, a: Uint8Array, b: Uint8Array) => {
    const j = Buffer.from(JSON.stringify(json)), body = zlib.gzipSync(Buffer.concat([u32l(j.length), j, u32l(a.length), Buffer.from(a), u32l(b.length), Buffer.from(b)]), { level: 1 });
    fs.appendFileSync(liveFile, Buffer.concat([u32l(body.length), body]));
  };
  const live = (t: number, last = false) => {
    try {
      if (!liveSent) { if (!spawnEnd && !last) return; const h: any = makeHeader(); h.frameTicks = []; h.ticks = t; h.ticksTotal = Number(record.info?.num_turns) || record.turns.length; h.live = true; piece({ k: "h", header: h }, terrain, new Uint8Array(0)); liveSent = true; liveLast = t; }
      if (!last && t - liveLast < (lc.frames ? LIVE_EVERY : LIVE_FIRST)) return;
      liveLast = t;
      const tb = terr.bytes(), mb = mv.bytes();
      const part: any = { k: "c", tick: t, frameTicks: frameTicks.slice(lc.frames), units: units.slice(lc.units), rails: rails.slice(lc.rails), names: names.slice(lc.names), stats: stats.slice(lc.stats), events: events.slice(lc.events) };
      if (last) part.end = { ticks: game.ticks(), spawnEnd, summary: agg.out() };
      piece(part, tb.subarray(lc.terr), mb.subarray(lc.mv));
      Object.assign(lc, { terr: tb.length, mv: mb.length, frames: frameTicks.length, units: units.length, rails: rails.length, names: names.length, stats: stats.length, events: events.length });
    } catch (e: any) { console.error("live: " + (e?.message || e)); }
  };
  for (const turn of record.turns) runner.addTurn(turn);
  let guard = 0;
  while (runner.executeNextTick() !== false && guard++ < 200000) {
    const t = game.ticks();
    agg.tick();
    if (!spawnEnd && !game.inSpawnPhase()) spawnEnd = t;
    if (t % FRAME === 0) writeFrame();
    if (t % UNIT_EVERY === 0) snapUnits();
    if (t % STAT === 0) snapStats();
    if (t % (STAT * 5) === 0) agg.worth();
    if (spawnEnd) agg.anTick(t);
    if (liveFile) live(t);
  }
  writeFrame(); snapUnits(); snapStats();
  if (liveFile) live(game.ticks(), true);

  const header = Buffer.from(JSON.stringify(makeHeader()));
  const timeline = Buffer.from(JSON.stringify({ unitEvery: UNIT_EVERY, units, rails, names, stats, events, summary: agg.out() }));
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const terrBytes = terr.bytes(), mvBytes = mv.bytes();
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat([u32(header.length), header, u32(terrain.length), Buffer.from(terrain), u32(terrBytes.length), terrBytes, u32(timeline.length), timeline, u32(mvBytes.length), mvBytes]), { level: 6 }));
  console.log(JSON.stringify({ ok: true, frames: frameTicks.length, ticks: game.ticks(), terr: terrBytes.length, timeline: timeline.length, moves: mvBytes.length, ms: Date.now() - t0 }));
}
// ---- match summary: every call the engine makes into its Stats object (OpenFront itself keeps
// these only for humans), counted per player for everybody, plus who earned trade gold with whom.
// Rows: [method, sid, otherSid (0 = none), type ("" = none), calls, sum of the first number argument].
// Trains: the station owner's trainExternalTrade comes right before the train owner's trainSelfTrade
// for the same stop and amount, so the pair gives "trainPair" rows [train owner, station owner].
// goldWork (every player, every tick) goes to a plain per-sid total instead.
function hookStats(game: any) {
  const st: any = game.stats?.();
  const rows = new Map<string, any[]>(), work = new Map<number, number>();
  const SKIP = new Set(["getPlayerStats", "stats", "numMirvsLaunched", "lobbyFillTime", "recordTickSample", "recordKilledBy", "recordDeathPosition", "recordFinalTiles", "recordAlliancesAtEnd", "attackMaxIncoming", "constructor"]);
  const isP = (x: any) => x && typeof x === "object" && typeof x.smallID === "function";
  const add = (m: string, a: number, b: number, type: string, v: number) => {
    const k = m + "|" + a + "|" + b + "|" + type; let r = rows.get(k);
    if (!r) rows.set(k, r = [m, a, b, type, 0, 0, 0]);
    r[4]++; r[5] += v; if (v > r[6]) r[6] = v; // r[6]: largest single amount
  };
  const cost = (type: string, p: any) => { try { return Number(game.config().unitInfo(type).cost(game, p)); } catch { return 0; } };
  let pend: any = null;
  const atk: any[] = [], an: any[] = []; let anEvery = 0;
  if (st) {
    const proto = Object.getPrototypeOf(st);
    for (const m of Object.getOwnPropertyNames(proto)) {
      const orig = st[m]; if (typeof orig !== "function" || SKIP.has(m) || m.startsWith("_")) continue;
      if (m === "goldWork") { st[m] = function (p: any, g: any) { try { const s = p.smallID(); work.set(s, (work.get(s) || 0) + Number(g)); } catch {} return orig.apply(this, arguments as any); }; continue; }
      st[m] = function (...args: any[]) {
        try {
          const ps: number[] = []; let type = "", v: number | null = null;
          for (const x of args) {
            if (isP(x)) ps.push(x.smallID());
            else if (typeof x === "string") type = x;
            else if ((typeof x === "number" || typeof x === "bigint") && v === null) v = Number(x);
            else if (x && typeof x === "object") ps.push(0); // TerraNullius
          }
          const a = ps[0] || 0, b = ps[1] || 0;
          if (m === "trainExternalTrade") pend = { s: a, v };
          else if (m === "trainSelfTrade") { if (pend && pend.v === v && pend.s !== a) add("trainPair", a, pend.s, "", v || 0); pend = null; }
          // what the launch cost (the price at that moment)
          if (m === "bombLaunch" && isP(args[0])) add("nukeSpend", a, 0, type, cost(type, args[0]));
          // every attack a human / nation launches, with its tick: [tick, attacker, target (0 = wilderness), troops]
          if (m === "attack" && isP(args[0]) && args[0].type() !== "BOT") atk.push([game.ticks(), a, b, Math.round(v || 0)]);
          if (m === "attack" && isP(args[0]) && isP(args[1])) { try { if (args[1].outgoingAttacks().some((x: any) => x.target() === args[0])) add("attackCounter", a, b, "", v || 0); } catch {} }
          add(m, a, b, type, v || 0);
        } catch {}
        return orig.apply(this, args);
      };
    }
  }

  // ---- warships and nukes: patched on the unit class (found from the first unit) and on NukeExecution ----
  // warships: [id, owner, born, end (-1 alive), killedBy, veterancy, tick of level 1, 2, 3 (-1 none), healed,
  //            damage taken, warships sunk, transports sunk, trade ships captured]
  // heatmaps: where each player's trade ships and warships were, every HEAT_EVERY ticks, on a coarse grid
  const HEAT_EVERY = 10, HW = game.width(), HCOLS = Math.min(320, HW), HROWS = Math.max(1, Math.round(HCOLS * game.height() / HW));
  // tr / ws: ship positions; at / ll: land taken from / lost to another player by attacks; pc / pv: trade ships captured / lost to pirates
  const heat: Record<string, Map<number, Map<number, number>>> = { tr: new Map(), ws: new Map(), at: new Map(), ll: new Map(), pc: new Map(), pv: new Map() };
  const heatAdd = (m: Map<number, Map<number, number>>, sid: number, tile: number) => {
    const x = tile % HW, y = Math.floor(tile / HW), c = Math.min(HROWS - 1, Math.floor(y * HROWS / game.height())) * HCOLS + Math.min(HCOLS - 1, Math.floor(x * HCOLS / HW));
    let g = m.get(sid); if (!g) m.set(sid, g = new Map()); g.set(c, (g.get(c) || 0) + 1);
  };
  const ws = new Map<number, any[]>();
  const wsOf = (u: any) => { const id = u.id(); let w = ws.get(id); if (!w) ws.set(id, w = [id, u.owner().smallID(), game.ticks(), -1, 0, 0, -1, -1, -1, 0, 0, 0, 0, 0]); return w; };
  const NUKES = new Set(["Atom Bomb", "Hydrogen Bomb", "MIRV Warhead", "MIRV"]);
  const trips = new Map<number, number[]>(); // trade ship id -> [first tick seen, owner]
  let unitsHooked = false, playersHooked = false;
  const STRUCT_T = new Set(["City", "Port", "Factory", "Defense Post", "SAM Launcher", "Missile Silo"]), paid_ = new Map<number, number>(), worth: any[] = [];
  const hookPlayers = (proto: any) => {
    playersHooked = true;
    const oc = proto.conquer;
    if (typeof oc === "function") proto.conquer = function (this: any, tile: number) {
      try { if (curAtk && curAtk._owner === this) { const prev = game.owner(tile); if (prev?.isPlayer?.() && prev !== this) { heatAdd(heat.at, this.smallID(), tile); heatAdd(heat.ll, prev.smallID(), tile); } } } catch {}
      return oc.apply(this, arguments as any);
    };
    // net worth: gold actually paid for each structure (build + upgrades), followed by unit id, so a
    // captured building counts for its new owner and a destroyed one drops out
    const ob = proto.buildUnit;
    if (typeof ob === "function") proto.buildUnit = function (this: any) {
      const g0 = Number(this.gold()); const u = ob.apply(this, arguments as any);
      try { const paid = g0 - Number(this.gold()); if (u && paid > 0 && STRUCT_T.has(u.type())) paid_.set(u.id(), paid); } catch {}
      return u;
    };
    const ou = proto.upgradeUnit;
    if (typeof ou === "function") proto.upgradeUnit = function (this: any, unit: any) {
      const g0 = Number(this.gold()); const res = ou.apply(this, arguments as any);
      try { const paid = g0 - Number(this.gold()); if (paid > 0) paid_.set(unit.id(), (paid_.get(unit.id()) || 0) + paid); } catch {}
      return res;
    };
    const ocu = proto.captureUnit;
    if (typeof ocu === "function") proto.captureUnit = function (this: any, unit: any) {
      try { if (unit.type() === "Trade Ship") { heatAdd(heat.pc, this.smallID(), unit.tile()); heatAdd(heat.pv, unit.owner().smallID(), unit.tile()); } } catch {}
      return ocu.apply(this, arguments as any);
    };
  };
  const hookUnits = (proto: any) => {
    unitsHooked = true;
    const wrap = (name: string, f: (orig: any) => any) => { const orig = proto[name]; if (typeof orig === "function") proto[name] = f(orig); };
    wrap("modifyHealth", (orig) => function (this: any, delta: number, attacker?: any) {
      const before = this.health?.(); const r = orig.apply(this, arguments as any);
      try {
        if (this.type() === "Warship") {
          const d = Number(before) - Number(this.health?.() ?? 0), w = wsOf(this);
          if (d > 0) { w[10] += d; if (attacker) add("wsDamage", attacker.smallID(), w[1], "", d); }
          else if (d < 0) w[9] -= d;
        }
      } catch {}
      return r;
    });
    wrap("increaseVeterancy", (orig) => function (this: any) {
      const v0 = this.veterancy?.() ?? 0; const r = orig.apply(this, arguments as any);
      try { const v = this.veterancy?.() ?? 0; if (v > v0) { const w = wsOf(this); w[5] = v; if (v <= 3 && w[5 + v] < 0) w[5 + v] = game.ticks(); } } catch {}
      return r;
    });
    wrap("recordKill", (orig) => function (this: any, t: string) {
      try { if (this.type() === "Warship") { const w = wsOf(this); if (t === "Warship") w[11]++; else if (t === "Transport") w[12]++; } } catch {}
      return orig.apply(this, arguments as any);
    });
    wrap("recordTradeCapture", (orig) => function (this: any) { try { wsOf(this)[13]++; } catch {} return orig.apply(this, arguments as any); });
    wrap("delete", (orig) => function (this: any, displayMessage?: boolean, destroyer?: any) {
      try {
        const type = this.type(), o = this.owner().smallID();
        if (type === "Warship") { const w = wsOf(this); w[3] = game.ticks(); w[4] = destroyer ? destroyer.smallID() : 0; w[5] = this.veterancy?.() ?? w[5]; }
        else if (NUKES.has(type) && destroyer) add("nukeShotDown", o, destroyer.smallID(), type, 1);
        else if (type === "Trade Ship") {
          const t0 = trips.get(this.id()); trips.delete(this.id());
          if (displayMessage === false && !destroyer && t0 && t0[1] === o) add("tradeTrip", o, 0, "", game.ticks() - t0[0]); // own ships that reached port (not captured ones)
        }
      } catch {}
      return orig.apply(this, arguments as any);
    });
  };
  // conquest: every tile an attack takes goes through config.attackLogic; AttackExecution.tick tells whose
  // attack it is. Per (attacker, defender, kind): [attacker, defender (0 = terra nullius), kind, tiles,
  // attacker troops lost, defender troops lost]; kind: W wilderness, X toxic (fallout) land, B bot, N nation, H human
  const conq = new Map<number, number[]>(); let curAtk: any = null;
  const KIND = ["W", "X", "B", "N", "H"];
  const AP: any = (AttackExecution as any)?.prototype, cfg: any = game.config?.();
  if (AP && typeof AP.tick === "function" && cfg && typeof cfg.attackLogic === "function") {
    const ot = AP.tick;
    AP.tick = function (this: any) { const prev = curAtk; curAtk = this; try { return ot.apply(this, arguments as any); } finally { curAtk = prev; } };
    const ol = cfg.attackLogic;
    cfg.attackLogic = function (input: any) {
      const res = ol.apply(this, arguments as any);
      try {
        if (curAtk) {
          const a = curAtk._owner.smallID(), d = input.defender ? curAtk.target.smallID() : 0;
          const k = input.defender ? (input.defender.type === "BOT" ? 2 : input.defender.type === "NATION" ? 3 : 4) : input.falloutRatio !== null ? 1 : 0;
          const key = (a * 4096 + d) * 8 + k; let row = conq.get(key);
          if (!row) conq.set(key, row = [a, d, k, 0, 0, 0]);
          row[3]++; row[4] += Number(res.attackerTroopLoss) || 0; row[5] += Number(res.defenderTroopLoss) || 0;
        }
      } catch {}
      return res;
    };
  }
  // nukes: one record per detonation
  // [tick, owner, type, tile, [[victim, tiles lost, troops lost]], [[unit type, owner, level, value, friendly 0/1]]]
  const nukes: any[] = [];
  const NP: any = (NukeExecution as any)?.prototype;
  if (NP && typeof NP.detonate === "function") {
    const orig = NP.detonate;
    NP.detonate = function (this: any) {
      let pre: any = null;
      try {
        const nuke = this.nuke, me = this.player, dst = this.dst, type = nuke.type();
        const mag = game.config().nukeMagnitudes(type), o2 = mag.outer * mag.outer;
        const army = (p: any) => { let n = Number(p.troops()); try { for (const a of p.outgoingAttacks()) n += Number(a.troops()); for (const b of p.units("Transport")) n += Number(b.troops?.() ?? 0); } catch {} return n; };
        const ps = new Map<any, number[]>(); for (const p of game.players()) ps.set(p, [p.numTilesOwned(), army(p)]);
        const us: any[] = [];
        for (const u of game.units()) { const t = u.type(); if (NUKES.has(t) || t === "SAMMissile" || t === "Shell") continue; if (game.euclideanDistSquared(dst, u.tile()) < o2) { const ow = u.owner(), lv = u.level?.() ?? 1; us.push([u, t, ow.smallID(), lv, cost(t, ow) * (t === "Warship" || t === "Transport" || t === "Trade Ship" || t === "Train" ? 1 : lv), ow === me || me.isFriendly?.(ow) ? 1 : 0]); } }
        pre = { me, dst, type, ps, us, army };
      } catch {}
      const r = orig.apply(this, arguments as any);
      try {
        if (pre) {
          const vic: any[] = [];
          for (const [p, [t0, a0]] of pre.ps) { const dt = t0 - p.numTilesOwned(), da = a0 - pre.army(p); if (dt > 0 || da > 0) vic.push([p.smallID(), Math.max(0, dt), Math.max(0, Math.round(da))]); }
          const lost = pre.us.filter((x: any) => !x[0].isActive() || (x[0].level?.() ?? 1) < x[3]).map((x: any) => [x[1], x[2], x[0].isActive() ? x[3] - (x[0].level?.() ?? 1) : x[3], x[0].isActive() ? Math.round(x[4] / x[3] * (x[3] - (x[0].level?.() ?? 1))) : x[4], x[5]]);
          nukes.push([game.ticks(), pre.me.smallID(), pre.type, pre.dst, vic, lost]);
        }
      } catch {}
      return r;
    };
  }
  return {
    // called every tick from the main loop: finds the unit class once, notes when trade ships appear
    tick: () => {
      if (!unitsHooked) { const u = game.units()[0]; if (u) hookUnits(Object.getPrototypeOf(u)); }
      if (!playersHooked) { const p = game.players()[0]; if (p) hookPlayers(Object.getPrototypeOf(p)); }
    },
    // every 5 s of game time: [tick, [sid, gold paid for the structures they own now, ...]] (players with any)
    worth: () => {
      const per = new Map<number, number>();
      try { for (const u of game.units()) { const v = paid_.get(u.id()); if (v) { const o = u.owner(); if (o.type() === "BOT") continue; per.set(o.smallID(), (per.get(o.smallID()) || 0) + v); } } } catch {}
      worth.push([game.ticks(), [...per].flat().map((x) => Math.round(x))]);
    },
    seen: (u: any) => {
      const t = u.type(); if (t === "Trade Ship") { if (!trips.has(u.id())) trips.set(u.id(), [game.ticks(), u.owner().smallID()]); } else if (t === "Warship") wsOf(u);
      if ((t === "Trade Ship" || t === "Warship") && game.ticks() % HEAT_EVERY === 0) heatAdd(t === "Warship" ? heat.ws : heat.tr, u.owner().smallID(), u.tile());
    },
    // game analyzer (public/game-analyzer.html): summary.an = [[tick, rows]], per human / nation alive:
    // [sid, max troops, [city levels, ports, factories, SAMs, silos, defense posts], [[neighbour sid, shared border tiles]...],
    //  [[attack target sid (0 = wilderness), troops]...], incoming attacks, [ally sids]]
    // every 10 s of game time (20 s with more than 40 humans / nations), chosen at the end of the spawn phase
    anTick: (t: number) => {
      if (!anEvery) anEvery = game.players().filter((p: any) => p.type() !== "BOT").length > 40 ? 200 : 100;
      if (t % anEvery !== 0) return;
      const rows: any[] = [], gm: any = game.map(), buf: number[] = [];
      const BI: Record<string, number> = { "City": 0, "Port": 1, "Factory": 2, "SAM Launcher": 3, "Missile Silo": 4, "Defense Post": 5 };
      try {
        for (const p of game.players()) {
          if (p.type() === "BOT" || !p.isAlive()) continue;
          const me = p.smallID(), nb = new Map<number, number>();
          for (const bt of p.borderTiles()) {
            let k: number;
            if (gm.neighbors4) k = gm.neighbors4(bt, buf); else { const n = gm.neighbors(bt); buf.length = 0; for (const x of n) buf.push(x); k = n.length; }
            for (let i = 0; i < k; i++) { const o = gm.ownerID(buf[i]); if (o && o !== me) nb.set(o, (nb.get(o) || 0) + 1); }
          }
          const b = [0, 0, 0, 0, 0, 0];
          for (const u of p.units()) { const i = BI[u.type()]; if (i !== undefined) b[i] += i === 0 ? (u.level?.() ?? 1) : 1; }
          let mx = 0; try { mx = Math.round(Number(game.config().maxTroops(p))); } catch {}
          let out: any[] = [], inc = 0, al: number[] = [];
          try { out = p.outgoingAttacks().map((a: any) => [a.target().isPlayer?.() ? a.target().smallID() : 0, Math.round(Number(a.troops()))]); inc = p.incomingAttacks().length; } catch {}
          try { al = p.allies().map((x: any) => x.smallID()); } catch {}
          rows.push([me, mx, b, [...nb], out, inc, al]);
        }
      } catch {}
      an.push([t, rows]);
    },
    out: () => ({ v: 6, an, atk, worth, heat: { cols: HCOLS, rows: HROWS, every: HEAT_EVERY, ...Object.fromEntries(Object.entries(heat).map(([n, m]) => [n, Object.fromEntries([...m].map(([k, g]) => [k, [...g].flat()]))])) }, rows: [...rows.values()], work: [...work.entries()], warships: [...ws.values()], nukes, conquest: [...conq.values()].map((x) => [x[0], x[1], KIND[x[2]], x[3], Math.round(x[4]), Math.round(x[5])]) }),
  };
}
main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
