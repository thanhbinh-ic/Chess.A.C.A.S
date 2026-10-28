// A.C.A.S worker for Berserk (WASM, NNUE embedded).
//
// The package huynh uploaded to app/assets/engines/Berserk/ is NOT a
// UCI worker by itself. It ships:
//   berserk.js      - wasm-bindgen JS glue, ES module, exports
//                     { default: init, Engine, run_helper_thread }
//   berserk_bg.wasm - the engine itself, ~62 MB. Its memory section is
//                     NOT shared (flags 0, min 998 pages), so unlike
//                     Fairy Stockfish it does NOT need SharedArrayBuffer
//                     and does NOT belong in ENGINES_REQUIRING_SAB.
//                     Verified in Chromium headless, with and without
//                     COOP/COEP: init + search both work.
//
// The glue exposes a method API, not a UCI text stream:
//   new Engine()
//   engine.set_position(fen)          // full FEN, not "position fen ..."
//   engine.make_move(uciMove)         // e.g. "e2e4"
//   engine.go_uci(depth, nodes, multiPv, onInfo)
//   engine.go_movetime(ms, multiPv, onInfo)
//   engine.last_bestmove()            // after a go_* call returns
//   engine.reset()                    // search state only, NOT the board
//   engine.set_threads(n)             // DO NOT call with n > 1 (see below)
//   engine.evaluate() / engine.fen()  // helpers, not used by ACAS
// onInfo receives UCI-format strings already, e.g.
//   "info depth 5 seldepth 6 multipv 1 score cp 42 nodes 718 ... pv c2c4 ..."
// but it never receives a "bestmove" line: this worker posts that
// itself from last_bestmove() after the go_* call returns.
//
// This file is the ACAS adapter, same protocol as gaiaWorker.js:
//   ACAS -> {method: 'acas_check_loaded'}   worker -> true (only when ready)
//   ACAS -> {method: 'uci', args: [line]}  worker -> UCI lines as strings
//            (id name, option name, uciok, readyok, info depth/score/pv, bestmove)
// ACAS's loadEngineWorker (wrappedEngines, commandMethod 'uci') sends
// every startup / position / go command through sendMsg, i.e. method 'uci'.
//
// LIMITATIONS, read before judging strength:
//  - Threads: set_threads(4) was tested and HANGS: the glue has no
//    worker-spawning code for run_helper_thread, so helper threads
//    never start and the search never returns. This worker therefore
//    never calls set_threads at all (default is 1) and clamps any
//    ACAS "setoption name Threads" to 1. Berserk here is single-thread
//    only, ~65k nps on the test VM (depth 20 startpos = 8.8 s).
//  - Stop: there is no stop API in the glue, and a search runs
//    synchronously inside the worker, so a 'stop' posted while a
//    search runs is only read after that search returns (same shape
//    of limitation as Gaia, but Gaia at least has a stopFlag).
//    ACAS's movetime timer therefore cannot cut a Berserk search
//    short. To keep the default ACAS path usable, this worker CAPS
//    depth: 'go depth N' with N > 20 runs at depth 20, and
//    'go infinite' runs at depth 20. A lower depth or a node limit
//    from ACAS is respected exactly, and 'go movetime' is respected
//    exactly. Depth 20 startpos measured 8.8 s / 575k nodes;
//    depth 24 already took 44.8 s, depth 100 would never return
//    in practice, so the cap is not cosmetic.
//  - Hash / Skill Level / UCI_Elo / UCI_LimitStrength: the glue has
//    no API for them, so setoption lines for those are ignored.
//    Berserk always runs at full strength here.
//  - searchmoves: the glue has no root-move restriction, so a
//    'go ... searchmoves ...' runs a full search and its bestmove
//    may fall outside the requested list. The normal ACAS board
//    path sends no searchmoves, so this only affects specific-move
//    analysis flows.
//  - Illegal positions: set_position on a board with no legal moves
//    (e.g. an empty board) traps the wasm instance ("unreachable").
//    ACAS only sends legal board positions from a real game, so
//    this should not happen in practice; if it does, the worker
//    reports it and that worker instance is dead until reloaded.

import init, { Engine } from './berserk.js';

const STARTPOS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const MAX_DEPTH = 20;

let engine = null;
let ready = false;
let multiPv = 1;
let warnedDepthCap = false;
let warnedThreads = false;
let warnedSearchmoves = false;

async function boot() {
    try {
        await init();
        engine = new Engine();
        ready = true;
        postMessage(true);
    } catch (err) {
        try { postMessage('info string Berserk ACAS: failed to boot: ' + err.message); } catch (e) {}
    }
}

boot();

function postBestmove() {
    let move = '';
    try { move = engine.last_bestmove(); } catch (e) { move = ''; }
    if (!move) move = '0000';
    postMessage('bestmove ' + move);
}

