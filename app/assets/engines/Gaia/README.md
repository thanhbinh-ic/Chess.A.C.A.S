# Gaia 4.4.2 — A.C.A.S-MOD built-in (WASM)

Source: GaiaChess 4.4.2 by Jean-François Romang, David Rabel, GPL-3.0-or-later,
https://github.com/jromang/gaiachess

Files in this folder:
- `gaiaWorker.js` — A.C.A.S-MOD adapter (written for this fork, not part of Gaia's web bundle).
- `engine.mjs` — Gaia's web engine loader, as shipped in the web bundle.
- `engine.wasm.b64` — Gaia's web engine, base64 text. The real binary is
  `engine.wasm`; it is also stored in base64 because this fork is pushed
  through a tool that only accepts UTF-8 text. `gaiaWorker.js` prefers the
  real binary if present, otherwise decodes this copy.
- `tb34.gtpk` — GaiaTB 3+4 piece DTM tables, as shipped (originally
  `tb34_0_ur0w.gtpk`). NOT in this commit yet for the same binary-push
  reason; upload it via GitHub web UI or git to this folder, or add
  `tb34.gtpk.b64`. Without it search still works, with tbhits 0.
- `net.bin.deflate` — NOT included yet. This is the NNUE network, deflate-raw,
  ~22 MB on the wire, 87,311,392 bytes decompressed. It was not in the bundle
  uploaded for this integration. Drop the real `net.bin.deflate` (or
  `net.bin.deflate.b64`) here and `gaiaWorker.js` will load NNUE automatically
  on the next engine load. Without it the engine still answers UCI but uses
  its PeSTO fallback evaluation, which is NOT full-strength Gaia.
  GitHub web UI refuses files over 25 MB: if your copy is larger, split
  it into 20 MB pieces named `net.bin.deflate.part0`, `.part1`, ... and
  upload those instead - `gaiaWorker.js` fetches them in order and joins
  them. Via git (no 25 MB limit, files under 100 MB) upload the whole
  file as-is. Do NOT use Git LFS for this folder: GitHub Pages serves
  LFS files as pointers, not binaries, so the worker would fail.

Not included (game UI only, not needed for ACAS): `gui.wasm`, `gl.js`, `host.js`, `index.html`.

ACAS registration:
- `app/assets/js/instance/engineWorker.js`: `'gaia-4-4-2': { path: 'Gaia/gaiaWorker', commandMethod: 'uci' }`
- `app/index.html`: dropdown item `data-value="gaia-4-4-2"`.
- Not in `ENGINES_REQUIRING_SAB`: the web build is single-worker, no SharedArrayBuffer needed.
- Defaults are full strength: Skill Level 20, UCI_LimitStrength false, UCI_Elo 2640, Threads 1.
- Stop limitation: a search runs synchronously in the worker, so a `stop`
  sent mid-search is only read after that search returns. ACAS sends bounded
  `go depth` / `go nodes`, so this only delays the next search.
