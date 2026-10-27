import { floatingPanelVideoElem, pipBoardInput, pipSanInput, pipModeInput } from './elementDeclarations.js';
import { setMediaMetadata } from './media.js';
import { formatMoveNotationAsync } from '../misc/moveNotation.js';
import { getBackgroundGrainTile } from './backgroundGrain.js';

export const pipData = {};
let pipHintInstance = null;
let pipHintRevision = 0;
const pipFontSizes = { large: 64, mlarge: 35, medium: 26, small: 18, esmall: 18 };
const pipHeaderHeight = 44;
const pipEvalBarWidth = 41;
const pipStatusBarHeight = 2;
const pipBoardSize = 360;
const pipBoardConfig = [0, pipHeaderHeight, pipBoardSize];

let pipCanvas = null;
let pipVideo = null;

// A.C.A.S-MOD: Floating Panel no longer uses Picture-in-Picture.
// A browser has only ONE PiP slot, so the old panel stole YouTube's video
// PiP window. The panel now lives in an ordinary popup window instead:
// a normal window is not a PiP window, so it never consumes that slot.
// The canvas that used to be streamed into PiP is copied frame-by-frame
// into the new window's canvas by syncAnalysisWindow() (see updatePipContext).
let analysisWin = null;
let analysisCanvas = null;
let analysisWinRetryArmed = false;

// A.C.A.S-MOD (single window + auto-close, 26/10/2026):
// Two separate causes of "many windows" were found:
//  (a) the panel window used the SAME window name as the userscript's
//      GUI window ('acas-analysis-window'), so the browser could
//      confuse the two; the panel now uses its own name
//      'acas-floating-panel'.
//  (b) closing the app tab left the panel window orphaned, so
//      reopening the app opened another one on top of the old one.
//      The app tab now closes its panel on unload (see
//      installAnalysisCoordination), and app tabs coordinate through
//      BroadcastChannel + localStorage so only one panel window
//      exists at a time: a new app tab claims ownership, the old
//      owner closes its window, and the new tab waits 200ms before
//      opening its own, so the old window is gone first.
const ANALYSIS_WINDOW_NAME = 'acas-floating-panel';
const ANALYSIS_OWNER_KEY = 'acas-analysis-owner';
const analysisTabId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'acas-' + Date.now() + '-' + Math.random().toString(36).slice(2);
let analysisCoordinationInstalled = false;
let analysisChannel = null;

function getAnalysisOwner() {
    try { return localStorage.getItem(ANALYSIS_OWNER_KEY); } catch(e) { return null; }
}
function setAnalysisOwner() {
    try { localStorage.setItem(ANALYSIS_OWNER_KEY, analysisTabId); } catch(e) {}
}
function clearAnalysisOwnerIfMine() {
    try { if(localStorage.getItem(ANALYSIS_OWNER_KEY) === analysisTabId) localStorage.removeItem(ANALYSIS_OWNER_KEY); } catch(e) {}
}
function broadcastAnalysisClaim() {
    setAnalysisOwner();
    try { analysisChannel?.postMessage({ type: 'acas-analysis-claim', owner: analysisTabId, mode: getFloatingPanelMode() }); } catch(e) {}
}
function installAnalysisCoordination() {
    if(analysisCoordinationInstalled) return;
    analysisCoordinationInstalled = true;
    try {
        analysisChannel = new BroadcastChannel('acas-analysis-window');
        analysisChannel.onmessage = (ev) => {
            const data = ev?.data;
            if(!data || data.type !== 'acas-analysis-claim' || data.owner === analysisTabId) return;
            // Only window-mode tabs compete for the single window.
            if(data.mode !== 'window' || getFloatingPanelMode() !== 'window') return;
            closeAnalysisWindow();
        };
    } catch(e) { analysisChannel = null; }
    // localStorage fallback for browsers without BroadcastChannel.
    window.addEventListener('storage', (ev) => {
        if(ev.key !== ANALYSIS_OWNER_KEY || !ev.newValue || ev.newValue === analysisTabId) return;
        if(getFloatingPanelMode() !== 'window') return;
        closeAnalysisWindow();
    });
    const handleAppUnload = () => {
        // PiP is per-document: exiting it here only affects this tab.
        if(getFloatingPanelMode() === 'pip') {
            try { if(document.pictureInPictureElement) document.exitPictureInPicture(); } catch(e) {}
            return;
        }
        // Window mode: only the owning app tab closes the panel.
        // A non-owner tab closing must not kill the owner's window.
        if(getAnalysisOwner() !== analysisTabId) return;
        closeAnalysisWindow();
        clearAnalysisOwnerIfMine();
    };
    // pagehide fires on tab close, reload and navigation; with
    // persisted=true the page may come back from bfcache, so keep
    // the panel in that case. beforeunload is the fallback for
    // browsers that do not fire pagehide on close.
    window.addEventListener('pagehide', (ev) => { if(!ev.persisted) handleAppUnload(); });
    window.addEventListener('beforeunload', handleAppUnload);
}
let pipRetryArmed = false;

