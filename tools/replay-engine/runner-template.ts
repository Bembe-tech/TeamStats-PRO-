// Entry bundled once per OpenFront commit (see build.js): __ENGINE__ is replaced
// with that checkout's src/core path. Reads a full game record (JSON on stdin),
// replays every turn with the real game engine and writes territory frames:
// every FRAME_TICKS ticks, the owner of each cell of a cols x rows grid.
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { createGameRunner } from "__ENGINE__/GameRunner";
import { decompressGameRecord } from "__ENGINE__/Util";
import { GameMapType } from "__ENGINE__/game/Game";

const [mapsDir, outFile, colsArg, frameArg] = process.argv.slice(2);
const COLS = Number(colsArg) || 480, FRAME_TICKS = Number(frameArg) || 10;

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

async function main() {
  const record = JSON.parse(fs.readFileSync(0, "utf8"));
  const t0 = Date.now();
  decompressGameRecord(record);
  const runner = await createGameRunner(record.info, undefined, loader() as any, () => {});
  const game: any = runner.game;
  const W = game.width(), H = game.height();
  const cols = Math.min(COLS, W), rows = Math.max(1, Math.round(cols * H / W));
  const sample = new Int32Array(cols * rows);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++)
    sample[y * cols + x] = Math.min(H - 1, Math.floor((y + 0.5) * H / rows)) * W + Math.min(W - 1, Math.floor((x + 0.5) * W / cols));
  // Frame 0 is stored whole; later frames only list the cells that changed
  // (uint32 count, then count x [uint32 cell, uint16 owner smallID]).
  const frames: Buffer[] = [], ticks: number[] = [];
  let prev: Uint16Array | null = null;
  const snap = () => {
    const cur = new Uint16Array(sample.length);
    for (let i = 0; i < sample.length; i++) cur[i] = game.ownerID(sample[i]);
    if (!prev) { frames.push(Buffer.from(cur.buffer)); }
    else {
      const idx: number[] = []; for (let i = 0; i < cur.length; i++) if (cur[i] !== prev[i]) idx.push(i);
      const buf = Buffer.alloc(4 + idx.length * 6); buf.writeUInt32LE(idx.length, 0);
      idx.forEach((c, k) => { buf.writeUInt32LE(c, 4 + k * 6); buf.writeUInt16LE(cur[c], 8 + k * 6); });
      frames.push(buf);
    }
    prev = cur; ticks.push(game.ticks());
    // Exact counts for the win bar (Speedrun analytics): land under nuke fallout and
    // tiles owned by each human, per frame. The game wins at 80% of land without fallout.
    fallout.push(typeof game.numTilesWithFallout === "function" ? game.numTilesWithFallout() : 0);
    for (const p of game.allPlayers()) { const cid = p.clientID?.(); if (!cid) continue; (humanTiles[cid] ||= []).length = ticks.length - 1; humanTiles[cid].push(p.numTilesOwned()); }
  };
  const fallout: number[] = [], humanTiles: Record<string, number[]> = {};
  for (const turn of record.turns) runner.addTurn(turn);
  let guard = 0;
  while (runner.executeNextTick() !== false && guard++ < 200000) {
    if (game.ticks() % FRAME_TICKS === 0 || !prev) snap();
    if (guard > record.turns.length + 50) break;
  }
  snap();
  // smallID -> clientID so the site can match owners to its own player list
  const owners: Record<number, string> = {};
  const bots: number[] = [];
  const teams: Record<number, string> = {};
  for (const p of game.allPlayers()) { const cid = p.clientID?.(); if (cid) owners[p.smallID()] = cid; else bots.push(p.smallID()); const t = p.team?.(); if (t) teams[p.smallID()] = String(t); }
  const header = Buffer.from(JSON.stringify({ v: 3, gameId: record.info.gameID, gitCommit: record.gitCommit, cols, rows, width: W, height: H, frameTicks: FRAME_TICKS, ticks, owners, bots, teams, delta: true, land: game.numLandTiles(), fallout, humanTiles, ms: Date.now() - t0 }));
  const len = Buffer.alloc(4); len.writeUInt32LE(header.length);
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat([len, header, ...frames]), { level: 6 }));
  console.log(JSON.stringify({ ok: true, frames: frames.length, ticks: game.ticks(), ms: Date.now() - t0 }));
}
main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