function handlePosition(rest) {
    // rest: "startpos [moves ...]" or "fen <fen> [moves ...]"
    const tokens = rest.split(/\s+/).filter(Boolean);
    let fen = STARTPOS_FEN;
    let moves = [];
    if (tokens[0] === 'startpos') {
        const mi = tokens.indexOf('moves');
        if (mi >= 0) moves = tokens.slice(mi + 1);
    } else if (tokens[0] === 'fen') {
        const mi = tokens.indexOf('moves');
        const fenTokens = mi >= 0 ? tokens.slice(1, mi) : tokens.slice(1);
        fen = fenTokens.join(' ');
        if (mi >= 0) moves = tokens.slice(mi + 1);
    } else {
        return;
    }
    engine.set_position(fen);
    for (const m of moves) engine.make_move(m);
}

function handleGo(rest) {
    const tokens = rest.split(/\s+/).filter(Boolean);
    let depth = 0;
    let nodes = 0;
    let movetime = 0;
    let infinite = false;
    let hasSearchmoves = false;
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === 'depth' && i + 1 < tokens.length) depth = parseInt(tokens[++i], 10) || 0;
        else if (tokens[i] === 'nodes' && i + 1 < tokens.length) nodes = parseInt(tokens[++i], 10) || 0;
        else if (tokens[i] === 'movetime' && i + 1 < tokens.length) movetime = parseInt(tokens[++i], 10) || 0;
        else if (tokens[i] === 'infinite') infinite = true;
        else if (tokens[i] === 'searchmoves') hasSearchmoves = true;
    }
    if (hasSearchmoves && !warnedSearchmoves) {
        warnedSearchmoves = true;
        postMessage('info string Berserk ACAS: searchmoves is not supported by this wasm build, running a full search');
    }
    const onInfo = line => { if (line) postMessage(String(line)); };
    if (movetime > 0) {
        engine.go_movetime(movetime, multiPv, onInfo);
    } else {
        if (depth > MAX_DEPTH || infinite) {
            if (!warnedDepthCap) {
                warnedDepthCap = true;
                postMessage('info string Berserk ACAS: depth capped to ' + MAX_DEPTH + ' (wasm build has no stop and runs single-threaded)');
            }
            depth = MAX_DEPTH;
        }
        if (depth === 0 && nodes === 0) depth = MAX_DEPTH;
        engine.go_uci(depth, nodes, multiPv, onInfo);
    }
    postBestmove();
}

function handleSetoption(line) {
    // "setoption name <Name> value <Value>"
    const m = line.match(/^setoption\s+name\s+(.+?)(?:\s+value\s+(.*))?$/);
    if (!m) return;
    const name = m[1].trim();
    const value = (m[2] || '').trim();
    if (name === 'MultiPV') {
        const v = parseInt(value, 10);
        if (v > 0) multiPv = v;
    } else if (name === 'Threads') {
        const v = parseInt(value, 10);
        if (v > 1 && !warnedThreads) {
            warnedThreads = true;
            postMessage('info string Berserk ACAS: Threads clamped to 1 (this wasm build hangs with Threads > 1)');
        }
        // Deliberately do NOT call engine.set_threads(v): see header.
    }
    // Hash, Skill Level, UCI_Elo, UCI_LimitStrength, UCI_Chess960,
    // UCI_Variant, nodestime, ... : no API in this build, ignored.
}

self.onmessage = e => {
    const data = e.data || {};
    const method = data.method;
    const args = data.args || [];

    if (method === 'acas_check_loaded') {
        if (ready) postMessage(true);
        return;
    }
    if (!engine) return;

    if (method === 'uci') {
        const line = args[0];
        if (typeof line !== 'string') return;
        const trimmed = line.trim();
        try {
            if (trimmed === 'uci') {
                postMessage('id name Berserk');
                postMessage('id author Berserk contributors (wasm-bindgen build)');
                postMessage('option name Threads type spin default 1 min 1 max 1');
                postMessage('option name MultiPV type spin default 1 min 1 max 10');
                postMessage('uciok');
            } else if (trimmed === 'isready') {
                postMessage('readyok');
            } else if (trimmed === 'ucinewgame') {
                engine.reset();
            } else if (trimmed === 'stop') {
                // No stop API: a queued stop is a no-op, the search
                // already posted its bestmove when it returned.
            } else if (trimmed === 'quit') {
                try { engine.free(); } catch (e) {}
            } else if (trimmed.startsWith('setoption ')) {
                handleSetoption(trimmed);
            } else if (trimmed.startsWith('position ')) {
                handlePosition(trimmed.slice('position '.length));
            } else if (trimmed.startsWith('go ')) {
                handleGo(trimmed.slice('go '.length));
            }
            // 'd', 'flip', unknown lines: ignored.
        } catch (err) {
            try { postMessage('info string Berserk ACAS: command failed (' + err.message + ')'); } catch (e) {}
        }
        return;
    }

    // Direct engine(method, args) calls from ACAS: treat a string arg
    // as a UCI line, the same way Gaia's worker treats engine[method].
    if (typeof method === 'string' && args.length && typeof args[0] === 'string') {
        self.onmessage({ data: { method: 'uci', args: [args[0]] } });
    }
};
