// Where an OpenFront checkout keeps its game engine, for the templates' "__ENGINE__/..." imports.
// Up to v34 the engine is src/core. v35 (2026-10-16) split it into packages/engine, engine-lib,
// engine-api, shared and zbin (imported as "@openfront/<name>/..."), and createGameRunner /
// loadTerrainMap now take the map files already loaded instead of a loader. For such a
// checkout a small folder jr-core/ is written next to packages/ that keeps the old src/core
// paths and signatures, so the templates stay the same for every version.
const fs = require("fs");
const path = require("path");

const PACKAGES = ["engine", "engine-lib", "engine-api", "shared", "zbin"];
const slash = p => p.replace(/\\/g, "/");
const isSplit = checkout => !fs.existsSync(path.join(checkout, "src", "core", "GameRunner.ts")) && fs.existsSync(path.join(checkout, "packages", "engine", "src", "GameRunner.ts"));

// esbuild aliases: "resources" plus, for v35+, every @openfront package -> packages/<name>/src
function aliases(checkout) {
  const out = { resources: path.resolve(checkout, "resources") };
  if (isSplit(checkout)) for (const p of PACKAGES) out["@openfront/" + p] = path.join(checkout, "packages", p, "src");
  return out;
}

const SHIM_VERSION = 1; // bump when the shims below change
// Old paths whose code moved or whose signature changed; anything else falls through to the
// first package that has the same path (packages/engine/src/execution/NukeExecution.ts, ...).
const OVERRIDES = {
  "GameRunner": `export * from "@openfront/engine/GameRunner";
import { createGameRunner as create } from "@openfront/engine/GameRunner";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
// v34 signature: (gameStart, clientID, mapLoader, callBack)
export async function createGameRunner(gameStart: any, clientID: any, loader: any, cb: any) {
  return create(gameStart, clientID, await loadMapFiles(loader, gameStart.config.gameMap, gameStart.config.gameMapSize), cb);
}`,
  "Util": `export * from "@openfront/engine-lib/Util";
export * from "@openfront/shared/SharedUtil";`,
  "game/Game": `export * from "@openfront/engine-api/game/GameTypes";
export * from "@openfront/engine/game/Game";`,
  "game/TerrainMapLoader": `export * from "@openfront/engine-lib/game/TerrainMapLoader";
import { loadTerrainMap as load } from "@openfront/engine-lib/game/TerrainMapLoader";
import { loadMapFiles } from "@openfront/shared/GameMapLoader";
// v34 signature: (map, mapSize, loader, loadImages)
export async function loadTerrainMap(map: any, mapSize: any, loader: any, _images?: boolean) {
  return load(await loadMapFiles(loader, map, mapSize));
}`,
  "configuration/Config": `export * from "@openfront/engine-lib/configuration/Config";
export { EngineConfig as Config } from "@openfront/engine/configuration/EngineConfig";`,
};

// Writes jr-core/<p>.ts for each old path the template imports; returns the dir for __ENGINE__.
function coreDir(checkout, template) {
  if (!isSplit(checkout)) return slash(path.join(checkout, "src", "core"));
  const dir = path.join(checkout, "jr-core");
  const wanted = new Set([...String(template || "").matchAll(/["']__ENGINE__\/([^"']+)["']/g)].map(m => m[1]));
  for (const rel of wanted) {
    const file = path.join(dir, rel + ".ts");
    const stamp = `// jr-core shim v${SHIM_VERSION}\n`;
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8").startsWith(stamp)) continue;
    let body = OVERRIDES[rel];
    if (!body) {
      const pkg = PACKAGES.find(p => fs.existsSync(path.join(checkout, "packages", p, "src", rel + ".ts")));
      if (!pkg) throw new Error(`OpenFront v35 layout: no ${rel} in packages/*`);
      body = `export * from "@openfront/${pkg}/${rel}";`;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, stamp + body + "\n");
  }
  return slash(dir);
}

module.exports = { isSplit, aliases, coreDir };
