# TRAINER.PRO client

A patched build of the OpenFront web client: play 1v1 against one AI nation on the ranked 1v1 maps.
The game runs fully in the browser (engine in a Web Worker).

## Building

    tools/trainer/build.sh            # needs git, node, npm

It clones OpenFront, checks out the commit in `OPENFRONT_COMMIT`, applies `openfront.patch`, removes
OpenFront's proprietary assets (logo, font, music) and puts the ones from `brand/` instead, builds with
Vite, keeps only the 4 ranked 1v1 maps and renders `index.html` with `render-index.cjs` (own title,
no OpenFront ads/analytics/Turnstile, the copyright line). `tuned-policy.json` holds the bot's default
numbers read by the patched nation AI; `bot-version.json` / `bump-version.cjs` the version shown in the game.

On Windows run `render-index.cjs` with `MSYS_NO_PATHCONV=1` from Git Bash.

## Licence

- Code: AGPL-3.0, like OpenFront.
- `resources/` from OpenFront (maps, flags, images, sounds): CC BY-SA 4.0, credit "OpenFront".
- `proprietary/` from OpenFront (logo, font, music): all rights reserved, never copied here.
- `brand/fonts/OpenFront.ttf` is Liberation Sans Bold (SIL OFL 1.1), only named so the client finds it.