// A.C.A.S-MOD (Floating Panel Type, 26/10/2026): two modes, chosen in
// Floating Panel Settings > Regular settings > Floating Panel Type
// (data-key="pipMode", default "window"):
//   "window" — the current behaviour: a separate about:blank window
//     titled "Thanh Bình". It is NOT a PiP window, so it never takes
//     the browser's single PiP slot and YouTube PiP keeps working.
//   "pip" — the original behaviour: the panel canvas is streamed to a
//     <video> and shown with video.requestPictureInPicture(). This
//     DOES take the single PiP slot, so YouTube PiP cannot run at
//     the same time, exactly as in the original A.C.A.S.
export function getFloatingPanelMode() {
    const el = pipModeInput || document.querySelector('input[data-key="pipMode"]');
    const value = el?.value;
    return value === 'pip' ? 'pip' : 'window';
}

export async function closeFloatingPanel() {
    closeAnalysisWindow();
    try {
        if(document.pictureInPictureElement) await document.exitPictureInPicture();
    } catch(e) {}
}
let pipLastPipEval = null;
let pipLastPipBoardBitmaps = [null, null];
const PIP_CONTEXT_QUEUE_LIMIT = 30;

let pipContextQueue = [];
let pipProcessingBestMove = false;
let pipRefreshTimeout = null;
let lastProcessedDepth = null;
let pipRefreshRevision = 0;
let pipBoardCaptureRevision = 0;
let pipBackgroundCanvas = null;
let pipBackgroundTheme = null;

function getPipBackground() {
    const width = pipCanvas.width - pipEvalBarWidth;
    const height = pipCanvas.height;
    const theme = pipData.themeColorHex || '#5f8895';

    if(
        pipBackgroundCanvas?.width === width
        && pipBackgroundCanvas.height === height
        && pipBackgroundTheme === theme
    ) return pipBackgroundCanvas;

    const background = document.createElement('canvas');
    background.width = width;
    background.height = height;

    const ctx = background.getContext('2d');
    if(!ctx) return null;

    ctx.fillStyle = theme;
    ctx.fillRect(0, 0, width, height);

    const tile = getBackgroundGrainTile();
    const grain = tile && ctx.createPattern(tile, 'repeat');

    if(grain) {
        ctx.fillStyle = grain;
        ctx.fillRect(0, 0, width, height);
    }

    // Rebuild only on theme/size changes. Normal PiP updates copy one bitmap;
    // no noise generation, image decoding or additional refresh loop is needed.
    pipBackgroundCanvas = background;
    pipBackgroundTheme = theme;

    return background;
}

function resizePipCanvas() {
    if(!pipCanvas) return;

    const isBoard = pipBoardInput.checked;
    const width = 400;
    const height = isBoard ? 400 : 200;

    if(pipCanvas.width === width && pipCanvas.height === height) return;

    pipCanvas.width = width;
    pipCanvas.height = height;

    if(pipVideo) {
        pipVideo.width = width / 2;
        pipVideo.height = height / 2;
    }

    // The existing canvas stream follows its new aspect ratio without reopening
    // PIP. Never replay drawing commands made for the previous dimensions.
    pipContextQueue = [];
    pipProcessingBestMove = false;
}


export function isAnalysisWindowOpen() {
    try { return !!analysisWin && !analysisWin.closed; }
    catch(e) { return false; }
}

export function closeAnalysisWindow() {
    if(isAnalysisWindowOpen()) {
        try { analysisWin.close(); } catch(e) {}
    }
    analysisWin = null;
    analysisCanvas = null;
    clearAnalysisOwnerIfMine();
}

// Copy the just-drawn panel canvas into the analysis window, if it is open.
// Called from updatePipContext(), i.e. after every panel redraw, so the
// window always shows the same frame the old PiP video used to show.
//
// A.C.A.S-MOD (resize-full): the canvas no longer keeps the panel's fixed
// 400x200 / 400x400 size. It always takes the analysis window's current
// inner size and the frame is drawn stretched to exactly that size, so
// resizing the window fills it completely instead of leaving a black
// strip on the right/bottom. The old resizeTo() back to the panel size
// is deliberately gone: it used to fight the user's resize.
function syncAnalysisWindow() {
    // Prune a window the user closed by hand: otherwise the stale reference
    // lingers (openAnalysisWindow() would still recover, but this is cleaner).
    try {
        if(analysisWin && analysisWin.closed) { analysisWin = null; analysisCanvas = null; return; }
    } catch(e) { analysisWin = null; analysisCanvas = null; return; }
    // Recover if the canvas belongs to a document that is no longer the
    // window's current document: drawing to a detached canvas is
    // invisible, which is exactly the black-window symptom seen when
    // the window navigated to a real page.
    if(analysisCanvas) {
        try {
            if(analysisCanvas.ownerDocument !== analysisWin.document
                || !analysisWin.document.contains(analysisCanvas)) {
                analysisCanvas = null;
                grabAnalysisCanvas();
            }
        } catch(e) { analysisCanvas = null; }
    }
    if(!isAnalysisWindowOpen() || !analysisCanvas || !pipCanvas) return;

    try {
        const targetWidth = Math.max(1, analysisWin.innerWidth || pipCanvas.width);
        const targetHeight = Math.max(1, analysisWin.innerHeight || pipCanvas.height);

        if(analysisCanvas.width !== targetWidth || analysisCanvas.height !== targetHeight) {
            analysisCanvas.width = targetWidth;
            analysisCanvas.height = targetHeight;
        }
        // The page's own CSS is width:100vw / height:100vh, so the canvas
        // already stretches visually between frames; matching its bitmap
        // size to the window here keeps the redraw sharp at the new size.
        try {
            analysisCanvas.style.width = '100vw';
            analysisCanvas.style.height = '100vh';
        } catch(e) {}

        const ctx = analysisCanvas.getContext('2d');
        if(!ctx) return;
        ctx.clearRect(0, 0, analysisCanvas.width, analysisCanvas.height);
        ctx.drawImage(pipCanvas, 0, 0, analysisCanvas.width, analysisCanvas.height);
    } catch(e) {
        // The window was closed by the user between the open check and the
        // draw: drop the reference and stay silent. The next Floating Panel
        // toggle reopens it; we never reopen it unprompted here.
        analysisWin = null;
        analysisCanvas = null;
    }
}

// A.C.A.S-MOD (privacy, 25/10/2026): the analysis window is back to
// about:blank, on the user's explicit request — no address is shown in
// its address bar any more. Its title is still "Thanh Bình". This also
// avoids the black-window bug of the real-page version: an about:blank
// window's document is available synchronously and never navigates
// away, so the canvas created here can never become detached by a
// navigation. (app/analysis.html stays in the repo unused for now;
// push_files cannot delete files, so it is left in place.)
function grabAnalysisCanvas() {
    try {
        if(!isAnalysisWindowOpen()) return false;
        let canvas = analysisWin.document.getElementById('acas-analysis-canvas');
        if(!canvas && analysisWin.document.body) {
            canvas = analysisWin.document.createElement('canvas');
            canvas.id = 'acas-analysis-canvas';
            canvas.style.cssText = 'display:block;width:100vw;height:100vh;';
            analysisWin.document.body.appendChild(canvas);
        }
        if(!canvas) return false;
        analysisCanvas = canvas;
        syncAnalysisWindow();
        return true;
    } catch(e) { return false; }
}

function setupAnalysisWindow(win) {
    analysisWin = win;
    try {
        win.document.title = 'Thanh Bình';
        if(win.document.body) win.document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;';
        grabAnalysisCanvas();
        // Resize fills the window immediately, not only on the next
        // engine frame: the listener redraws at the new window size.
        win.addEventListener('resize', () => { syncAnalysisWindow(); });
        win.addEventListener('pagehide', () => {
            if(analysisWin === win) { analysisWin = null; analysisCanvas = null; }
        });
    } catch(e) {}
}

function openAnalysisWindow() {
    if(isAnalysisWindowOpen()) {
        try { analysisWin.focus(); } catch(e) {}
        // Re-grab the canvas in case the window was reloaded since it
        // opened, or the old canvas was detached (black window).
        if(!grabAnalysisCanvas()) setupAnalysisWindow(analysisWin);
        return analysisWin;
    }

    const width = pipCanvas ? pipCanvas.width : 400;
    const height = pipCanvas ? pipCanvas.height : 200;
    const availWidth = (window.screen && window.screen.availWidth) || 1280;
    const left = Math.max(0, availWidth - width - 32);
    const top = 32;
    const features = 'popup=yes,width=' + (width + 16) + ',height=' + (height + 40)
        + ',left=' + left + ',top=' + top + ',resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=yes,status=no';

    // about:blank on purpose (see setupAnalysisWindow): no address shown.
    let win = null;
    try { win = window.open('', ANALYSIS_WINDOW_NAME, features); } catch(e) { win = null; }
    if(!win) return null; // popup blocked: caller retries on the next click/keydown, silently

    analysisWin = win;
    analysisCanvas = null;
    setupAnalysisWindow(win);
    try { win.focus(); } catch(e) {}
    return win;
}

export function updatePipData(data) {
    if(data) Object.assign(pipData, data);

    if(data && (Object.hasOwn(data, 'moveObjects') || Object.hasOwn(data, 'hintsFiltered') || data.depth !== lastProcessedDepth)) {
        clearTimeout(pipRefreshTimeout);

        lastProcessedDepth = data.depth;

        pipRefreshTimeout = setTimeout(() => {
            refreshPipView(true);
        }, 25);
    }
}

export function resetPipHints(instance) {
    Object.values(instance.pV).forEach(variables => { delete variables.pipHints; });
    pipHintInstance = instance;
    updatePipData({ moveObjects: null, hintsFiltered: false });
}

export function updatePipHints(instance, profile, result) {
    if(result && !instance.instanceClosed && instance.pV[profile]) {
        instance.pV[profile].pipHints = { ...result, fen: instance.currentFen, revision: ++pipHintRevision };
        pipHintInstance = instance;
    }
    // Profile removal on another board must not replace the currently displayed hints.
    if(pipHintInstance !== instance) return;
    if(instance.instanceClosed) {
        pipHintInstance = null;
        updatePipData({ moveObjects: null, hintsFiltered: false });
        return;
    }

    const profiles = Object.values(instance.pV);
    const currentHints = variables => variables.pipHints?.fen === instance.currentFen ? variables.pipHints : null;
    const results = profiles.map(currentHints).filter(Boolean);
    // Preserve the latest visible profile rather than letting an empty profile win.
    const visible = results.filter(hints => hints.moveObjects.length)
        .sort((a, b) => b.revision - a.revision)[0];
    const awaitingHints = profiles.some(variables => variables.engineSettingsReady
        && (variables.multiPV ?? 2) > 0 && !currentHints(variables)
        && (!variables.chessVariants?.length || variables.chessVariants.includes(variables.chessVariant)));
    updatePipData({
        moveObjects: visible?.moveObjects ?? (results.length ? [] : null),
        hintsFiltered: !visible && !awaitingHints && results.some(hints => hints.hintsFiltered)
    });
}

window.REFRESH_PIP_DISPLAY = () => {
    clearTimeout(pipRefreshTimeout);
    refreshPipView(true);
};

async function renderPipBoards() {
    // Always capture the current board when refreshing PiP in board mode.
    // The best move can remain unchanged even when the actual chess position changes.
    const captureRevision = ++pipBoardCaptureRevision;

    const cgElem = document.querySelector(
        '.chessground-x[data-is-latest-updated="true"]'
    );

    if(!cgElem) return;

    const instanceId = cgElem.parentElement?.parentElement?.dataset?.instanceId;

    const { boardCanvas, overlayCanvas } = await captureBoardLayers(instanceId);

    if(!boardCanvas) return;

    const bitmap = await createImageBitmap(boardCanvas);

    const emptyOverlayCanvas = document.createElement('canvas');
    emptyOverlayCanvas.width = boardCanvas.width;
    emptyOverlayCanvas.height = boardCanvas.height;

    const bitmap2 = await createImageBitmap(
        overlayCanvas || emptyOverlayCanvas
    );

    // Captures are asynchronous. Discard an older capture if a newer refresh
    // started while this one was being rendered, so stale pixels cannot win a race.
    if(captureRevision !== pipBoardCaptureRevision) {
        bitmap.close?.();
        bitmap2.close?.();
        return;
    }

    const previousBitmaps = pipLastPipBoardBitmaps;
    pipLastPipBoardBitmaps = [bitmap, bitmap2];

    for(const previousBitmap of previousBitmaps) {
        previousBitmap?.close?.();
    }
}

async function captureBoardLayers(instanceId) {
    const boards = [
        ...document.querySelectorAll(
            '.chessground-x[data-is-latest-updated="true"]'
        )
    ];

    const cgElem = instanceId
        ? boards.find(
            elem =>
                elem.parentElement?.parentElement?.dataset?.instanceId
                === String(instanceId)
        ) || boards[0]
        : boards[0];

    if(!cgElem) {
        return { boardCanvas: null, overlayCanvas: null };
    }

    const rect = cgElem.getBoundingClientRect();

    cgElem.style.height = `${rect.width}px`;

    const acasInstance = window.AcasInstances?.find(
        i => String(i.id) === String(instanceId)
    );

    if(acasInstance?.instance?.chessground) {
        acasInstance.instance.chessground.redrawAll();
    }

    const boardCanvas = await snapdom.toCanvas(cgElem, { fast: true });

    const boardDrawerSvg = document.querySelector(
        `#board-drawings svg${instanceId ? `[data-instance-id="${instanceId}"]` : ''}`
    );

    if(!boardDrawerSvg) {
        return { boardCanvas, overlayCanvas: null };
    }

    const svg = boardDrawerSvg.cloneNode(true);
    svg.style.position = 'unset';

    const container = document.createElement('div');

    container.appendChild(svg);

    container.style.cssText = `
        position:absolute;
        left:-9999px;
        top:0;
        width:${rect.width}px;
        height:${rect.width}px;
    `;

    document.body.appendChild(container);

    try {
        const overlayCanvas = await snapdom.toCanvas(
            container,
            { fast: true }
        );

        return { boardCanvas, overlayCanvas };
    } finally {
        container.remove();
    }
}

