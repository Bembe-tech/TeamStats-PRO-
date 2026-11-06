// Bundles runner-template.ts against one OpenFront checkout into engine-<commit>.cjs.
// usage: node build.js <openfront checkout dir> <commit>
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");
const { aliases, coreDir } = require("./engine-paths");

async function build(checkout, commit) {
  const TEMPLATE_VERSION = 3; // bump when runner-template.ts changes
  const out = path.join(__dirname, "engines", `engine-${commit.slice(0, 12)}-v${TEMPLATE_VERSION}.cjs`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const template = fs.readFileSync(path.join(__dirname, "runner-template.ts"), "utf8");
  const entry = path.join(checkout, "jr-replay-entry.ts");
  fs.writeFileSync(entry, template.replaceAll("__ENGINE__", coreDir(checkout, template))); // src/core, or the v35 jr-core shims
  await esbuild.build({
    entryPoints: [entry], bundle: true, platform: "node", format: "cjs", target: "node20", outfile: out,
    nodePaths: [path.join(__dirname, "node_modules")],
    loader: { ".json": "json", ".txt": "text", ".bin": "binary" },
    alias: aliases(checkout),
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "error",
    // browser-only helpers pulled in by client/hud code are never called headless
    external: ["howler", "lit", "pixi.js"],
  });
  return out;
}
module.exports = { build };
if (require.main === module) build(process.argv[2], process.argv[3]).then((o) => console.log(o)).catch((e) => { console.error(e.message); process.exit(1); });
