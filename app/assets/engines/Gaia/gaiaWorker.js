// A.C.A.S-MOD worker for GaiaChess 4.4.2 (WASM, NNUE).
//
// Gaia's web bundle is NOT a UCI worker by itself: it ships
//   engine.wasm  - the UCI engine, hand-loaded by engine.mjs
//   engine.mjs   - loadEngine(wasmSource, onLine, stopFlag)
//   worker.mjs   - the game's own worker protocol ({k: 'boot'|'net'|'tb'|'cmd'|'go'})
//   net.bin.deflate - NNUE network, deflate-raw, ~22 MB on the wire,
//                     87,311,392 bytes decompressed (gaia_net_size())
//   tb34.gtpk    - GaiaTB 3+4 piece DTM tables, ~19.8 MB
//   gui.wasm / gl.js / host.js - the pixel-art game UI, NOT needed here.
//
// This file is the ACAS adapter: it loads engine.wasm through Gaia's own
// engine.mjs, installs the network + tables the same way host.js does,
// and then speaks ACAS's worker protocol:
//   ACAS -> {method: 'acas_check_loaded'}   worker -> true (only when ready)
//   ACAS -> {method: 'uci', args: [line]}  worker -> UCI lines as strings
//            (id name, option name, uciok, readyok, info depth/score/pv, bestmove)
// ACAS's loadEngineWorker (wrappedEngines, commandMethod 'uci') sends every
// startup / position / go command through sendMsg, i.e. method 'uci'.
// Default Gaia options are already full strength: Skill Level 20,
// UCI_LimitStrength false, UCI_Elo 2640, Threads 1 (web build is single
// worker, see below).
//
// WHY THERE ARE .b64 FILES: this fork is pushed through a tool that only
// accepts UTF-8 text, so binary files cannot be pushed that way. The
// engine is therefore also stored as engine.wasm.b64 (base64 text).
// This worker prefers the real binary if it exists, and falls back to
// the .b64 copy otherwise, so uploading the real engine.wasm /
// tb34.gtpk / net.bin.deflate later (via GitHub web UI or git) works
// with no code change. Tables and network have the same fallback:
// tb34.gtpk.b64 and net.bin.deflate.b64, if present.
//
// LIMITATIONS, read before judging strength:
//  - Network: net.bin.deflate was NOT in the bundle uploaded for this
//    integration, so it is not in this folder yet. Without it the engine
//    still answers UCI but falls back to its PeSTO handcrafted
//    evaluation ("NNUE: no network loaded") - that is NOT full-strength
//    Gaia. Drop the real net.bin.deflate (or its .b64 copy) next to
//    this file and the next load will use NNUE automatically. If the
//    file is over GitHub web UI's 25 MB limit, split it into 20 MB
//    pieces named net.bin.deflate.part0, .part1, ... instead: this
//    worker fetches them in order and joins them back together.
//  - Tables: if tb34.gtpk (or .b64) is missing, search still works,
//    just with tbhits 0.
//  - Stop: a search runs synchronously inside the worker, so a 'stop'
//    posted while a search runs is only read after that search returns
//    (the same limitation Gaia's own worker.mjs documents). ACAS sends
//    bounded 'go depth' / 'go nodes' commands, never 'go infinite' in
//    the default path, so a queued stop only delays the next search
//    by the remaining depth search, it does not hang. The stopFlag is
//    created inside this worker; ACAS's main thread cannot set it
//    mid-search because ACAS's worker protocol has no shared-memory
//    channel for it.

import { loadEngine } from './engine.mjs';

let engine = null;
let ready = false;
let stopFlag = null;

function setStop(value) {
    try { if (stopFlag) Atomics.store(stopFlag, 0, value); } catch (e) {}
}

async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response;
}