window.CAPTURE_BOARD_IMAGE = async instanceId => {
    const { boardCanvas, overlayCanvas } = await captureBoardLayers(instanceId);

    if(!boardCanvas) return null;

    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = boardCanvas.width;
    outputCanvas.height = boardCanvas.height;

    const context = outputCanvas.getContext('2d');

    context.drawImage(boardCanvas, 0, 0);

    if(overlayCanvas) {
        context.drawImage(overlayCanvas, 0, 0);
    }

    return outputCanvas.toDataURL('image/png');
};

function updatePipContext() {
    const ctx = pipCanvas.getContext('2d');

    const latestQueueArr = pipProcessingBestMove
        ? pipContextQueue.find(x => x?.[0]?.[1] === pipProcessingBestMove)
        : pipContextQueue?.[0];

    if(latestQueueArr) {
        if(pipProcessingBestMove) {
            pipProcessingBestMove = false;
            pipContextQueue = [];
        }

        for(const [cmd, args] of latestQueueArr) {
            if(cmd in ctx) {
                if(Array.isArray(args)) ctx[cmd](...args);
                else ctx[cmd] = args;
            }
        }

        // Bake a compact bottom-left shade into the video, including native PiP.
        // Every queued frame clears the canvas first, so this never accumulates.
        ctx.save();

        const shade = ctx.createLinearGradient(
            0,
            pipCanvas.height,
            pipCanvas.width,
            0
        );

        shade.addColorStop(0, 'rgba(0, 0, 0, 0.38)');
        shade.addColorStop(0.18, 'rgba(0, 0, 0, 0.12)');
        shade.addColorStop(0.45, 'rgba(0, 0, 0, 0)');

        ctx.fillStyle = shade;
        ctx.fillRect(0, 0, pipCanvas.width, pipCanvas.height);
        ctx.restore();
    }

    syncAnalysisWindow();
}

