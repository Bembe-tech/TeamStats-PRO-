// Trade Ships Heatmap recorder, bundled once per OpenFront commit (see tools/trade-heatmap.js):
// __ENGINE__ is replaced with that checkout's src/core path. Reads a full game record (JSON on
// stdin), replays every turn with the real game engine and counts, every SAMPLE ticks, the
// cell of a cols x rows grid under each trade ship. Writes a small JSON with the sparse counts.
import * as fs from "fs";
import * as path from "path";
import { createGameRunner } from "__ENGINE__/GameRunner";
import { decompressGameRecord } from "__ENGINE__/Util";
import { GameMapType } from "__ENGINE__/game/Game";

const [mapsDir, outFile, colsArg, sampleArg] = process.argv.slice(2);
const COLS = Number(colsArg) || 500, SAMPLE = Number(sampleArg) || 2;

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
  const grid = new Uint32Array(cols * rows);
  const ships = new Set<number>(), ports = new Map<number, number>();
  for (const turn of record.turns) runner.addTurn(turn);
  let guard = 0;
  while (runner.executeNextTick() !== false && guard++ < 200000) {
    if (game.ticks() % SAMPLE) continue;
    for (const u of game.units()) {
      const type = u.type();
      if (type === "Port") { ports.set(u.id(), u.tile()); continue; }
      if (type !== "Trade Ship" || (u.isActive && !u.isActive())) continue;
      ships.add(u.id());
      const t = u.tile(), x = t % W, y = Math.floor(t / W);
      grid[Math.min(rows - 1, Math.floor(y * rows / H)) * cols + Math.min(cols - 1, Math.floor(x * cols / W))]++;
    }
  }
  const cells: number[] = [];
  for (let i = 0; i < grid.length; i++) if (grid[i]) cells.push(i, grid[i]);
  // ports ever built, as grid cells (for an optional port overlay)
  const portCells = [...ports.values()].map((t) => Math.min(rows - 1, Math.floor(Math.floor(t / W) * rows / H)) * cols + Math.min(cols - 1, Math.floor((t % W) * cols / W)));
  fs.writeFileSync(outFile, JSON.stringify({ v: 1, gameId: record.info.gameID, gitCommit: record.gitCommit, map: record.info.config?.gameMap, width: W, height: H, cols, rows, sample: SAMPLE, ticks: game.ticks(), ships: ships.size, ports: portCells, cells }));
  console.log(JSON.stringify({ ok: true, ships: ships.size, cells: cells.length / 2, ticks: game.ticks(), ms: Date.now() - t0 }));
}
main().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });
