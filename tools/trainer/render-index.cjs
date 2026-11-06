// Renders the OpenFront build's index.html (an EJS template) once, as a static
// page served under BASE (TRAINER.PRO), with our branding and the trainer flag.
// usage: node render-index.cjs <openfront checkout> <out dir> <base>
const fs = require("fs");
const path = require("path");
const [checkout, outDir, base] = process.argv.slice(2);
const ejs = require(path.join(checkout, "node_modules", "ejs"));
const manifest = JSON.parse(fs.readFileSync(path.join(outDir, "asset-manifest.json"), "utf8"));
const url = (p) => (manifest[p] ? base + manifest[p] : `${base}/${p}`);
let html = ejs.render(fs.readFileSync(path.join(outDir, "index.html"), "utf8"), {
  gitCommit: JSON.stringify(fs.readFileSync(path.join(__dirname, "OPENFRONT_COMMIT"), "utf8").trim()),
  assetManifest: JSON.stringify(manifest),
  cdnBase: JSON.stringify(base),
  cdnBaseRaw: base,
  gameEnv: JSON.stringify("prod"),
  turnstileSiteKey: JSON.stringify("1x00000000000000000000AA"),
  // No account API behind TRAINER.PRO: ".invalid" never resolves, so those calls fail at once.
  jwtAudience: JSON.stringify("trainer.invalid"),
  manifestHref: url("manifest.json"),
  faviconHref: url("images/Favicon.svg"),
  gameplayScreenshotUrl: url("images/GameplayScreenshot.png"),
  backgroundImageUrl: url("images/background.webp"),
  desktopLogoImageUrl: url("images/OpenFront.png"),
  mobileLogoImageUrl: url("images/OF.png"),
});
// No OpenFront ads, analytics, CrazyGames SDK or Turnstile: they carry OpenFront's own IDs and a
// singleplayer game needs none of them.
html = html.replace(/<script\b[^>]*\bsrc="[^"]*(googletagmanager|cloudflareinsights|intergient|crazygames|challenges\.cloudflare)[^"]*"[^>]*>\s*<\/script>\s*/g, "");
html = html.replace(/<script\b[^>]*>(?:(?!<\/script>)[\s\S])*?(gtag\(|googletag|window\.ramp)(?:(?!<\/script>)[\s\S])*?<\/script>\s*/g, "");
// Branding: OpenFront's AGPL section 7 terms forbid "OpenFront" as our title.
html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/, "<title>TRAINER.PRO</title>");
html = html.replace(/<meta\s+(property|name)="(og:|twitter:|description)[^>]*>\s*/g, "");
html = html.replace("<head>", `<head>\n    <meta name="robots" content="noindex" />\n    <script>window.__TRAINER__ = { home: "/trainer/" };</script>`);
// The copyright notice OpenFront's licence asks us to keep visible, plus the source link the AGPL asks for.
html = html.replace("</body>", `  <style>body.in-game #trainer-credit{display:none}</style>\n  <div id="trainer-credit" style="position:fixed;left:8px;bottom:6px;z-index:2147483647;font:11px/1.3 Arial,sans-serif;color:rgba(255,255,255,.75);text-shadow:0 1px 2px #000;pointer-events:auto">TRAINER.PRO, a modified OpenFront build. © OpenFront and Contributors (AGPL-3.0). <a href="/trainer/source" style="color:inherit">Source</a></div>\n  </body>`);
fs.writeFileSync(path.join(outDir, "index.html"), html);
console.log("rendered", path.join(outDir, "index.html"));
