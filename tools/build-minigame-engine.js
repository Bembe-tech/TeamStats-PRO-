// Bundles tools/replay-engine/minigame-template.ts (Nuke the Fleet on the real OpenFront engine) for the
// browser: public/minigames/engine/nuke-fleet-<commit>.js, run by the game page in a Web Worker.
// Also copies the Surrounded map files (CC BY-SA 4.0, OpenFront resources) next to it.
// usage: node tools/build-minigame-engine.js [openfront checkout dir] [--node]  (--node: a CommonJS build for tests)
const fs = require("fs");
const path = require("path");
const ENGINE_DIR = path.join(__dirname, "replay-engine");
const OUT_DIR = path.join(__dirname, "..", "public", "minigames", "engine");
const zlib = require("zlib");

async function main() {
  const checkout = path.resolve(process.argv[2] || path.join(__dirname, "of-a76a11b837e8"));
  const node = process.argv.includes("--node");
  const commit = path.basename(checkout).replace(/^of-/, "");
  const esbuild = require(path.join(ENGINE_DIR, "node_modules", "esbuild"));
  const src = path.join(checkout, "src").split(path.sep).join("/");
  const entry = path.join(checkout, "jr-minigame-entry.ts");
  fs.writeFileSync(entry, fs.readFileSync(path.join(ENGINE_DIR, "minigame-template.ts"), "utf8").replaceAll("__ENGINE__", src + "/core"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = node ? path.join(ENGINE_DIR, "tmp", `minigame-${commit}.cjs`) : path.join(OUT_DIR, `nuke-fleet-${commit}.js`);
  await esbuild.build({
    entryPoints: [entry], bundle: true, outfile: out, minify: !node, sourcemap: false, legalComments: "none",
    platform: node ? "node" : "browser", format: node ? "cjs" : "iife", target: node ? "node20" : "es2020",
    nodePaths: [path.join(ENGINE_DIR, "node_modules")],
    loader: { ".json": "json", ".txt": "text", ".bin": "binary", ".glsl": "text", ".svg": "text", ".png": "empty", ".webp": "empty" },
    alias: { resources: path.resolve(checkout, "resources") },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    external: ["howler", "lit", "pixi.js"],
  });
  if (!node) {
    // OpenFront's own license header (AGPL-3.0): the bundle is a modified build of their engine
    const head = `/* Nuke the Fleet engine for TeamStats.pro: OpenFront game engine (https://github.com/openfrontio/OpenFrontIO, commit ${commit}),\n   © OpenFront and Contributors, AGPL-3.0, bundled with tools/replay-engine/minigame-template.ts. */\n`;
    fs.writeFileSync(out, head + fs.readFileSync(out, "utf8"));
    // map files (full size + the 4x mini map the engine uses for boats): the first checkout that has Surrounded
    const tools = __dirname, dirs = fs.readdirSync(tools).filter(d => d.startsWith("of-")).map(d => path.join(tools, d, "resources", "maps", "surrounded"));
    const mapDir = [path.join(checkout, "resources", "maps", "surrounded"), ...dirs].find(d => fs.existsSync(path.join(d, "map4x.bin")));
    if (!mapDir) throw new Error("no Surrounded map in any checkout (node -e \"require('./replay-engine').ensureCheckout('<commit>','Surrounded')\")");
    for (const f of ["map.bin", "map4x.bin"]) fs.writeFileSync(path.join(OUT_DIR, "surrounded-" + f + ".gz"), zlib.gzipSync(fs.readFileSync(path.join(mapDir, f)), { level: 9 }));
    fs.copyFileSync(path.join(mapDir, "manifest.json"), path.join(OUT_DIR, "surrounded-manifest.json"));
    fs.writeFileSync(path.join(OUT_DIR, "engine.json"), JSON.stringify({ commit, file: path.basename(out) }));
  }
  fs.unlinkSync(entry);
  console.log(out, (fs.statSync(out).size / 1024).toFixed(0) + " KB");
}
main().catch(e => { console.error(e.message || e); process.exit(1); });