async function refreshPipView() {
    const revision = ++pipRefreshRevision;
    const moveObjects = pipData.moveObjects;
    const ctxQueue = [];

    const playerColor = pipData.playerColor,
          bestMove = pipData?.moveObjects?.[0],
          sMove = pipData?.moveObjects?.[1],
          tMove = pipData?.moveObjects?.[2],
          from = bestMove?.player?.[0],
          to = bestMove?.player?.[1],
          sFrom = sMove?.player?.[0],
          sTo = sMove?.player?.[1],
          tFrom = tMove?.player?.[0],
          tTo = tMove?.player?.[1];

    const useSan = Boolean(pipSanInput?.checked);

    const isCurrentNotation = () =>
        pipData.moveObjects === moveObjects
        && Boolean(pipSanInput?.checked) === useSan
        && !CONCEAL_ASSISTANCE_ACTIVE;

    const [bestMoveText, secondMoveText, thirdMoveText] = await Promise.all(
        [bestMove, sMove, tMove].map(
            move => formatMoveNotationAsync(
                move,
                useSan,
                false,
                undefined,
                isCurrentNotation
            )
        )
    );

    if(
        revision !== pipRefreshRevision
        || pipData.moveObjects !== moveObjects
        || Boolean(pipSanInput?.checked) !== useSan
    ) return;

    const centipawnEval = pipData?.centipawnEval / 100;

    const filteredText = TRANS_OBJ?.moveSpeech?.hintsFiltered ?? 'Suggestions filtered';
    const hintsFiltered = !moveObjects?.length && pipData.hintsFiltered && !CONCEAL_ASSISTANCE_ACTIVE;
    const mediaTitle = from && !CONCEAL_ASSISTANCE_ACTIVE
        ? bestMoveText
        : hintsFiltered ? filteredText : `Hold on, I'm thinking...`;

    let engineEvaluation = pipData?.eval;
    let progress = 0;

    if(engineEvaluation == null) {
        // Fall back to the last known eval (or an even 0.5 on the very first refresh).
        // Use == null so a legitimate 0 (a lost position) is treated as a real value.
        engineEvaluation = pipLastPipEval === null ? 0.5 : pipLastPipEval;
    } else {
        pipLastPipEval = engineEvaluation;
    }

    if(
        (pipData.goalDepth && pipData.goalDepth < 100)
        || (pipData.depth === null)
    ) {
        const depth = pipData.depth || pipData.goalDepth;

        progress = depth / pipData.goalDepth;
    } else if(pipData?.goalNodes) {
        progress = pipData?.nodes / pipData?.goalNodes;
    } else {
        progress = CALC_TIME_PROGRESS(
            pipData.startTime,
            pipData.movetime
        );
    }

    setMediaMetadata({
        title: mediaTitle,
        artist: `Depth ${pipData?.depth ?? 0} (${Math.round((progress ?? 0) * 100)}%) | Eval ${
            Number.isFinite(centipawnEval)
                ? centipawnEval.toFixed(2)
                : "0.00"
        }`
    });

    if(!pipCanvas) return; // do not continue if pip is not enabled

    resizePipCanvas();

    if(bestMove) {
        ctxQueue.push(['bestmove', from + to]);
        pipProcessingBestMove = from + to;
    }

    const isBoard = pipBoardInput.checked;

    if(isBoard) await renderPipBoards();

    if(
        revision !== pipRefreshRevision
        || pipData.moveObjects !== moveObjects
    ) return;

    const headerWidth = pipCanvas.width - pipEvalBarWidth;
    const pipMaxTextWidth = headerWidth - 28;
    const alternativeWidth = (headerWidth - 48) / 2;
    const thirdMoveX = 32 + alternativeWidth;

    const noInstancesText =
        FULL_TRANS_OBJ?.domTranslations?.['#no-instances-title'];

    // Clear canvas
    ctxQueue.push([
        'clearRect',
        [0, 0, pipCanvas.width, pipCanvas.height]
    ]);

    // Grain stays behind the header, notation and board, not over their pixels.
    const background = getPipBackground();

    if(background) {
        ctxQueue.push(['drawImage', [background, 0, 0]]);
    } else {
        ctxQueue.push([
            'fillStyle',
            pipData.themeColorHex || '#5f8895'
        ]);
        ctxQueue.push([
            'fillRect',
            [0, 0, headerWidth, pipCanvas.height]
        ]);
    }

    // Header background
    ctxQueue.push(['fillStyle', 'rgba(0, 0, 0, 0.7)']);
    ctxQueue.push([
        'fillRect',
        [0, 0, headerWidth, pipHeaderHeight - pipStatusBarHeight]
    ]);

    // Header title
    ctxQueue.push(['fillStyle', 'white']);
    ctxQueue.push(['font', `800 ${pipFontSizes.medium}px Mona Sans`]);
    ctxQueue.push(['fillText', ['A.C.A.S', 12, 32]]);

    // Subtext font
    ctxQueue.push(['fillStyle', 'rgba(255, 255, 255, 0.7)']);
    ctxQueue.push([
        'font',
        `500 ${pipFontSizes.medium}px IBM Plex Sans`
    ]);

    if(pipData?.moveProgressText || hintsFiltered) {
        const headerOffset = 36;

        ctxQueue.push([
            'fillText',
            [
                hintsFiltered ? filteredText : pipData.moveProgressText,
                12,
                pipHeaderHeight + headerOffset,
                pipMaxTextWidth
            ]
        ]);
    } else if(
        noInstancesText
        && !pipData?.moveObjects
        && to !== 'one)'
    ) {
        ctxQueue.push([
            'font',
            `700 ${pipFontSizes.medium}px IBM Plex Sans`
        ]);

        ctxQueue.push([
            'fillText',
            [noInstancesText, 12, pipHeaderHeight + 40, pipMaxTextWidth]
        ]);

        ctxQueue.push([
            'fillText',
            ['ദ്ദി(˵ •̀ ᴗ - ˵ ) ✧', 12, pipHeaderHeight + 80, pipMaxTextWidth]
        ]);
    }

    // Time + progress
    if(pipData.calculationTimeElapsed) {
        const timeMs = pipData.calculationTimeElapsed;

        const timeFormatted = timeMs > 9999
            ? `${(timeMs / 1000).toFixed(1)}s`
            : `${timeMs}ms`;

        const progressPercent = (progress * 100).toFixed(0);

        ctxQueue.push(['fillStyle', 'rgba(255, 255, 255, 0.5)']);
        ctxQueue.push([
            'font',
            `500 ${pipFontSizes.small}px Mona Sans`
        ]);

        ctxQueue.push([
            'fillText',
            [
                `(${timeFormatted}, ${progressPercent}%)`,
                120,
                28,
                headerWidth - 132
            ]
        ]);
    }

    ctxQueue.push(['fillStyle', 'white']);
    ctxQueue.push([
        'font',
        `900 ${pipFontSizes.large}px Mona Sans`
    ]);

    // Board rendering
    if(isBoard) {
        const [bitmap, bitmap2] = pipLastPipBoardBitmaps;

        if(bitmap) {
            ctxQueue.push([
                'drawImage',
                [bitmap, ...pipBoardConfig, pipBoardSize]
            ]);

            ctxQueue.push([
                'drawImage',
                [bitmap2, ...pipBoardConfig, pipBoardSize]
            ]);
        }
    // Text-based rendering
    } else {
        if(to === 'one)') {
            ctxQueue.push([
                'fillText',
                ['≽(•⩊ •マ≼', 16, pipHeaderHeight + 100, pipMaxTextWidth]
            ]);
        } else if(bestMove && !CONCEAL_ASSISTANCE_ACTIVE) {
            ctxQueue.push([
                'fillText',
                [bestMoveText, 16, pipHeaderHeight + 100, pipMaxTextWidth]
            ]);
        }

        if(sFrom && sTo && !CONCEAL_ASSISTANCE_ACTIVE) {
            ctxQueue.push([
                'fillStyle',
                'rgba(255, 255, 255, 0.5)'
            ]);

            ctxQueue.push([
                'font',
                `500 ${pipFontSizes.medium}px Mona Sans`
            ]);

            ctxQueue.push([
                'fillText',
                [
                    `2. (${secondMoveText})`,
                    16,
                    pipHeaderHeight + 135,
                    alternativeWidth
                ]
            ]);
        }

        if(tFrom && tTo && !CONCEAL_ASSISTANCE_ACTIVE) {
            ctxQueue.push([
                'fillText',
                [
                    `3. (${thirdMoveText})`,
                    thirdMoveX,
                    pipHeaderHeight + 135,
                    alternativeWidth
                ]
            ]);
        }
    }

    // Progress bar
    ctxQueue.push(['fillStyle', 'rgba(0, 0, 0, 0.1)']);
    ctxQueue.push([
        'fillRect',
        [
            0,
            pipHeaderHeight,
            (pipCanvas.width - pipEvalBarWidth) * progress,
            pipCanvas.height - pipHeaderHeight
        ]
    ]);

    // Eval bar background + foreground
    if(playerColor === 'b') {
        ctxQueue.push(['fillStyle', 'rgba(50, 50, 50, 1)']);
        ctxQueue.push([
            'fillRect',
            [
                pipCanvas.width - pipEvalBarWidth,
                0,
                pipEvalBarWidth,
                pipCanvas.height
            ]
        ]);

        ctxQueue.push(['fillStyle', 'rgba(200, 200, 200, 1)']);
        ctxQueue.push([
            'fillRect',
            [
                pipCanvas.width - pipEvalBarWidth,
                0,
                pipEvalBarWidth,
                pipCanvas.height * engineEvaluation
            ]
        ]);
    } else {
        ctxQueue.push(['fillStyle', 'rgba(200, 200, 200, 1)']);
        ctxQueue.push([
            'fillRect',
            [
                pipCanvas.width - pipEvalBarWidth,
                0,
                pipEvalBarWidth,
                pipCanvas.height
            ]
        ]);

        ctxQueue.push(['fillStyle', 'rgba(50, 50, 50, 1)']);
        ctxQueue.push([
            'fillRect',
            [
                pipCanvas.width - pipEvalBarWidth,
                0,
                pipEvalBarWidth,
                pipCanvas.height * (1 - engineEvaluation)
            ]
        ]);
    }

    if(!pipData?.mate && centipawnEval) {
        const yPosition = playerColor === 'w'
            ? (centipawnEval < 0 ? 24 : pipCanvas.height - 12)
            : (centipawnEval > 0 ? 24 : pipCanvas.height - 12);

        const evalText = Math.abs(centipawnEval).toFixed(1);

        ctxQueue.push(['fillStyle', 'rgba(125, 125, 125, 1)']);
        ctxQueue.push([
            'font',
            `800 ${pipFontSizes.esmall}px Mona Sans`
        ]);

        ctxQueue.push([
            'fillText',
            [
                evalText,
                headerWidth + [14, 11, 6, 2, 0, 0][evalText.length - 1],
                yPosition
            ]
        ]);
    }

    // Status bar
    ctxQueue.push([
        'fillStyle',
        [
            'rgba(40, 40, 40, 0.9)',
            'rgba(0, 255, 0, 1)',
            'rgba(255, 0, 0, 1)'
        ][pipData.isWinning ?? 0]
    ]);

    ctxQueue.push([
        'fillRect',
        [
            0,
            pipHeaderHeight - pipStatusBarHeight,
            headerWidth,
            pipStatusBarHeight
        ]
    ]);

    pipContextQueue.unshift(ctxQueue);

    // The queue was only emptied once a bestmove arrived. During a long search
    // updatePipData fires on every info line, so it grew for the whole session.
    if(pipContextQueue.length > PIP_CONTEXT_QUEUE_LIMIT) {
        pipContextQueue.length = PIP_CONTEXT_QUEUE_LIMIT;
    }

    updatePipContext();
}