function decodeBase64(text) {
    const clean = text.replace(/\s/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function fetchBytesOrB64(url, b64Url) {
    try {
        const response = await fetchOk(url);
        return new Uint8Array(await response.arrayBuffer());
    } catch (err) {
        const response = await fetchOk(b64Url);
        return decodeBase64(await response.text());
    }
}

async function loadEngineModule() {
    try {
        return await loadEngine(fetch('./engine.wasm'), line => postMessage(line), stopFlag);
    } catch (err) {
        // Binary not present (e.g. this fork was pushed without it):
        // fall back to the base64 text copy stored alongside.
        const bytes = await fetchBytesOrB64('./engine.wasm', './engine.wasm.b64').catch(() => null);
        if (!bytes) throw err;
        // loadEngine takes a Response/Promise for streaming, anything
        // else goes to WebAssembly.instantiate(bytes), which is what
        // a Uint8Array needs.
        return await loadEngine(bytes, line => postMessage(line), stopFlag);
    }
}

async function fetchChunkedNetwork() {
    // GitHub's web UI refuses a single file over 25 MB, so a large
    // net.bin.deflate is often uploaded split into 20 MB pieces named
    // net.bin.deflate.part0, .part1, ... in this same folder. Fetch
    // them in order until the first 404, then join them back together.
    // A gap in the numbering stops the loop: parts must be consecutive
    // from part0 with no missing piece.
    const chunks = [];
    let total = 0;
    for (let i = 0; ; i++) {
        let response;
        try { response = await fetchOk('./net.bin.deflate.part' + i); }
        catch (err) { break; }
        const bytes = new Uint8Array(await response.arrayBuffer());
        chunks.push(bytes);
        total += bytes.length;
    }
    if (!chunks.length) throw new Error('HTTP 404 (no chunked parts)');
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    postMessage('info string Gaia ACAS: network loaded from ' + chunks.length + ' chunk(s)');
    return joined.buffer;
}

async function loadNetworkFile() {
    if (typeof DecompressionStream === 'undefined') {
        postMessage('info string Gaia ACAS: DecompressionStream unavailable, network skipped (PeSTO fallback)');
        return false;
    }
    try {
        let deflated;
        try {
            const response = await fetchOk('./net.bin.deflate');
            deflated = await response.arrayBuffer();
        } catch (err) {
            try { deflated = await fetchChunkedNetwork(); }
            catch (chunkErr) {
                deflated = await fetchBytesOrB64('./net.bin.deflate', './net.bin.deflate.b64');
                deflated = deflated.buffer;
            }
        }
        const stream = new Response(deflated).body.pipeThrough(new DecompressionStream('deflate-raw'));
        const bytes = await new Response(stream).arrayBuffer();
        const ok = engine.loadNetwork(new Uint8Array(bytes));
        if (!ok) postMessage('info string Gaia ACAS: network rejected by engine (PeSTO fallback)');
        return ok;
    } catch (err) {
        postMessage('info string Gaia ACAS: network not loaded (' + err.message + '), running PeSTO fallback - add net.bin.deflate to this folder for NNUE');
        return false;
    }
}

async function loadTablesFile() {
    try {
        const bytes = await fetchBytesOrB64('./tb34.gtpk', './tb34.gtpk.b64');
        return engine.loadTables(bytes);
    } catch (err) {
        postMessage('info string Gaia ACAS: tables not loaded (' + err.message + ')');
        return false;
    }
}

async function boot() {
    try {
        const shared = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated;
        stopFlag = new Int32Array(shared ? new SharedArrayBuffer(4) : new ArrayBuffer(4));
        engine = await loadEngineModule();
        // Install data before signalling ready, so ACAS's first 'go'
        // is never answered by an engine with no evaluation. Host.js
        // holds searches for exactly this reason.
        await loadNetworkFile();
        await loadTablesFile();
        ready = true;
        postMessage(true);
    } catch (err) {
        // ACAS polls acas_check_loaded and will keep the worker alive;
        // posting the failure as an info string keeps it visible instead
        // of silently never becoming ready.
        try { postMessage('info string Gaia ACAS: failed to boot: ' + err.message); } catch (e) {}
    }
}

boot();

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
        if (trimmed === 'stop') {
            setStop(1);
            engine.command(line);
            return;
        }
        if (trimmed.startsWith('go ')) setStop(0);
        engine.command(line);
        return;
    }

    // Direct engine(method, args) calls from ACAS: treat a string arg
    // as a UCI line, the same way Maia's worker treats engine[method].
    if (typeof method === 'string' && args.length && typeof args[0] === 'string') {
        engine.command(args[0]);
    }
};
