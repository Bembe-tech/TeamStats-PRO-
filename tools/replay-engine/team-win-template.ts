// Team Speedruns: bundled once per OpenFront commit (see team-speedrun-engine.js), __ENGINE__
// is replaced with that checkout's src/core path. Reads a full game record (JSON on stdin),
// replays it with the real game engine until a winner is set and prints one JSON line:
// the tick the spawn phase ended (in-game timer start), the tick of the win, the winner
// and each human's team. Multiplayer records run on past the win (the server archives
// after the clients' winner vote), so the win tick is taken from the engine, not num_turns.
import * as fs from "fs";
import * as path from "path";
import { createGameRunner } from "__ENGINE__/GameRunner";
import { decompressGameRecord } from "__ENGINE__/Util";
import { GameMapType } from "__ENGINE__/game/Game";

const [mapsDir] = process.argv.slice(2);

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
  for (const turn of record.turns) runner.addTurn(turn);
  let guard = 0, winTick: number | null = null;
  while (runner.executeNextTick() !== false && guard++ < 200000) {
    if (game.getWinner() !== null) { winTick = game.ticks(); break; }
    if (guard > record.turns.length + 50) break;
  }
  const w = game.getWinner();
  const winner = w === null ? null : typeof w === "string" ? { team: w } : { clientID: w.clientID?.() ?? null, team: w.team?.() ?? null };
  const teams: Record<string, string | null> = {};
  for (const p of game.allPlayers()) { const cid = p.clientID?.(); if (cid) teams[cid] = p.team?.() ?? null; }
  const land = game.numLandTiles(), fallout = typeof game.numTilesWithFallout === "function" ? game.numTilesWithFallout() : 0;
  console.log(JSON.stringify({ ok: true, startTick: game.startTick ?? null, winTick, ticks: game.ticks(), winner, teams, land, fallout, ms: Date.now() - t0 }));
}
main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
