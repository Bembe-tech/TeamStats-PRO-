# TeamStats.pro: OpenFront engine changes

[teamstats.pro](https://teamstats.pro) is a community stats site for [OpenFront](https://openfront.io/).
For replays, maps, the minigame and TRAINER.PRO it runs OpenFront's own game engine and client with
our changes. OpenFront's code is licensed under the GNU Affero General Public License v3.0, so this
repository publishes that modified OpenFront code and everything needed to rebuild it.

This is not an official OpenFront project. Game code and art: © OpenFront and Contributors.
Upstream: <https://github.com/openfrontio/OpenFrontIO>

## What is in here

| Path | What it is |
| --- | --- |
| `tools/replay-engine/` | Entry templates (`*-template.ts`) that run OpenFront's engine headless, and `build.js` / `engine-paths.js` that bundle them with esbuild against an OpenFront checkout |
| `tools/build-minigame-engine.js`, `public/minigames/engine/` | The browser build of `minigame-template.ts` (Nuke the Fleet on the real engine) and the OpenFront map files it uses |
| `tools/trainer/` | `openfront.patch` on the OpenFront client at the commit in `OPENFRONT_COMMIT`, and `build.sh` that builds TRAINER.PRO from it |
| `public/js/replay-player.js` | The replay renderer; terrain colours, borders, rails, structure icons, name placement and fallout bloom follow OpenFront's client renderer and shaders |
| `public/js/openfront-mapgen.js` | OpenFront's map generator (`map-generator/map_generator.go`) ported to JavaScript |
| `public/map-creator.html`, `public/js/map-creator*.js`, `public/js/map-creator-flags.json` | Map Creator: paint a map, generate a world, import a real map from OpenFront's repo, and export it in the game's format (see below) |

### Templates

Each template replaces `__ENGINE__` with the engine folder of an OpenFront checkout (`src/core`, or the
`jr-core` shims that `engine-paths.js` writes for v35+), is bundled with esbuild into one `.cjs` file and
runs in its own Node process:

- `runner-template.ts`: quick replays (territory over time), built by `build.js`
- `player-template.ts`: full replays for the Replay Player (units, rails, names, stats)
- `team-win-template.ts`: when a team game is decided (team speedruns)
- `trade-template.ts`: trade routes for the trade heatmaps
- `bot-dataset-template.ts`: game states before each move of top 1v1 players (TRAINER.PRO bot)
- `minigame-template.ts`: the Nuke the Fleet minigame (browser build)

## Building
    npm --prefix tools/replay-engine install
    cd tools/replay-engine && npm install
    git clone https://github.com/openfrontio/OpenFrontIO tools/of-<commit> && git -C tools/of-<commit> checkout <commit>
    node tools/replay-engine/build.js tools/of-<commit> <commit>   # -> tools/replay-engine/engines/engine-<commit>.cjs
    node tools/build-minigame-engine.js tools/of-<commit>          # -> public/minigames/engine/ (folder must be named of-<commit>)
    tools/trainer/build.sh                                 # -> trainer/play/

The other templates are bundled the same way as `build.js` does (same aliases and esbuild options).

## Map Creator

A browser tool that paints an OpenFront map and exports `map.bin`, `map4x.bin`, `map16x.bin`, `manifest.json`,
`info.json`, `image.png` and `thumbnail.webp`, byte-identical to OpenFront's Go map generator.
It is plain HTML and JavaScript, no build step and no server code.

    npx serve public          # or any static file server with public/ as the root
    # open http://localhost:3000/map-creator.html

| File | What it does |
| --- | --- |
| `map-creator.html` | The page: toolbar, panels and styles |
| `js/map-creator.js` | Editor: brushes, fill, height tools, nations, import from OpenFront's maps on GitHub, export |
| `js/map-creator-worldgen.js` | World generator: seeded noise and shape presets |
| `js/map-creator-physical.js` | Image to map: turns a physical/topographic map picture into land heights, water and void |
| `js/map-creator-worker.js` | Runs `openfront-mapgen.js` in a Web Worker for the export |
| `js/map-creator-flags.json` | Flag list for nations |
| `css/theme.css`, `fonts/` | Site styles and fonts (Inter, Rajdhani, Orbitron, SIL OFL 1.1) |

On teamstats.pro, logged-in users can also submit maps to a gallery. That part needs the site's server
(`/api/me`, `/api/maps`), which is not in this repository, so standalone the Submit button only explains
that login is not set up. Everything else runs in the browser (importing a map from OpenFront needs internet).

## Licence

Code: [GNU AGPL-3.0](LICENSE). OpenFront map files and sprites: CC BY-SA 4.0, see
[LICENSE-ASSETS.md](LICENSE-ASSETS.md).
