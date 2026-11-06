// Bot version +0.01 after a change to the bot's code (Bembe, 2026-10-15). Training runs
// count on their own (train.cjs). Usage: node tools/trainer/bump-version.cjs
const fs = require("fs"), path = require("path");
const file = path.join(__dirname, "bot-version.json");
const v = JSON.parse(fs.readFileSync(file, "utf8"));
v.updates = (Number(v.updates) || 0) + 1;
fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
console.log(`Bot version is now v${require("../../bot-dataset").version()}`);