export async function startPictureInPicture() {
    // Legacy name kept so gui.js / settingChangeObserver.js need no import
    // change. Behaviour now branches on Floating Panel Type (see
    // getFloatingPanelMode above): "window" is the A.C.A.S-MOD default,
    // "pip" restores the original Picture-in-Picture behaviour.
    const mode = getFloatingPanelMode();

    const video = document.createElement('video');

    pipVideo = video;
    pipCanvas = document.createElement('canvas');

    resizePipCanvas();

    const stream = pipCanvas.captureStream();
    video.srcObject = stream;

    floatingPanelVideoElem.innerHTML = '';
    floatingPanelVideoElem.appendChild(video);

    if(mode === 'pip') {
        installAnalysisCoordination();
        // Original PiP path: close the analysis window if it is open
        // (switching from Window mode), then play + request PiP.
        // Deliberately no auto Floating Panel Settings dialog here:
        // opening the app page must only open the panel, never pop
        // the settings dialog on its own (A.C.A.S-MOD, 25/10/2026).
        closeAnalysisWindow();

        const attemptPlay = async () => {
            try {
                refreshPipView();
                await video.play();
                if(video?.requestPictureInPicture) {
                    await video.requestPictureInPicture();
                }
            } catch(err) {
                if(err.name === 'NotAllowedError') {
                    if(!pipRetryArmed) {
                        pipRetryArmed = true;
                        const handleUserInteraction = async () => {
                            document.removeEventListener('click', handleUserInteraction);
                            document.removeEventListener('keydown', handleUserInteraction);
                            pipRetryArmed = false;
                            await attemptPlay();
                        };
                        document.addEventListener('click', handleUserInteraction);
                        document.addEventListener('keydown', handleUserInteraction);
                    }
                } else {
                    console.error(err);
                }
            }
        };

        await attemptPlay();
        refreshPipView();
        return;
    }

    // Window path (default, A.C.A.S-MOD): this NO LONGER requests a
    // PiP window and never touches the browser's single PiP slot, so
    // YouTube video PiP keeps working at the same time. If a PiP
    // window is still open from a previous PiP-mode session, exit it.
    try {
        if(document.pictureInPictureElement) await document.exitPictureInPicture();
    } catch(e) {}

    // Single window: claim ownership first, so any other app tab
    // closes its panel window. If another tab owned it until now,
    // wait for its close to land before opening ours, otherwise
    // this tab could open a second window (or reuse-then-lose the
    // old one) before the old one is gone.
    installAnalysisCoordination();
    const previousOwner = getAnalysisOwner();
    broadcastAnalysisClaim();
    if(previousOwner && previousOwner !== analysisTabId && !isAnalysisWindowOpen()) {
        await new Promise(r => setTimeout(r, 200));
    }

    // Keep the in-page stream playing (and the silent-audio track, when the
    // page has one) for the same stability the old PiP playback gave, minus
    // the PiP window itself. Playback may need a user gesture; failures are
    // retried together with the window open below.
    const attemptPlay = async () => {
        try { await video.play(); } catch(e) {}
        try {
            const silence = document.querySelector('#silence-audio');
            if(silence) await silence.play();
        } catch(e) {}
    };

    const attemptOpen = () => {
        const win = openAnalysisWindow();
        if(win) {
            refreshPipView();
            return true;
        }
        return false;
    };

    await attemptPlay();

    if(!attemptOpen()) {
        // A.C.A.S-MOD (no auto dialog): popup blocked, or no user gesture
        // yet (this also runs on page load when Floating Panel defaults
        // to on). Do NOT open the "Floating Panel Settings" dialog here:
        // opening the app page must only open the analysis window, never
        // pop the settings dialog on its own. Just retry the window
        // silently on the next click/keydown (a real user gesture, which
        // is what browsers require for window.open). If popups are still
        // blocked after that, the user can allow popups for this site and
        // click the page once, or open the settings dialog by hand with
        // its ⚙️ button. The fallback is deliberately NOT PiP: falling
        // back to PiP would steal YouTube's PiP slot again.
        if(!analysisWinRetryArmed) {
            analysisWinRetryArmed = true;
            const handleUserInteraction = async () => {
                if(attemptOpen()) {
                    document.removeEventListener('click', handleUserInteraction);
                    document.removeEventListener('keydown', handleUserInteraction);
                    analysisWinRetryArmed = false;
                }
                await attemptPlay();
            };
            document.addEventListener('click', handleUserInteraction);
            document.addEventListener('keydown', handleUserInteraction);
        }
    }

    refreshPipView();
}
