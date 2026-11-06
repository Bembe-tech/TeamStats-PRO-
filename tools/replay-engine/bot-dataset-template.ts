// TRAINER.PRO bot dataset recorder, bundled once per OpenFront commit (see bot-dataset.js):
// __ENGINE__ is replaced with that checkout's src/core path.
// Reads a full ranked 1v1 game record (JSON on stdin), replays it with the real engine and writes
// what each of the two humans saw and did, for teaching the bot to play like them:
//   - "d" decisions: every attack, boat, build, spawn, cancel of a human, with the game state
//     right before that turn (own and opponent stats, neighbours, action details)
//   - "s" snapshots: every SNAP ticks, the same state for both humans whether they acted or not
//     (teaches the bot WHEN to act, not only what to do)
// Output: gzipped JSON { v, gameId, gitCommit, map, size, ticks, winner, players, d, s }.
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { createGameRunner } from "__ENGINE__/GameRunner";
import { decompressGameRecord } from "__ENGINE__/Util";
import { GameMapType, PlayerType, UnitType } from "__ENGINE__/game/Game";

const [mapsDir, outFile, snapArg] = process.argv.slice(2);
const SNAP = Number(snapArg) || 50; // 5 s of game time

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

// Short names keep the files small; the trainer reads the same keys.
const UNITS: Record<string, string> = {
  [UnitType.City]: "city", [UnitType.Port]: "port", [UnitType.DefensePost]: "def", [UnitType.SAMLauncher]: "sam",
  [UnitType.MissileSilo]: "silo", [UnitType.Warship]: "ws", [UnitType.Factory]: "fac",
};
const r2 = (x: number) => Math.round(x * 100) / 100;
const kindOf = (p: any) => !p?.isPlayer?.() ? "none" : p.type() === PlayerType.Human ? "human" : p.type() === PlayerType.Bot ? "bot" : "nation";

async function main() {
  const record = JSON.parse(fs.readFileSync(0, "utf8"));
  const t0 = Date.now();
  decompressGameRecord(record);
  const runner = await createGameRunner(record.info, undefined, loader() as any, () => {});
  const game: any = runner.game;
  const W = game.width(), H = game.height(), LAND = game.numLandTiles();
  const humans: string[] = (record.info.players || []).map((p: any) => p.clientID).filter(Boolean);
  const player = (cid: string) => game.playerByClientID(cid);

  function neighbours(p: any) {
    // other owners touching our border, with how many of our border tiles touch them
    const touch = new Map<number, number>();
    for (const t of p.borderTiles()) {
      const seen = new Set<number>();
      game.forEachNeighbor(t, (n: number) => {
        const o = game.ownerID(n);
        if (o !== p.smallID() && game.isLand(n) && !seen.has(o)) { seen.add(o); touch.set(o, (touch.get(o) || 0) + 1); }
      });
    }
    return [...touch.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, border]) => {
      const o = game.playerBySmallID(id);
      return o?.isPlayer?.() ? { id, k: kindOf(o), tiles: o.numTilesOwned(), troops: Math.round(o.troops()), border } : { id: 0, k: "none", border };
    });
  }
  function stats(p: any) {
    if (!p || !p.isAlive()) return null;
    const units: Record<string, number> = {};
    for (const u of p.units()) { const k = UNITS[u.type()]; if (k) units[k] = (units[k] || 0) + (u.level?.() || 1); }
    const sum = (a: any[]) => Math.round(a.reduce((s, x) => s + x.troops(), 0));
    return {
      tiles: p.numTilesOwned(), land: r2(p.numTilesOwned() / LAND * 100), troops: Math.round(p.troops()),
      max: Math.round(game.config().maxTroops(p)), gold: Number(p.gold()), border: p.borderTiles().size, units,
      out: [p.outgoingAttacks().length, sum(p.outgoingAttacks())], inc: [p.incomingAttacks().length, sum(p.incomingAttacks())],
    };
  }
  function state(cid: string) {
    const me = player(cid), opp = player(humans.find((h) => h !== cid) || "");
    return { me: stats(me), opp: stats(opp), touchOpp: !!(me && opp && me.isAlive() && opp.isAlive() && me.sharesBorderWith(opp)), nb: me?.isAlive() ? neighbours(me) : [] };
  }
  function tileInfo(tile: number, me: any) {
    const o = game.owner(tile);
    let coast = false; game.forEachNeighbor(tile, (n: number) => { if (game.isOcean(n)) coast = true; });
    let near = 0; // own structures within 30 tiles (spacing of builds)
    if (me?.isAlive()) for (const u of me.units()) if (UNITS[u.type()] && UNITS[u.type()] !== "ws" && game.manhattanDist(u.tile(), tile) <= 30) near++;
    return { x: r2(game.x(tile) / W), y: r2(game.y(tile) / H), own: kindOf(o), mine: !!me && o === me, coast, near };
  }

  const d: any[] = [], s: any[] = [];
  const turns = record.turns || [];
  for (let i = 0; i < turns.length; i++) {
    const tick = game.ticks();
    for (const it of turns[i].intents || []) {
      const cid = it.clientID;
      if (!humans.includes(cid)) continue;
      const me = player(cid);
      let act: any = null;
      if (it.type === "spawn") act = { a: "spawn", ...tileInfo(it.tile, null) };
      else if (it.type === "attack") {
        let tgt: any = null;
        try { tgt = it.targetID ? game.player(it.targetID) : null; } catch {}
        act = { a: "attack", tk: tgt ? kindOf(tgt) : "none", tid: tgt?.smallID?.() ?? 0, ratio: me && it.troops != null ? r2(it.troops / Math.max(1, me.troops())) : null };
      } else if (it.type === "boat") act = { a: "boat", ratio: me ? r2(it.troops / Math.max(1, me.troops())) : null, ...tileInfo(it.dst, me) };
      else if (it.type === "build_unit") act = { a: "build", u: UNITS[it.unit] || String(it.unit), ...tileInfo(it.tile, me) };
      else if (it.type === "upgrade_structure") act = { a: "upgrade", u: String(it.unit ?? "") };
      else if (it.type === "cancel_attack" || it.type === "cancel_boat") act = { a: "cancel" };
      else if (it.type === "move_warship") act = { a: "warship" };
      else if (it.type === "delete_unit") act = { a: "delete" };
      if (act) d.push({ t: tick, c: cid, ...act, st: state(cid) });
    }
    runner.addTurn(turns[i]);
    if (runner.executeNextTick() === false) break;
    if (game.ticks() % SNAP === 0 && !game.inSpawnPhase()) for (const cid of humans) { const st = state(cid); if (st.me) s.push({ t: game.ticks(), c: cid, st }); }
  }
  const winner = record.info.winner;
  const out = {
    v: 1, gameId: record.info.gameID, gitCommit: record.gitCommit, map: record.info.config.gameMap, size: record.info.config.gameMapSize,
    ticks: game.ticks(), winner, players: (record.info.players || []).map((p: any) => ({ c: p.clientID, name: p.username })),
    d, s,
  };
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 6 }));
  console.log(JSON.stringify({ ok: true, decisions: d.length, snapshots: s.length, ticks: game.ticks(), ms: Date.now() - t0 }));
}
main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
