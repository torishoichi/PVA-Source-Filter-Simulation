/**
 * Source-Filter Simulation (PVA Model)
 * main.js
 */

// --- Audio Context and Nodes ---
let audioCtx = null;
let masterGain = null;
let analyser = null;
let isPlaying = false;
let isPresetLoading = false;
// Source nodes
let fundamentalOsc = null;
let harmonicsOscs = [];
let spectralTiltNode = null;

// Filter nodes (Vocal Tract Resonances)
let f1Node = null;
let f2Node = null;
let f3Node = null;
let f4Node = null;
let f5Node = null;

let visF1Node = null, visF2Node = null, visF3Node = null, visF4Node = null, visF5Node = null;
let visSpectralTiltNode = null;
let visMasterGain = null;
let silentTarget = null;

let noiseNode = null;
let noiseFilter = null;
let noiseGain = null;

let micStream = null;
let micSource = null;
let micGainNode = null;
let micAnalyser = null;        // fftSize=4096, used for spectrum & formant analysis
let micAnalyserPitch = null;   // fftSize=2048, dedicated to YIN → cuts pitch latency ~half

// LPC v2/v3: persistent buffers for the shared LPC pipeline + per-method smoothing state
const LPC_V2_HISTORY_LEN = 3;
const lpcCoreState = {
    timeBuf: null,
    preEmp: null,
    decimated: null,
    burgF: null,
    burgB: null,
    // Snapshot of the most recent successful LPC frame (used for envelope visualization)
    lastCoefs: null,
    lastP: 0,
    lastDecSr: 0,
    lastUpdate: 0,
    // Multi-frame averaging of reflection coefficients (Praat-style stabilization)
    kHistory: [],
    lastVoicedTime: 0
};
const LPC_K_HISTORY_LEN = 3;
// Below this per-frame confidence (voicing × sharpness × completeness), the v3
// formant readout freezes at its last value instead of chasing a shaky estimate.
const LPC_CONF_GATE = 0.45;
const lpcV2State = {
    history: { f1: [], f2: [], f3: [], f4: [], f5: [] },
    smoothed: { f1: null, f2: null, f3: null, f4: null, f5: null },
    lastVoiced: 0
};
// One-Euro filter state for v3 (per-formant)
const lpcV3State = {
    filters: { f1: null, f2: null, f3: null, f4: null, f5: null },
    lastVoiced: 0
};
// --- Burg LPC ---
// Computes reflection coefficients k[1..p] directly from time-domain forward/backward
// prediction errors. More accurate than autocorrelation method for short windows.
// Sign convention: A(z) = 1 - sum(a[i] * z^-i). Returns Float64Array length p+1 (k[0] unused),
// or null if numerically failed at order 1.
function burgLpc(x, N, p) {
    if (!lpcCoreState.burgF || lpcCoreState.burgF.length !== N) {
        lpcCoreState.burgF = new Float64Array(N);
        lpcCoreState.burgB = new Float64Array(N);
    }
    const f = lpcCoreState.burgF;
    const b = lpcCoreState.burgB;
    for (let i = 0; i < N; i++) { f[i] = x[i]; b[i] = x[i]; }

    const k = new Float64Array(p + 1);
    for (let m = 1; m <= p; m++) {
        let num = 0, denom = 0;
        for (let n = m; n < N; n++) {
            num += f[n] * b[n - 1];
            denom += f[n] * f[n] + b[n - 1] * b[n - 1];
        }
        if (denom < 1e-18) {
            if (m === 1) return null;
            for (let j = m; j <= p; j++) k[j] = 0;
            return k;
        }
        const km = 2 * num / denom;
        if (Math.abs(km) >= 0.999 || !isFinite(km)) {
            if (m === 1) return null;
            for (let j = m; j <= p; j++) k[j] = 0;
            return k;
        }
        k[m] = km;
        // Update forward/backward errors. Both f[n] and b[n] depend on the old f[n] and b[n-1],
        // and we overwrite b[n] (not b[n-1]) — so a forward pass is safe.
        for (let n = N - 1; n >= m; n--) {
            const fn = f[n], bn1 = b[n - 1];
            f[n] = fn - km * bn1;
            b[n] = bn1 - km * fn;
        }
    }
    return k;
}

// Convert reflection coefficients k[1..p] to prediction coefficients a[0..p]
// such that A(z) = 1 - sum(a[i] * z^-i).
function reflectionsToPredictions(k, p) {
    const a = new Float64Array(p + 1);
    a[0] = 1;
    for (let m = 1; m <= p; m++) {
        const km = k[m];
        if (km === 0) continue;
        const aPrev = a.slice(0, m);
        a[m] = km;
        for (let i = 1; i < m; i++) {
            a[i] = aPrev[i] - km * aPrev[m - i];
        }
    }
    return a;
}

function makeOneEuro() {
    return {
        prevX: null,
        prevDx: 0,
        prevT: 0,
        // Tunings: minCutoff (Hz) — smoothing at rest; beta — speed-coupling; dCutoff — derivative smoothing
        minCutoff: 1.2,
        beta: 0.06,
        dCutoff: 1.0
    };
}
function oneEuroStep(s, x, tMs) {
    if (s.prevX == null) {
        s.prevX = x; s.prevT = tMs; s.prevDx = 0;
        return x;
    }
    const dtSec = Math.max(1e-3, (tMs - s.prevT) / 1000);
    const dx = (x - s.prevX) / dtSec;
    const aD = (2 * Math.PI * dtSec * s.dCutoff) / (1 + 2 * Math.PI * dtSec * s.dCutoff);
    const dxHat = aD * dx + (1 - aD) * s.prevDx;
    const cutoff = s.minCutoff + s.beta * Math.abs(dxHat);
    const aX = (2 * Math.PI * dtSec * cutoff) / (1 + 2 * Math.PI * dtSec * cutoff);
    const xHat = aX * x + (1 - aX) * s.prevX;
    s.prevX = xHat; s.prevDx = dxHat; s.prevT = tMs;
    return xHat;
}

// --- Environment ---
const IS_MOBILE = location.pathname.endsWith('mobile.html');
const HARMONIC_LABEL = (h) => `H${h}`;
const MAX_HARMONICS_ON_SPECTRUM = IS_MOBILE ? 10 : Infinity;

// --- State Variables ---
const state = {
    voiceType: 'nontreble', // 'treble' or 'nontreble'
    pitch: 220, // A3
    mechanism: 'm1', // 'm1' or 'm2'
    pressure: 1.0, // Subglottal Pressure (P)
    resistance: 1.0, // Glottal Resistance (R)
    airflow: 1.0, // Calculated (U = P/R)
    phonationMode: 'flow', // 'flow', 'pressed', 'breathy'
    timbreState: 'Open', // 'Open' or 'Close'
    isMicActive: false,
    isMicPaused: false,
    cachedMicData: null,
    cachedMicPitch: -1,
    cachedMicLevel: 0,         // mic RMS amplitude (0..~0.5), drives Vowel Space dot size
    cachedMicFormantConfidence: 1, // 0..1 confidence of the latest v3 formant frame
    cachedMicFormants: null, // Per-formant snapshot (preserved during pause and brief live dropouts)
    cachedMicFormantsTime: null, // Per-formant last-update timestamp (ms)
    loudnessCeilingDb: -18,    // user-set loudness ceiling (dB RMS); guards over-singing / pressed-loud
    loudnessDb: -90,           // EMA-smoothed current loudness (dB), for the ceiling meter
    micGain: 1.0,
    micDeviceId: null,         // null = browser default
    micDevices: [],            // populated after first permission grant
    micFormantMethod: 'lpc-v3', // 'peak' | 'lpc' | 'lpc-v2' | 'lpc-v3'
    spectrumSlope: -12, // dB/octave attenuation
    showSlopeLine: true, // Toggle for slope approximation line (default ON)
    acousticMode: 'Neutral', // 'Neutral', 'Yell', 'Whoop'
    masterVolume: 0.5, // 0.0 to 1.0
    rdManual: null, // null = auto from P/R/mechanism, number = manual Rd override
    logScale: false, // Toggle for logarithmic frequency axis
    roughnessVisible: false, // Toggle for roughness zone overlay (ERB + 5kHz ceiling)
    selectionActive: false,
    selectionMinFreq: 0,
    selectionMaxFreq: 0,
    formants: {
        f1: { freq: 500, q: 5, gain: 15, enabled: true },
        f2: { freq: 1500, q: 6, gain: 12, enabled: true },
        f3: { freq: 2800, q: 8, gain: 10, enabled: true },
        f4: { freq: 3800, q: 10, gain: 8, enabled: true },
        f5: { freq: 4800, q: 12, gain: 6, enabled: true }
    },
    vibrato: {
        enabled: true,
        rate: 6.4,        // Hz
        extent: 2,        // cents
        onsetDelay: 300,  // ms
        onsetRamp: 400,   // ms
        amDepth: 4,       // %
        waveform: 'sine'  // 'sine' | 'triangle' | 'sawtooth'
    },
    viewMode: 'spectrum', // 'spectrum' | 'spectrogram'
    vowelSpace: {
        trail: [],       // [{t, f1, f2}], rolling ~1.5s
        language: 'jp',  // 'jp' | 'en'
        mode: 'basic',   // 'basic' | 'advanced'
        voiceType: 'male', // 'male' | 'female' | 'child' | 'me' (per-user)
        nearest: null,
        calibration: {
            active: false,
            step: 0,
            phase: 'prepare', // 'prepare' | 'record'
            phaseStart: 0,
            samples: [],
            results: [],
            saved: null,       // { jp: [{ipa, label, f1, f2}], en: [...] }
        },
    },
    vibratoAnalysis: {
        pitchBuf: [],     // [{t: ms, hz: number|null}], rolling 5s
        rate: 0,          // Hz
        extent: 0,        // cents (single-side amplitude, LS-fit)
        regularity: 0,    // 0–1
        confidence: 0,    // 0–1 (composite quality score)
        verdict: '—',
        f0Median: 0,      // Hz, median over analysis window
        fitOmega: 0,      // rad/sample at sampleRate, for sine overlay
        fitA: 0,          // cos coefficient
        fitB: 0,          // sin coefficient
        fitSampleRate: 0, // samples/sec for trace
        fitT0: 0,         // anchor time (ms) for sine overlay
        lastAnalysisAt: 0,
        trace: [],        // [{t, cents}] — null cents where unvoiced
    }
};

// Vibrato audio nodes
let vibratoLFO = null;
let vibratoFMGain = null;
let vibratoAMGain = null;

// --- DOM Elements ---
const els = {
    btnPlay: document.getElementById('audio-toggle'),
    btnMic: document.getElementById('mic-toggle'),
    btnMicPause: document.getElementById('mic-pause'),
    btnMicRecord: document.getElementById('mic-record'),
    micRecordTimer: document.getElementById('mic-record-timer'),
    recordingsList: document.getElementById('recordings-list'),
    recordingsMeta: document.getElementById('recordings-meta'),
    recordingsEmpty: document.getElementById('recordings-empty'),
    btnImport: document.getElementById('rec-import-btn'),
    importInput: document.getElementById('rec-import-input'),
    recordingsPanel: document.getElementById('recordings-panel'),
    playbackControls: document.getElementById('playback-controls'),
    pbSeek: document.getElementById('pb-seek'),
    pbRate: document.getElementById('pb-rate'),
    pbLoop: document.getElementById('pb-loop'),
    pbCurTime: document.getElementById('pb-cur-time'),
    pbTotalTime: document.getElementById('pb-total-time'),
    pbSeekWrap: document.getElementById('pb-seek-wrap'),
    pbRegion: document.getElementById('pb-region'),
    pbHandleA: document.getElementById('pb-handle-a'),
    pbHandleB: document.getElementById('pb-handle-b'),
    btnSlopeLine: document.getElementById('slope-line-toggle'),
    btnLogScale: document.getElementById('log-scale-toggle'),
    btnRoughness: document.getElementById('roughness-toggle'),
    roughnessLegend: document.getElementById('roughness-legend'),
    pitchMirror: document.getElementById('rl-pitch-mirror'),
    btnFullscreen: document.getElementById('spectrum-fullscreen-btn'),
    micMethodSelect: document.getElementById('mic-formant-method'),
    canvas: document.getElementById('spectrum-canvas'),
    spectrogramCanvas: document.getElementById('spectrogram-canvas'),
    viewTabs: document.getElementById('view-tabs'),
    vibratoPanel: document.getElementById('vibrato-panel'),
    vibratoCanvas: document.getElementById('vibrato-canvas'),
    vibRate: document.getElementById('vib-rate'),
    vibExtent: document.getElementById('vib-extent'),
    vibRegularity: document.getElementById('vib-regularity'),
    vibConfidence: document.getElementById('vib-confidence'),
    vibVerdict: document.getElementById('vib-verdict'),
    vibVerdictBox: document.getElementById('vib-verdict-box'),
    vibF0: document.getElementById('vib-f0'),
    vibAnalysisBody: document.getElementById('vib-analysis-body'),
    vibQualityFill: document.getElementById('vib-quality-fill'),
    vibModeTabs: document.getElementById('vib-mode-tabs'),
    vibSynthRate: document.getElementById('vib-synth-rate'),
    vibSynthExtent: document.getElementById('vib-synth-extent'),
    vibSynthDelay: document.getElementById('vib-synth-delay'),
    vibSynthRamp: document.getElementById('vib-synth-ramp'),
    vibSynthAm: document.getElementById('vib-synth-am'),
    vibSynthWave: document.getElementById('vib-synth-wave'),
    vibSynthStatus: document.getElementById('vib-synth-status'),
    vowelSpacePanel: document.getElementById('vowel-space-panel'),
    vowelSpaceCanvas: document.getElementById('vowel-space-canvas'),
    vsBody: document.getElementById('vs-body'),
    vsLangTabs: document.getElementById('vs-lang-tabs'),
    vsVoiceTabs: document.getElementById('vs-voice-tabs'),
    vsCalibrateBtn: document.getElementById('vs-calibrate-btn'),
    vsModeTabs: document.getElementById('vs-mode-tabs'),
    vsNearest: document.getElementById('vs-nearest'),
    vsF1: document.getElementById('vs-f1'),
    vsF2: document.getElementById('vs-f2'),
    vsF3: document.getElementById('vs-f3'),
    vsRatio: document.getElementById('vs-ratio'),
    loudFill: document.getElementById('loud-fill'),
    loudMarker: document.getElementById('loud-marker'),
    loudVal: document.getElementById('loud-val'),
    loudCeilSlider: document.getElementById('loud-ceiling'),
    loudCeilVal: document.getElementById('loud-ceiling-val'),
    masterVolume: document.getElementById('master-volume'),
    micGainSlider: document.getElementById('mic-gain'),
    micDeviceSelect: document.getElementById('mic-device-select'),
    spectrumSlopeSlider: document.getElementById('spectrum-slope'),
    volumeVal: document.getElementById('volume-val'),
    slopeVal: document.getElementById('slope-val'),
    micGainVal: document.getElementById('mic-gain-val'),

    // Source
    voiceTypeSelect: document.getElementById('voice-type-select'),
    pitchSlider: document.getElementById('pitch-slider'),
    pitchVal: document.getElementById('pitch-val'),
    pitchNote: document.getElementById('pitch-note'),
    mechM1: document.getElementById('mech-m1'),
    mechM2: document.getElementById('mech-m2'),
    pressureSlider: document.getElementById('pressure-slider'),
    pressureVal: document.getElementById('pressure-val'),
    resistanceSlider: document.getElementById('resistance-slider'),
    resistanceVal: document.getElementById('resistance-val'),
    airflowVal: document.getElementById('airflow-val'),
    modeStatus: document.getElementById('mode-status'),

    // Acoustic Tracker
    timbreState: document.getElementById('timbre-state'),
    acousticMode: document.getElementById('acoustic-mode'),
    eventFlash: document.getElementById('event-flash'),

    // Vibrato
    vibratoEnable: document.getElementById('vibrato-enable'),
    vibratoRate: document.getElementById('vibrato-rate'),
    vibratoRateVal: document.getElementById('vibrato-rate-val'),
    vibratoExtent: document.getElementById('vibrato-extent'),
    vibratoExtentVal: document.getElementById('vibrato-extent-val'),
    vibratoDelay: document.getElementById('vibrato-delay'),
    vibratoDelayVal: document.getElementById('vibrato-delay-val'),
    vibratoRamp: document.getElementById('vibrato-ramp'),
    vibratoRampVal: document.getElementById('vibrato-ramp-val'),
    vibratoAm: document.getElementById('vibrato-am'),
    vibratoAmVal: document.getElementById('vibrato-am-val'),
    vibratoWave: document.getElementById('vibrato-wave'),

    // Glottal Waveform (dual canvases)
    glottalCanvasFlow: document.getElementById('glottal-canvas-flow'),
    glottalCanvasDeriv: document.getElementById('glottal-canvas-deriv'),
    // Fallback to old single canvas for backwards compatibility
    glottalCanvas: document.getElementById('glottal-canvas-flow') || document.getElementById('glottal-canvas'),
    rdSlider: document.getElementById('rd-slider'),
    rdVal: document.getElementById('rd-val'),
    lfOq: document.getElementById('lf-oq'),
    lfSq: document.getElementById('lf-sq'),
    lfRd: document.getElementById('lf-rd'),

    // Filters
    f1Slider: document.getElementById('f1-slider'),
    f1Val: document.getElementById('f1-val'),
    f1Q: document.getElementById('f1-q'),
    f1Toggle: document.getElementById('f1-toggle'),

    f2Slider: document.getElementById('f2-slider'),
    f2Val: document.getElementById('f2-val'),
    f2Q: document.getElementById('f2-q'),
    f2Toggle: document.getElementById('f2-toggle'),

    f3Slider: document.getElementById('f3-slider'),
    f3Val: document.getElementById('f3-val'),
    f3Q: document.getElementById('f3-q'),
    f3Toggle: document.getElementById('f3-toggle'),

    f4Slider: document.getElementById('f4-slider'),
    f4Val: document.getElementById('f4-val'),
    f4Q: document.getElementById('f4-q'),
    f4Toggle: document.getElementById('f4-toggle'),

    f5Slider: document.getElementById('f5-slider'),
    f5Val: document.getElementById('f5-val'),
    f5Q: document.getElementById('f5-q'),
    f5Toggle: document.getElementById('f5-toggle'),

    presets: document.querySelectorAll('.preset-btn'),

    // Vocal Tract Coach
    tractCanvas: document.getElementById('tract-canvas'),
    targetTimbre: document.getElementById('target-timbre'),
    matchScore: document.getElementById('match-score'),
    coachingHints: document.getElementById('coaching-hints'),
};

// Canvas context
const canvasCtx = els.canvas.getContext('2d');
let animationId = null;

// Detect mobile page for UI text differences
const isMobilePage = !!document.querySelector('.tab-nav');

// --- Helper Functions ---
function freqToNote(freq) {
    const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const a4 = 440;
    const c0 = a4 * Math.pow(2, -4.75);
    const h = Math.round(12 * Math.log2(freq / c0));
    const octave = Math.floor(h / 12);
    const n = h % 12;
    return noteNames[n] + octave;
}

// Cents deviation from nearest semitone, range (-50, +50]
function freqToCents(freq) {
    const a4 = 440;
    const c0 = a4 * Math.pow(2, -4.75);
    const semis = 12 * Math.log2(freq / c0);
    return Math.round((semis - Math.round(semis)) * 100);
}

// Combined "A3 (+39¢)" label
function noteWithCents(freq) {
    const cents = freqToCents(freq);
    const sign = cents > 0 ? '+' : (cents < 0 ? '' : '±');
    return `${freqToNote(freq)} (${sign}${cents}¢)`;
}

// Map frequency to canvas x coordinate (linear or logarithmic)
const MAX_FREQ_DISPLAY = 6000;
const MIN_FREQ_LOG = 50; // Lower bound for log scale
function freqToX(freq, width) {
    if (state.logScale) {
        const clampedFreq = Math.max(MIN_FREQ_LOG, freq);
        return (Math.log10(clampedFreq / MIN_FREQ_LOG) / Math.log10(MAX_FREQ_DISPLAY / MIN_FREQ_LOG)) * width;
    }
    return (freq / MAX_FREQ_DISPLAY) * width;
}

// Inverse: canvas x coordinate back to frequency
function xToFreq(x, width) {
    if (state.logScale) {
        const ratio = x / width;
        return MIN_FREQ_LOG * Math.pow(MAX_FREQ_DISPLAY / MIN_FREQ_LOG, ratio);
    }
    return (x / width) * MAX_FREQ_DISPLAY;
}

// Calculate the dB gain for a specific harmonic based on mechanism & phonation mode
function calcHarmonicGainDb(harmonicNumber, mechanism, mode, airflow) {
    if (harmonicNumber === 1) return 0; // Fundamental is 0dB relative

    // Base slope
    let slopeDb = mechanism === 'm1' ? -12 : -18;

    // Modify based on Phonation Mode
    if (mode === 'pressed') {
        // Shallower slope (richer harmonics)
        slopeDb += 4;
    } else if (mode === 'breathy') {
        // Steeper slope (fewer harmonics)
        slopeDb -= 5;
    }

    // Number of octaves above fundamental: log2(harmonicNumber)
    const octaves = Math.log2(harmonicNumber);
    let dbGain = octaves * slopeDb;

    // "Necessary Roughness" simulation for Flow/Pressed (Boost harmonics 6+)
    if (harmonicNumber >= 6 && (mode === 'flow' || mode === 'pressed')) {
        // Small boost to simulate high MFDR buzz. More boost for pressed.
        const buzzBoost = mode === 'pressed' ? 6 : 2;
        // Apply smooth roll-off to the boost so it doesn't go on infinitely
        const boostAmount = buzzBoost * Math.max(0, 1 - (harmonicNumber - 6) / 20);
        dbGain += boostAmount;
    }

    return dbGain;
}

// Convert dB to linear amplitude
function dbToLinear(db) {
    return Math.pow(10, db / 20);
}

// --- Roughness / pitch-resolution helpers ---
// Framework (Bozeman / PVA tradition):
//   1. Is adjacent harmonic interval inside the auditory critical band (ERB)?
//      No  → Pure & Resolved   (clear pitch, no buzz)
//      Yes → further check harmonic number n:
//           n ≤ 8 → Rough & Resolved   (buzzy but still pitch-integrated)
//           n ≥ 9 → Rough & Unresolved (buzzy AND not pitch-integrated)
//   2. n*f0 > 5 kHz → Ceiling (not used for pitch perception at all)
const PITCH_CEILING_HZ = 5000;        // Pitch-dominance region cutoff (Plomp)
const PITCH_INTEGRATION_LIMIT_N = 9;  // n ≥ 9 → no longer integrated into pitch percept

// Glasberg & Moore (1990) ERB at center frequency f (Hz)
function erbHz(f) {
    return 24.7 * (4.37 * f / 1000 + 1);
}

// Lowest harmonic n where adjacent spacing f0 falls within ERB(n*f0)
// → onset of "Rough" (Pure → Rough boundary)
function computeResolvedLimit(f0) {
    for (let n = 2; n <= 64; n++) {
        if (f0 < erbHz(n * f0)) return n;
    }
    return Infinity;
}

// Returns one of: 'pure' | 'rough-res' | 'rough-unr' | 'ceiling'
function classifyHarmonic(n, f0, nERB) {
    if (n * f0 >= PITCH_CEILING_HZ) return 'ceiling';
    if (n < nERB) return 'pure';
    return n < PITCH_INTEGRATION_LIMIT_N ? 'rough-res' : 'rough-unr';
}

const ROUGH_ZONE_COLOR = {
    'pure':       'rgba(33, 150, 243, 0.95)',
    'rough-res':  'rgba(217, 125, 31, 0.95)',
    'rough-unr':  'rgba(210, 69, 69, 0.95)',
    'ceiling':    'rgba(140, 140, 140, 0.85)'
};

const ROUGH_ZONE_NAME = {
    'pure':       'Pure & Resolved',
    'rough-res':  'Rough & Resolved',
    'rough-unr':  'Rough & Unresolved',
    'ceiling':    'Ceiling (>5kHz)'
};

// Generate an audio buffer filled with white noise
function createNoiseBuffer(ctx) {
    const bufferSize = ctx.sampleRate * 2; // 2 seconds of noise
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
        output[i] = Math.random() * 2 - 1;
    }
    return buffer;
}

// --- Initialization ---

function initAudio() {
    if (audioCtx) return;

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    // Master Gain
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0; // Start muted
    visMasterGain = audioCtx.createGain();
    visMasterGain.gain.value = 0;
    silentTarget = audioCtx.createGain();
    silentTarget.gain.value = 0;

    // Analyser for visualization
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096; // High resolution
    analyser.smoothingTimeConstant = 0.8;

    // Formant Filters (Bandpass or Peaking, Peaking is better for cascading transfer functions)
    f1Node = audioCtx.createBiquadFilter(); f1Node.type = 'peaking'; f1Node.gain.value = state.formants.f1.gain;
    f2Node = audioCtx.createBiquadFilter(); f2Node.type = 'peaking'; f2Node.gain.value = state.formants.f2.gain;
    f3Node = audioCtx.createBiquadFilter(); f3Node.type = 'peaking'; f3Node.gain.value = state.formants.f3.gain;
    f4Node = audioCtx.createBiquadFilter(); f4Node.type = 'peaking'; f4Node.gain.value = state.formants.f4.gain;
    f5Node = audioCtx.createBiquadFilter(); f5Node.type = 'peaking'; f5Node.gain.value = state.formants.f5.gain;

    visF1Node = audioCtx.createBiquadFilter(); visF1Node.type = 'peaking'; visF1Node.gain.value = state.formants.f1.gain;
    visF2Node = audioCtx.createBiquadFilter(); visF2Node.type = 'peaking'; visF2Node.gain.value = state.formants.f2.gain;
    visF3Node = audioCtx.createBiquadFilter(); visF3Node.type = 'peaking'; visF3Node.gain.value = state.formants.f3.gain;
    visF4Node = audioCtx.createBiquadFilter(); visF4Node.type = 'peaking'; visF4Node.gain.value = state.formants.f4.gain;
    visF5Node = audioCtx.createBiquadFilter(); visF5Node.type = 'peaking'; visF5Node.gain.value = state.formants.f5.gain;

    // Spectral Tilt Filter (Highshelf)
    spectralTiltNode = audioCtx.createBiquadFilter();
    spectralTiltNode.type = 'highshelf';
    // Anchor the shelf slightly above the fundamental so H0 isn't attenuated, but higher harmonics are.
    spectralTiltNode.frequency.value = 400;

    visSpectralTiltNode = audioCtx.createBiquadFilter();
    visSpectralTiltNode.type = 'highshelf';
    visSpectralTiltNode.frequency.value = 400;

    // Connect Filter Chain: Source -> SpectralTilt -> F1 -> F2 -> F3 -> F4 -> F5 -> MasterGain -> Destination
    spectralTiltNode.connect(f1Node);
    f1Node.connect(f2Node);
    f2Node.connect(f3Node);
    f3Node.connect(f4Node);
    f4Node.connect(f5Node);
    f5Node.connect(masterGain);
    masterGain.connect(audioCtx.destination); // Audio straight to out

    // Visualizer path
    visSpectralTiltNode.connect(visF1Node);
    visF1Node.connect(visF2Node);
    visF2Node.connect(visF3Node);
    visF3Node.connect(visF4Node);
    visF4Node.connect(visF5Node);
    visF5Node.connect(visMasterGain);
    visMasterGain.connect(analyser);
    analyser.connect(silentTarget);
    silentTarget.connect(audioCtx.destination);

    // Vibrato LFO + modulation gains
    vibratoLFO = audioCtx.createOscillator();
    vibratoLFO.type = state.vibrato.waveform;
    vibratoLFO.frequency.value = state.vibrato.rate;
    vibratoFMGain = audioCtx.createGain();
    vibratoFMGain.gain.value = 0;
    vibratoAMGain = audioCtx.createGain();
    vibratoAMGain.gain.value = 0;
    vibratoLFO.connect(vibratoFMGain);
    vibratoLFO.connect(vibratoAMGain);
    vibratoAMGain.connect(masterGain.gain); // AM rides on masterGain (audio)
    vibratoAMGain.connect(visMasterGain.gain); // AM also rides on visMasterGain (spectrum)
    vibratoLFO.start();

    updateFilterParams();
}

function startVibratoOnset() {
    if (!audioCtx || !vibratoFMGain || !vibratoAMGain) return;
    const t0 = audioCtx.currentTime;
    const delayS = state.vibrato.onsetDelay / 1000;
    const rampS = Math.max(0.01, state.vibrato.onsetRamp / 1000);
    const fmTarget = state.vibrato.enabled ? state.vibrato.extent : 0;
    const amTarget = state.vibrato.enabled ? (state.vibrato.amDepth / 100) : 0;
    vibratoFMGain.gain.cancelScheduledValues(t0);
    vibratoFMGain.gain.setValueAtTime(0, t0);
    vibratoFMGain.gain.setValueAtTime(0, t0 + delayS);
    vibratoFMGain.gain.linearRampToValueAtTime(fmTarget, t0 + delayS + rampS);
    vibratoAMGain.gain.cancelScheduledValues(t0);
    vibratoAMGain.gain.setValueAtTime(0, t0);
    vibratoAMGain.gain.setValueAtTime(0, t0 + delayS);
    vibratoAMGain.gain.linearRampToValueAtTime(amTarget, t0 + delayS + rampS);
}

function resetVibrato() {
    if (!audioCtx || !vibratoFMGain || !vibratoAMGain) return;
    const t = audioCtx.currentTime;
    vibratoFMGain.gain.cancelScheduledValues(t);
    vibratoFMGain.gain.setTargetAtTime(0, t, 0.05);
    vibratoAMGain.gain.cancelScheduledValues(t);
    vibratoAMGain.gain.setTargetAtTime(0, t, 0.05);
}

function startAudio() {
    initAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    createSource();
    startNoise();

    // Smooth fade in (Intensity based on Pressure)
    const targetIntensity = Math.min(1.0, state.pressure * 0.8) * state.masterVolume;
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(0, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(targetIntensity, audioCtx.currentTime + 0.1);

    startVibratoOnset();
    if (visMasterGain) {
        visMasterGain.gain.cancelScheduledValues(audioCtx.currentTime);
        visMasterGain.gain.setValueAtTime(0, audioCtx.currentTime);
        visMasterGain.gain.linearRampToValueAtTime(targetIntensity, audioCtx.currentTime + 0.1);
    }

    els.btnPlay.textContent = isMobilePage ? '■ Stop' : 'Stop Audio';
    els.btnPlay.classList.add('playing');
    isPlaying = true;

    drawVisualizer();
}

function stopAudio() {
    if (!audioCtx) return;

    // Smooth fade out
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(masterGain.gain.value, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.1);
    if (visMasterGain) {
        visMasterGain.gain.cancelScheduledValues(audioCtx.currentTime);
        visMasterGain.gain.setValueAtTime(visMasterGain.gain.value, audioCtx.currentTime);
        visMasterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.1);
    }

    resetVibrato();

    setTimeout(() => {
        destroySource();
        stopNoise();
    }, 150);

    els.btnPlay.textContent = isMobilePage ? '▶ Play' : 'Play Audio';
    els.btnPlay.classList.remove('playing');
    isPlaying = false;

    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }

    // If mic is still active, keep the visualizer running
    if (state.isMicActive) {
        drawVisualizer();
    }
}

function startNoise() {
    stopNoise();

    noiseNode = audioCtx.createBufferSource();
    noiseNode.buffer = createNoiseBuffer(audioCtx);
    noiseNode.loop = true;

    noiseFilter = audioCtx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = Math.max(1000, state.pitch * 3); // Noise roughly tracks higher formants
    noiseFilter.Q.value = 0.5; // Wide noise band

    noiseGain = audioCtx.createGain();
    // Set initial gain based on currently calculated airflow
    updateNoiseLevel();

    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(spectralTiltNode); // Pass noise through spectral tilt -> vocal tract filter!
    if (visSpectralTiltNode) noiseGain.connect(visSpectralTiltNode);

    noiseNode.start();
}

function stopNoise() {
    if (noiseNode) {
        try { noiseNode.stop(); noiseNode.disconnect(); } catch (e) { }
        try { noiseFilter.disconnect(); } catch (e) { }
        try { noiseGain.disconnect(); } catch (e) { }
        noiseNode = null;
    }
}

function updateNoiseLevel() {
    if (!noiseGain || !audioCtx) return;
    // Noise increases dramatically when Breathy, correlating with Airflow (U)
    let nLevel = 0;
    if (state.phonationMode === 'breathy') {
        nLevel = Math.min(1.0, (state.airflow - 1.2) * 0.5);
        nLevel = Math.max(0, nLevel); // Clamp bottom
    }
    noiseGain.gain.setTargetAtTime(nLevel, audioCtx.currentTime, 0.05);
}

function createSource() {
    destroySource(); // Clear existing

    const numHarmonics = Math.floor(MAX_FREQ_DISPLAY / state.pitch);
    const maxHarmonics = Math.min(numHarmonics, 40); // Limit to save CPU

    const time = audioCtx.currentTime;

    for (let i = 1; i <= maxHarmonics; i++) {
        const freq = state.pitch * i;
        if (freq > audioCtx.sampleRate / 2) break;

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain(); // Visualizer + Base Amplitude
        const audioMute = audioCtx.createGain(); // Mute gate for Audio output

        osc.type = 'sine';
        osc.frequency.value = freq;

        // Calculate amplitude based on spectral slope (M1 vs M2) and Phonation Mode
        const dbGain = calcHarmonicGainDb(i, state.mechanism, state.phonationMode, state.airflow);
        let linearGain = dbToLinear(dbGain) * (1 / Math.sqrt(maxHarmonics));

        // Always pass to visualizer
        gain.gain.value = linearGain;

        // Apply Frequency Selection Mute to Audio Path ONLY
        let muteVal = 1;
        if (state.selectionActive) {
            if (freq < state.selectionMinFreq || freq > state.selectionMaxFreq) {
                muteVal = 0;
            }
        }
        audioMute.gain.value = muteVal;

        osc.connect(gain);
        gain.connect(visSpectralTiltNode); // To Visualizer
        gain.connect(audioMute); // To Audio Gate
        audioMute.connect(spectralTiltNode); // To Audio Output

        // Vibrato FM: connect LFO output to detune (cents)
        if (vibratoFMGain) {
            vibratoFMGain.connect(osc.detune);
        }

        osc.start(time);

        harmonicsOscs.push({ osc, gain, audioMute, harmonic: i });
    }

    updateSpectralTilt();
}

function destroySource() {
    const time = audioCtx ? audioCtx.currentTime : 0;
    harmonicsOscs.forEach(h => {
        h.gain.gain.linearRampToValueAtTime(0, time + 0.1);
        setTimeout(() => {
            try { h.osc.stop(); h.osc.disconnect(); h.gain.disconnect(); if (h.audioMute) h.audioMute.disconnect(); } catch (e) { }
        }, 150);
    });
    harmonicsOscs = [];
}

// --- Updates ---

function calcAerodynamics() {
    // U = P / R
    state.airflow = state.pressure / state.resistance;

    // Determine Phonation Mode based on ratios
    // If Resistance is much higher than Pressure: Pressed
    if (state.resistance / state.pressure > 1.5 || state.airflow < 0.6) {
        state.phonationMode = 'pressed';
    }
    // If Pressure is much higher than Resistance: Breathy
    else if (state.pressure / state.resistance > 1.5 || state.airflow > 1.4) {
        state.phonationMode = 'breathy';
    }
    // Otherwise Flow
    else {
        state.phonationMode = 'flow';
    }

    // Update UI (airflow-val only exists on PC; mobile dropped its Status tab)
    if (els.airflowVal) els.airflowVal.textContent = state.airflow.toFixed(2);
    const phonationLabel = state.phonationMode.charAt(0).toUpperCase() + state.phonationMode.slice(1);
    document.querySelectorAll('.phonation-mode-badge').forEach(el => {
        el.textContent = phonationLabel;
        el.className = `status-badge phonation-mode-badge ${state.phonationMode}`;
    });

    // Update intensity
    if (isPlaying && masterGain && audioCtx) {
        const targetIntensity = Math.min(1.0, state.pressure * 0.8) * state.masterVolume;
        masterGain.gain.setTargetAtTime(targetIntensity, audioCtx.currentTime, 0.05);
        if (visMasterGain) visMasterGain.gain.setTargetAtTime(targetIntensity, audioCtx.currentTime, 0.05);
    }
    updateNoiseLevel();
    // Do not call analyzeAcoustics() here as calcAerodynamics() will trigger it
    updateSourceParams(); // Slopes change based on mode
    drawGlottalWaveform(); // Update glottal waveform display
}

function analyzeAcoustics() {
    const f0 = state.pitch;
    const f20 = f0 * 2;
    const fR1 = state.formants.f1.freq;

    // 1. Timbre State Logic & Turning Over Event
    const prevTimbre = state.timbreState;
    if (f20 > fR1) {
        state.timbreState = 'Close';
    } else {
        state.timbreState = 'Open';
    }

    els.timbreState.textContent = state.timbreState;
    els.timbreState.className = `status-badge ${state.timbreState.toLowerCase()}`;

    // 2. Acoustic Mode Logic (Yell vs Whoop)
    // Dynamic tolerances based on voice type
    const yellTolerance = state.voiceType === 'nontreble' ? 0.20 : 0.10; // Non-Treble easily Yells
    const whoopTolerance = state.voiceType === 'treble' ? 0.20 : 0.08; // Treble easily Whoops

    if (state.voiceType === 'treble') {
        // Treble Voice: Prioritizes Whoop (fR1 tracks 1fo).
        // Yell is also possible (belt strategy: F1 raised to 2*f0) — gated only by physical
        // reachability (F1 can practically be raised up to ~1500Hz via vowel modification).
        if (Math.abs(fR1 - f0) / f0 < whoopTolerance) {
            state.acousticMode = 'Whoop';
        } else if (Math.abs(fR1 - f20) / f20 < yellTolerance) {
            state.acousticMode = 'Yell';
        } else {
            state.acousticMode = 'Neutral';
        }
    } else {
        // Non-Treble Voice: Prioritizes Yell (Turnover handling)
        if (Math.abs(fR1 - f20) / f20 < yellTolerance) {
            state.acousticMode = 'Yell';
        } else if (Math.abs(fR1 - f0) / f0 < whoopTolerance) {
            // Whoop is strict (requires closer tuning) for non-treble
            state.acousticMode = 'Whoop';
        } else {
            state.acousticMode = 'Neutral';
        }
    }

    if (!isPresetLoading && state.acousticMode !== 'Neutral') {
        calcAerodynamics();
    }

    els.acousticMode.textContent = state.acousticMode;
    els.acousticMode.className = `status-badge ${state.acousticMode.toLowerCase()}`;
}

function triggerTurningOver() {
    els.eventFlash.classList.remove('hidden');
    els.eventFlash.classList.remove('flash-anim');
    // Force DOM reflow to restart animation
    void els.eventFlash.offsetWidth;
    els.eventFlash.classList.add('flash-anim');

    setTimeout(() => {
        els.eventFlash.classList.add('hidden');
        els.eventFlash.classList.remove('flash-anim');
    }, 1500);
}

function updateSourceParams() {
    if (!audioCtx || !isPlaying) return;

    const numHarmonics = Math.floor(MAX_FREQ_DISPLAY / state.pitch);
    const maxHarmonics = Math.min(numHarmonics, 40); // Limit to save CPU

    // Recreate source only if harmonic count changes
    if (harmonicsOscs.length !== maxHarmonics) {
        createSource();
    } else {
        const time = audioCtx.currentTime;
        harmonicsOscs.forEach(h => {
            const freq = state.pitch * h.harmonic;
            if (freq > audioCtx.sampleRate / 2) return;

            h.osc.frequency.setTargetAtTime(freq, time, 0.05);

            // Calculate new amplitude based on current state
            const dbGain = calcHarmonicGainDb(h.harmonic, state.mechanism, state.phonationMode, state.airflow);
            let linearGain = dbToLinear(dbGain) * (1 / Math.sqrt(maxHarmonics));

            // Apply Frequency Selection Mute
            let muteVal = 1;
            if (state.selectionActive) {
                if (freq < state.selectionMinFreq || freq > state.selectionMaxFreq) {
                    muteVal = 0;
                }
            }

            h.gain.gain.setTargetAtTime(linearGain, time, 0.05);
            if (h.audioMute) h.audioMute.gain.setTargetAtTime(muteVal, time, 0.05);
        });
    }

    updateSpectralTilt();
}

function updateFilterParams() {
    if (!audioCtx) return;

    const time = audioCtx.currentTime;

    const updateNode = (node, visNode, key) => {
        node.frequency.setTargetAtTime(state.formants[key].freq, time, 0.05);
        node.Q.setTargetAtTime(state.formants[key].q, time, 0.05);
        // Toggle bypass by setting gain to 0
        node.gain.setTargetAtTime(state.formants[key].enabled ? state.formants[key].gain : 0, time, 0.05);

        if (visNode) {
            visNode.frequency.setTargetAtTime(state.formants[key].freq, time, 0.05);
            visNode.Q.setTargetAtTime(state.formants[key].q, time, 0.05);
            visNode.gain.setTargetAtTime(state.formants[key].enabled ? state.formants[key].gain : 0, time, 0.05);
        }
    };

    updateNode(f1Node, visF1Node, 'f1');
    updateNode(f2Node, visF2Node, 'f2');
    updateNode(f3Node, visF3Node, 'f3');
    updateNode(f4Node, visF4Node, 'f4');
    updateNode(f5Node, visF5Node, 'f5');

    analyzeAcoustics();

    // Update vocal tract shape from current formants
    if (typeof FormantToTractMapper !== 'undefined') {
        FormantToTractMapper.update(
            state.formants.f1.freq,
            state.formants.f2.freq,
            state.formants.f3.freq,
            state.formants.f4.freq,
            state.formants.f5.freq,
            state.nasalance || 0
        );
    }
}

// --- LF Glottal Waveform Model ---
// Based on: Fant, G. (1995) "The LF-model revisited" & Gobl/Mahshie (2013) Figure 1

/**
 * Compute LF model parameters from the app's phonation state.
 * Uses Fant 1995 Rd regressions to derive all timing parameters.
 *
 * Rd is the "declination parameter" (Fant 1995):
 *   Rd ≈ 0.3 : very pressed (strong, buzzy)
 *   Rd ≈ 1.0 : modal/flow (balanced)
 *   Rd ≈ 2.7 : very breathy/soft
 *
 * Parameter definitions (Gobl & Mahshie 2013, Figure 1):
 *   OQ = Te / T0          (Open Quotient)
 *   RK = Tn / Tp           (Glottal Skew), where Tn = Te - Tp
 *   SQ = Tp / Tn = 1/RK    (Speed Quotient)
 *   RA = Ta / T0            (Dynamic Leakage)
 *   RG = 1 / (2·Tp·f0)     (Normalized Glottal Frequency)
 */
function computeLFParams() {
    let Rd;

    if (state.rdManual !== null) {
        // Manual Rd override from slider
        Rd = state.rdManual;
    } else {
        // Auto Rd from mechanism + phonation mode
        Rd = state.mechanism === 'm1' ? 0.8 : 1.5;
        if (state.phonationMode === 'pressed') {
            Rd -= 0.4;
        } else if (state.phonationMode === 'breathy') {
            Rd += 0.8;
        }
        const prRatio = state.pressure / state.resistance;
        Rd += (prRatio - 1.0) * 0.3;
    }

    // Clamp Rd to valid range
    Rd = Math.max(0.3, Math.min(2.7, Rd));

    // Fant 1995 regression equations
    const Rap = Math.max(0, (-1 + 4.8 * Rd) / 100);     // predicted RA
    const Rkp = (22.4 + 11.8 * Rd) / 100;               // predicted RK

    // Derive RG from the Fant 1995 Rd definition:
    //   Rd = [(0.5 + 1.2*RK) * (RK/(4*RG) + RA)] / 0.11
    // Solving for RG:
    //   Rd*0.11 / (0.5+1.2*RK) = RK/(4*RG) + RA
    //   RK/(4*RG) = Rd*0.11 / (0.5+1.2*RK) - RA
    //   RG = RK / (4 * (Rd*0.11/(0.5+1.2*RK) - RA))
    const A = 0.5 + 1.2 * Rkp;
    const lhs = Rd * 0.11 / A - Rap;
    let RG;
    if (lhs <= 0.001) {
        RG = 1.0; // fallback for edge cases
    } else {
        RG = Rkp / (4 * lhs);
    }

    // OQ from the fundamental relationship: OQ = (1 + RK) / (2 * RG)
    const OQ = Math.min(0.95, Math.max(0.25, (1 + Rkp) / (2 * RG)));

    const T0 = 1.0; // normalized period
    const Te = OQ * T0;                       // OQ = Te / T0
    const Tp = Te / (1 + Rkp);                // from RK = Tn/Tp → Tp = Te/(1+RK)
    const Tn = Te - Tp;                       // = Rkp * Tp
    const Ta = Rap * T0;                      // RA = Ta / T0

    const RK = Tn / Tp;                       // should ≈ Rkp
    const SQ = Tp / Tn;                       // = 1/RK (Speed Quotient)
    const RA = Ta / T0;                       // should ≈ Rap

    return { Rd, OQ, SQ, RK, RA, Te, Tp, Tn, Ta, T0 };
}

/**
 * Solve the α (growth) parameter for the LF open phase.
 * The open-phase equation is: E0·exp(α·t)·sin(ωg·t)
 * α controls asymmetry of the glottal pulse.
 * We find α such that the derivative has the correct shape at Te.
 */
function solveLFAlpha(wg, Te, Tp) {
    // For a more pressed voice, α is larger (faster exponential rise)
    // For breathy, α ≈ 0 (nearly sinusoidal open phase)
    // Use iterative Newton approximation
    // Constraint: the integral of the open phase must be consistent
    // Simplified: α relates to the ratio Te/Tp
    const ratio = Te / Tp;
    if (ratio <= 1.0) return 0;

    // Start with an initial estimate
    let alpha = 0;
    // The boundary condition: at t=Te the sine function crosses zero
    // wg·Te = n·π for proper LF shape, but Te = Tp(1+RK) and wg = π/Tp
    // So wg·Te = π·(1+RK), meaning the sine at Te = sin(π·(1+RK))
    // This gives a natural zero crossing only when RK is integer.
    // In practice, Te is the point where the waveform's derivative
    // reaches its maximum negative value.

    // Heuristic from Fant (1995): α ≈ some function of the asymmetry
    alpha = Math.max(0, (ratio - 1.0) * 3.0);
    return alpha;
}

/**
 * Generate one period of the LF glottal waveform.
 * The LF model is defined in terms of differentiated glottal flow (dUg/dt).
 * We compute dUg/dt first, then numerically integrate to get Ug(t).
 *
 * Returns both waveforms plus all computed parameters.
 */
function generateLFWaveform(numPoints) {
    const params = computeLFParams();
    const { Rd, OQ, SQ, RK, RA, Te, Tp, Tn, Ta, T0 } = params;

    // Update UI readouts
    if (els.lfOq) els.lfOq.textContent = OQ.toFixed(2);
    if (els.lfSq) els.lfSq.textContent = SQ.toFixed(2);
    if (els.lfRd) els.lfRd.textContent = Rd.toFixed(2);
    if (els.rdVal) els.rdVal.textContent = Rd.toFixed(2);

    // Angular frequency for open phase
    const wg = Math.PI / Tp;

    // Growth parameter α
    const alpha = solveLFAlpha(wg, Te, Tp);

    // Return phase decay rate
    const epsilon = 1.0 / Math.max(0.001, Ta);

    // --- Step 1: Generate dUg/dt (derivative waveform) ---
    const derivative = new Float32Array(numPoints);
    const dt = T0 / numPoints;

    for (let i = 0; i < numPoints; i++) {
        const t = (i / numPoints) * T0;

        if (t <= Te) {
            // Open phase: E0 · exp(α·t) · sin(ωg·t)
            derivative[i] = Math.exp(alpha * t) * Math.sin(wg * t);
        } else if (t <= Te + Ta * 3 && Ta > 0.001) {
            // Return phase: exponential recovery
            // Models the exponential return after vocal fold closure
            const tRel = t - Te;
            derivative[i] = -Math.exp(-epsilon * tRel);
        } else {
            // Closed phase: no flow change
            derivative[i] = 0;
        }
    }

    // Find the max positive and max negative values of derivative
    let maxDeriv = 0, minDeriv = 0;
    for (let i = 0; i < numPoints; i++) {
        if (derivative[i] > maxDeriv) maxDeriv = derivative[i];
        if (derivative[i] < minDeriv) minDeriv = derivative[i];
    }

    // Normalize so that: positive peak maps to +1, negative peak maps to -EE (normalized to -1)
    // Scale open phase and return phase separately for correct shape
    const scaleFactor = Math.max(Math.abs(maxDeriv), Math.abs(minDeriv)) || 1;
    for (let i = 0; i < numPoints; i++) {
        derivative[i] /= scaleFactor;
    }

    // Recompute normalized min for EE
    let normalizedEE = 0;
    for (let i = 0; i < numPoints; i++) {
        if (derivative[i] < normalizedEE) normalizedEE = derivative[i];
    }
    const EE = Math.abs(normalizedEE); // positive magnitude of EE

    // --- Step 2: Numerical integration → Ug(t) (flow waveform) ---
    const flow = new Float32Array(numPoints);
    flow[0] = 0;
    for (let i = 1; i < numPoints; i++) {
        flow[i] = flow[i - 1] + derivative[i] * dt;
    }

    // Normalize flow to [0, 1] range
    let maxFlow = -Infinity, minFlow = Infinity;
    for (let i = 0; i < numPoints; i++) {
        if (flow[i] > maxFlow) maxFlow = flow[i];
        if (flow[i] < minFlow) minFlow = flow[i];
    }
    const flowRange = maxFlow - minFlow || 1;
    for (let i = 0; i < numPoints; i++) {
        flow[i] = (flow[i] - minFlow) / flowRange;
    }

    return { flow, derivative, Te, Tp, Tn, Ta, T0, OQ, SQ, RK, RA, Rd, EE };
}

/**
 * Draw both glottal waveforms on their dedicated canvases.
 * Upper canvas: Glottal Airflow Ug(t) — smooth mountain shape
 * Lower canvas: Differentiated Glottal Airflow dUg/dt — bipolar pulse
 *
 * Layout follows Gobl & Mahshie (2013) Figure 1.
 */
let glottalNeedsRedraw = false;

function drawGlottalWaveform() {
    const canvasFlow = els.glottalCanvasFlow || els.glottalCanvas;
    const canvasDeriv = els.glottalCanvasDeriv;

    if (!canvasFlow) return;

    // Skip if not visible
    if (canvasFlow.clientWidth === 0 || canvasFlow.clientHeight === 0) {
        glottalNeedsRedraw = true;
        return;
    }

    const numPoints = 500;
    const result = generateLFWaveform(numPoints);
    const { flow, derivative, Te, Tp, Tn, Ta, T0, OQ, SQ, RK, RA, Rd, EE } = result;

    // --- Draw Flow Canvas (upper) ---
    drawFlowCanvas(canvasFlow, flow, result);

    // --- Draw Derivative Canvas (lower) ---
    if (canvasDeriv && canvasDeriv.clientWidth > 0) {
        drawDerivativeCanvas(canvasDeriv, derivative, result);
    }
}

/**
 * Draw the glottal airflow (Ug) waveform.
 * Smooth, continuous mountain shape. No discontinuity at Te.
 */
function drawFlowCanvas(canvas, flow, params) {
    const { Te, Tp, T0, OQ, SQ, Rd } = params;
    const numPoints = flow.length;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Background
    ctx.fillStyle = '#FFFEF9';
    ctx.fillRect(0, 0, w, h);

    const teX = (Te / T0) * w;
    const tpX = (Tp / T0) * w;

    // Phase regions
    ctx.fillStyle = 'rgba(79, 150, 80, 0.12)';
    ctx.fillRect(0, 0, teX, h);
    ctx.fillStyle = 'rgba(33, 150, 243, 0.06)';
    ctx.fillRect(teX, 0, w - teX, h);

    // Te boundary line
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(210, 69, 69, 0.4)';
    ctx.beginPath();
    ctx.moveTo(teX, 0); ctx.lineTo(teX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform drawing
    const padding = 20;
    const paddingBottom = 14;
    const plotH = h - padding - paddingBottom;

    // Filled area
    ctx.beginPath();
    ctx.moveTo(0, padding + plotH);
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const y = padding + plotH * (1.0 - flow[i]);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(w, padding + plotH);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, padding, 0, padding + plotH);
    gradient.addColorStop(0, 'rgba(33, 150, 243, 0.18)');
    gradient.addColorStop(1, 'rgba(33, 150, 243, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Waveform line
    ctx.beginPath();
    ctx.strokeStyle = '#2196F3';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(33, 150, 243, 0.25)';
    ctx.shadowBlur = 4;

    let peakX = 0, peakY = h;
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const y = padding + plotH * (1.0 - flow[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (y < peakY) { peakY = y; peakX = x; }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Peak dot at Tp
    ctx.beginPath();
    ctx.arc(peakX, peakY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#D97D1F';
    ctx.fill();
    ctx.strokeStyle = 'rgba(217, 125, 31, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Responsive font scaling
    const isMobile = w < 400;
    const fontSm = isMobile ? 7 : 9;
    const fontMd = isMobile ? 8 : 10;
    const fontLg = isMobile ? 9 : 11;

    // Title label: Glottal Airflow Ug(t)
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(33, 150, 243, 0.85)';
    ctx.fillText('Glottal Airflow Ug(t)', 6, 3);

    // Tp label — 流量ピーク
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(217, 125, 31, 0.95)';
    ctx.fillText('Tp 流量ピーク', peakX, peakY - 8);

    // Te label — 閉鎖点（励起点）
    const teFlowY = padding + plotH * (1.0 - flow[Math.min(numPoints - 1, Math.floor((Te / T0) * numPoints))]);
    ctx.fillStyle = 'rgba(210, 69, 69, 0.9)';
    ctx.fillText('Te 閉鎖点', teX + (isMobile ? 18 : 28), Math.min(teFlowY, padding + 14));

    // Te dot on the flow curve
    ctx.beginPath();
    ctx.arc(teX, teFlowY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#D24545';
    ctx.fill();

    // Bottom parameter badges
    const badgeY = h - 4;
    ctx.font = `600 ${fontSm}px Inter, sans-serif`;
    ctx.textBaseline = 'bottom';

    // Rd badge
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillText(`Rd ${Rd.toFixed(2)}`, 6, badgeY);

    // OQ badge
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(79, 150, 80, 0.95)';
    ctx.fillText(`OQ ${OQ.toFixed(2)}`, teX / 2, badgeY);

    // SQ badge
    ctx.fillStyle = 'rgba(217, 125, 31, 0.75)';
    ctx.textAlign = 'right';
    ctx.fillText(`SQ ${SQ.toFixed(1)}`, w - 6, badgeY);

    // Phonation mode badge (top-right)
    const modeLabels = { flow: 'Flow', pressed: 'Pressed', breathy: 'Breathy' };
    const modeColors = {
        flow: 'rgba(79, 150, 80, 0.95)',
        pressed: 'rgba(210, 69, 69, 0.95)',
        breathy: 'rgba(33, 150, 243, 0.9)'
    };
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = modeColors[state.phonationMode] || 'rgba(0,0,0,0.5)';
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.fillText(modeLabels[state.phonationMode] || state.phonationMode, w - 6, 4);
}

/**
 * Draw the differentiated glottal airflow (dUg/dt) waveform.
 * Bipolar pulse: positive during opening, negative peak at Te, return to zero.
 */
function drawDerivativeCanvas(canvas, derivative, params) {
    const { Te, Tp, Tn, Ta, T0, RK, RA, Rd, EE } = params;
    const numPoints = derivative.length;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    ctx.scale(dpr, dpr);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Background
    ctx.fillStyle = '#FFFEF9';
    ctx.fillRect(0, 0, w, h);

    const teX = (Te / T0) * w;
    const tpX = (Tp / T0) * w;
    const taEndX = Math.min(w, ((Te + Ta * 3) / T0) * w);

    // Phase regions (matching flow canvas)
    ctx.fillStyle = 'rgba(79, 150, 80, 0.1)';
    ctx.fillRect(0, 0, teX, h);
    ctx.fillStyle = 'rgba(210, 69, 69, 0.1)';
    ctx.fillRect(teX, 0, taEndX - teX, h);
    ctx.fillStyle = 'rgba(33, 150, 243, 0.05)';
    ctx.fillRect(taEndX, 0, w - taEndX, h);

    // Te boundary line
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(210, 69, 69, 0.4)';
    ctx.beginPath();
    ctx.moveTo(teX, 0); ctx.lineTo(teX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Waveform area
    const padding = 18;
    const paddingBottom = 14;
    const plotH = h - padding - paddingBottom;

    // Find range of derivative for scaling
    let maxD = 0, minD = 0;
    for (let i = 0; i < numPoints; i++) {
        if (derivative[i] > maxD) maxD = derivative[i];
        if (derivative[i] < minD) minD = derivative[i];
    }
    const range = Math.max(Math.abs(maxD), Math.abs(minD)) || 1;

    // Zero line position: center the waveform vertically
    // Allocate more space for negative (below zero) since -EE is larger
    const posRatio = maxD / range;
    const negRatio = Math.abs(minD) / range;
    const total = posRatio + negRatio;
    const zeroY = padding + plotH * (posRatio / total);

    // Zero baseline
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY);
    ctx.stroke();

    // Filled area for positive/negative regions
    // Positive fill (green tint)
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const val = derivative[i] / range;
        const y = zeroY - val * (plotH * posRatio / total) / posRatio;
        const clampedY = zeroY - (derivative[i] > 0 ? val * plotH * posRatio / total / posRatio : 0);
        ctx.lineTo(x, derivative[i] > 0 ? zeroY - val * plotH / total : zeroY);
    }
    ctx.lineTo(w, zeroY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(79, 150, 80, 0.18)';
    ctx.fill();

    // Negative fill (red tint)
    ctx.beginPath();
    ctx.moveTo(0, zeroY);
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const val = derivative[i] / range;
        ctx.lineTo(x, derivative[i] < 0 ? zeroY - val * plotH / total : zeroY);
    }
    ctx.lineTo(w, zeroY);
    ctx.closePath();
    ctx.fillStyle = 'rgba(210, 69, 69, 0.15)';
    ctx.fill();

    // Waveform line
    ctx.beginPath();
    ctx.strokeStyle = '#D24545';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(210, 69, 69, 0.3)';
    ctx.shadowBlur = 3;

    let minY = 0, minX = 0, minYVal = Infinity;
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const val = derivative[i] / range;
        const y = zeroY - val * plotH / total;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (y > minYVal) { /* minY tracks lowest point visually = highest y pixel */ }
        if (derivative[i] < derivative[Math.floor(minX / w * numPoints)] || i === 0) {
            minX = x;
            minY = y;
            minYVal = y;
        }
    }
    // Re-find true negative peak
    let peakNegIdx = 0;
    for (let i = 0; i < numPoints; i++) {
        if (derivative[i] < derivative[peakNegIdx]) peakNegIdx = i;
    }
    minX = (peakNegIdx / numPoints) * w;
    minY = zeroY - (derivative[peakNegIdx] / range) * plotH / total;

    ctx.stroke();
    ctx.shadowBlur = 0;

    // Responsive font scaling
    const isMobile = w < 400;
    const fontSm = isMobile ? 7 : 9;
    const fontMd = isMobile ? 8 : 10;

    // Title label
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(210, 69, 69, 0.85)';
    ctx.fillText('dUg/dt', 6, 3);

    // -EE dot and label at negative peak (Te)
    ctx.beginPath();
    ctx.arc(minX, minY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#D24545';
    ctx.fill();
    ctx.strokeStyle = 'rgba(210, 69, 69, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(210, 69, 69, 0.95)';
    ctx.fillText(`Te -EE`, minX, minY + 6);

    // Tp zero-crossing label
    // Find where derivative crosses zero from positive to negative (≈ Tp)
    let zeroCrossIdx = 0;
    for (let i = 1; i < numPoints; i++) {
        const t = (i / numPoints) * T0;
        if (t > Tp * 0.8 && derivative[i - 1] > 0 && derivative[i] <= 0) {
            zeroCrossIdx = i;
            break;
        }
    }
    const zeroCrossX = (zeroCrossIdx / numPoints) * w;
    ctx.beginPath();
    ctx.arc(zeroCrossX, zeroY, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#D97D1F';
    ctx.fill();
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(217, 125, 31, 0.95)';
    ctx.textAlign = 'center';
    ctx.fillText('Tp', zeroCrossX, zeroY - 10);

    // Ta annotation — bracket from Te to return-to-zero
    if (Ta > 0.005) {
        const taStartX = teX;
        const taEndXDraw = Math.min(w - 10, ((Te + Ta) / T0) * w);
        const bracketY = h - paddingBottom - 2;
        ctx.strokeStyle = 'rgba(33, 150, 243, 0.6)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(taStartX, bracketY - 4);
        ctx.lineTo(taStartX, bracketY);
        ctx.lineTo(taEndXDraw, bracketY);
        ctx.lineTo(taEndXDraw, bracketY - 4);
        ctx.stroke();

        ctx.font = `600 ${fontSm}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(33, 150, 243, 0.85)';
        ctx.fillText('Ta', (taStartX + taEndXDraw) / 2, bracketY - 6);
    }

    // Bottom parameter badges
    const badgeY = h - 4;
    ctx.font = `600 ${fontSm}px Inter, sans-serif`;
    ctx.textBaseline = 'bottom';

    // Rd badge
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillText(`Rd ${Rd.toFixed(2)}`, 6, badgeY);

    // RA badge
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(33, 150, 243, 0.85)';
    if (w > 200) {
        ctx.fillText(`RA ${RA.toFixed(3)}`, w * 0.35, badgeY);
    }

    // RK badge
    ctx.fillStyle = 'rgba(217, 125, 31, 0.75)';
    if (w > 200) {
        ctx.fillText(`RK ${RK.toFixed(2)}`, w * 0.65, badgeY);
    }

    // EE badge
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(210, 69, 69, 0.9)';
    ctx.fillText(`EE ${EE.toFixed(2)}`, w - 6, badgeY);
}

// --- Pitch Detection (YIN, de Cheveigné & Kawahara 2002) ---
// YIN's cumulative-mean-normalized difference function (CMNDF) is far more
// robust to octave errors than plain autocorrelation. Buffers are reused
// across calls to avoid per-frame allocation (called at ~60 Hz).

let _yinDp = null;        // CMNDF values
let _yinTime = null;      // raw time-domain input
let _yinFiltered = null;  // after pre-emphasis HP
let _yinClarity = 0;      // periodicity confidence of the last detection: 1 - d'(τ), 0 when unvoiced
const YIN_THRESHOLD = 0.10;       // tighter → fewer sub-octave false positives
const YIN_UNVOICED_DP = 0.35;     // if best d'(τ) is above this, reject (noisy / unvoiced)
const VIBRATO_CLARITY_GATE = 0.58; // analysis drops pitch frames below this clarity. Lowered from 0.72:
                                   // vibrato itself depresses per-frame YIN clarity, so 0.72 dropped real cycles.
const YIN_PREEMPH = 0.97;         // standard speech pre-emphasis coefficient

function detectPitchYIN(rawBuf, sampleRate) {
    const N = rawBuf.length;

    // Pre-emphasis HP filter: y[n] = x[n] - 0.97 * x[n-1]
    // Removes DC and low-frequency rumble that confuses YIN at low pitches.
    if (!_yinFiltered || _yinFiltered.length !== N) _yinFiltered = new Float32Array(N);
    const buf = _yinFiltered;
    buf[0] = rawBuf[0];
    for (let i = 1; i < N; i++) buf[i] = rawBuf[i] - YIN_PREEMPH * rawBuf[i - 1];

    // RMS gate (on post-pre-emphasis signal — looser threshold since HP attenuates LF energy)
    let rms = 0;
    for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < 0.005) { _yinClarity = 0; return -1; }

    const minPeriod = Math.max(2, Math.floor(sampleRate / 1000)); // 1000 Hz ceiling
    const maxPeriod = Math.min(Math.floor(sampleRate / 60), Math.floor(N / 2)); // 60 Hz floor
    if (maxPeriod <= minPeriod) { _yinClarity = 0; return -1; }

    if (!_yinDp || _yinDp.length < maxPeriod + 1) _yinDp = new Float32Array(maxPeriod + 1);
    const dp = _yinDp;
    dp[0] = 1;
    let runningSum = 0;

    // Steps 1+2: difference function d(τ) and cumulative-mean-normalized d'(τ) in one pass
    for (let tau = 1; tau <= maxPeriod; tau++) {
        let dsum = 0;
        const W = N - tau;
        for (let j = 0; j < W; j++) {
            const delta = buf[j] - buf[j + tau];
            dsum += delta * delta;
        }
        runningSum += dsum;
        dp[tau] = (runningSum > 0) ? (dsum * tau) / runningSum : 1;
    }

    // Step 3: absolute threshold — first local minimum where d'(τ) < threshold
    let bestTau = -1;
    for (let tau = minPeriod; tau <= maxPeriod - 1; tau++) {
        if (dp[tau] < YIN_THRESHOLD) {
            while (tau + 1 <= maxPeriod && dp[tau + 1] < dp[tau]) tau++;
            bestTau = tau;
            break;
        }
    }
    // Fallback: argmin in vocal range
    if (bestTau < 0) {
        let minVal = Infinity;
        for (let tau = minPeriod; tau <= maxPeriod; tau++) {
            if (dp[tau] < minVal) { minVal = dp[tau]; bestTau = tau; }
        }
    }
    if (bestTau < 0 || dp[bestTau] > YIN_UNVOICED_DP) { _yinClarity = 0; return -1; } // unvoiced / too uncertain
    _yinClarity = Math.max(0, Math.min(1, 1 - dp[bestTau]));

    // Step 4: parabolic interpolation
    let refined = bestTau;
    if (bestTau > minPeriod && bestTau < maxPeriod) {
        const y0 = dp[bestTau - 1], y1 = dp[bestTau], y2 = dp[bestTau + 1];
        const denom = (y0 - 2 * y1 + y2);
        if (Math.abs(denom) > 1e-12) {
            const delta = 0.5 * (y0 - y2) / denom;
            if (delta > -1 && delta < 1) refined = bestTau + delta;
        }
    }

    return sampleRate / refined;
}

function detectPitchFromMic() {
    // Use the low-latency 2048-sample analyser if available; fall back to micAnalyser
    const an = micAnalyserPitch || micAnalyser;
    if (!an || !audioCtx) return -1;
    const bufLen = an.fftSize;
    if (!_yinTime || _yinTime.length !== bufLen) _yinTime = new Float32Array(bufLen);
    an.getFloatTimeDomainData(_yinTime);
    // Raw RMS amplitude (loudness) — used to size the Vowel Space dot
    let rms = 0;
    for (let i = 0; i < bufLen; i++) rms += _yinTime[i] * _yinTime[i];
    state.cachedMicLevel = Math.sqrt(rms / bufLen);
    return detectPitchYIN(_yinTime, audioCtx.sampleRate);
}

// --- Mic device picker ---
// Browsers only return real device labels AFTER mic permission has been granted,
// so we re-enumerate on every successful mic acquisition.
async function refreshMicDevices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        state.micDevices = devices.filter(d => d.kind === 'audioinput');
        if (!els.micDeviceSelect) return;
        const cur = state.micDeviceId || '';
        const opts = ['<option value="">既定のマイク</option>'].concat(
            state.micDevices.map(d => {
                const label = d.label || `マイク (${(d.deviceId || '').substring(0, 6)})`;
                const safe = label.replace(/</g, '&lt;');
                return `<option value="${d.deviceId}">${safe}</option>`;
            })
        );
        els.micDeviceSelect.innerHTML = opts.join('');
        els.micDeviceSelect.value = cur;
        els.micDeviceSelect.style.display = state.micDevices.length > 0 ? '' : 'none';
    } catch (e) {
        console.warn('enumerateDevices failed', e);
    }
}

// Switch mic device without going through full Mic toggle UI flow.
// Stops current stream, re-acquires with the new deviceId, reconnects to the
// existing micGainNode (which is still wired to the analyser chain).
async function setMicDevice(deviceId) {
    state.micDeviceId = deviceId || null;
    if (!state.isMicActive) return; // applied on next mic-on

    if (micStream) {
        try { micStream.getTracks().forEach(t => t.stop()); } catch (_) {}
        micStream = null;
    }
    if (micSource) {
        try { micSource.disconnect(); } catch (_) {}
        micSource = null;
    }

    const audioConstraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
    };
    if (state.micDeviceId) audioConstraints.deviceId = { exact: state.micDeviceId };
    try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (e) {
        alert('マイク切替に失敗しました: ' + (e && e.message ? e.message : e));
        return;
    }
    if (!audioCtx) return;
    micSource = audioCtx.createMediaStreamSource(micStream);
    if (micGainNode) micSource.connect(micGainNode);
    refreshMicDevices();
}

// =====================================================================
// Spectrogram (scrolling) + Vibrato analysis
// =====================================================================

const SPECTROGRAM_WIDTH = 800;       // history columns (≈10s @ 60fps)
const SPECTROGRAM_HEIGHT = 256;      // displayed frequency rows
const SPECTROGRAM_MAX_FREQ = 5000;   // Hz, matches main spectrum upper bound
let spectrogramImageData = null;
let spectrogramBuf32 = null;
let spectrogramCtx = null;
let spectrogramPalette = null;

function getSpectrogramCtx() {
    if (!spectrogramCtx && els.spectrogramCanvas) {
        spectrogramCtx = els.spectrogramCanvas.getContext('2d');
    }
    return spectrogramCtx;
}

function buildSpectrogramPalette() {
    // Viridis-ish: dark → blue → teal → green → yellow → near-white
    const stops = [
        [10, 5, 30],
        [40, 30, 110],
        [50, 100, 180],
        [40, 170, 160],
        [110, 200, 90],
        [230, 220, 60],
        [255, 250, 220]
    ];
    const lut = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        const seg = t * (stops.length - 1);
        const lo = Math.floor(seg);
        const hi = Math.min(stops.length - 1, lo + 1);
        const fr = seg - lo;
        const r = Math.round(stops[lo][0] + (stops[hi][0] - stops[lo][0]) * fr);
        const g = Math.round(stops[lo][1] + (stops[hi][1] - stops[lo][1]) * fr);
        const b = Math.round(stops[lo][2] + (stops[hi][2] - stops[lo][2]) * fr);
        // Uint32 view of ImageData is little-endian: AABBGGRR
        lut[i] = (0xff << 24) | (b << 16) | (g << 8) | r;
    }
    spectrogramPalette = lut;
}

function initSpectrogramBuffer() {
    const ctx = getSpectrogramCtx();
    if (!ctx || !els.spectrogramCanvas) return;
    if (!spectrogramPalette) buildSpectrogramPalette();
    if (els.spectrogramCanvas.width !== SPECTROGRAM_WIDTH) {
        els.spectrogramCanvas.width = SPECTROGRAM_WIDTH;
        els.spectrogramCanvas.height = SPECTROGRAM_HEIGHT;
    }
    if (!spectrogramImageData || spectrogramImageData.width !== SPECTROGRAM_WIDTH) {
        spectrogramImageData = ctx.createImageData(SPECTROGRAM_WIDTH, SPECTROGRAM_HEIGHT);
        spectrogramBuf32 = new Uint32Array(spectrogramImageData.data.buffer);
        spectrogramBuf32.fill(spectrogramPalette[0]);
    }
}

function pickSpectrogramAnalyser() {
    const playbackOn = !!playbackAudio && !playbackAudio.paused;
    if ((state.isMicActive || playbackOn) && micAnalyser) return micAnalyser;
    if (isPlaying && analyser) return analyser;
    return null;
}

function pushSpectrogramColumn() {
    if (!spectrogramBuf32 || !spectrogramPalette) return;
    const w = SPECTROGRAM_WIDTH, h = SPECTROGRAM_HEIGHT;

    // Shift left by 1 column (whole buffer; copyWithin is fast)
    for (let y = 0; y < h; y++) {
        const off = y * w;
        spectrogramBuf32.copyWithin(off, off + 1, off + w);
    }

    const an = pickSpectrogramAnalyser();
    const colX = w - 1;
    if (!an || !audioCtx) {
        for (let y = 0; y < h; y++) spectrogramBuf32[y * w + colX] = spectrogramPalette[0];
        return;
    }

    const bins = an.frequencyBinCount;
    const fft = new Float32Array(bins);
    an.getFloatFrequencyData(fft);
    const minDb = an.minDecibels;
    const maxDb = an.maxDecibels;
    const dbRange = maxDb - minDb;
    const nyquist = audioCtx.sampleRate / 2;
    const useLog = !!state.logScale;
    const logMin = Math.log10(50);
    const logMax = Math.log10(SPECTROGRAM_MAX_FREQ);

    for (let y = 0; y < h; y++) {
        const ny = 1 - (y / (h - 1)); // bottom = 0Hz
        const freq = useLog
            ? Math.pow(10, logMin + ny * (logMax - logMin))
            : ny * SPECTROGRAM_MAX_FREQ;
        const binF = (freq / nyquist) * bins;
        const bi = Math.min(bins - 1, Math.max(0, Math.floor(binF)));
        let db = fft[bi];
        if (!isFinite(db)) db = minDb;
        const t = Math.max(0, Math.min(1, (db - minDb) / dbRange));
        const idx = Math.min(255, Math.max(0, Math.floor(Math.pow(t, 0.7) * 255)));
        spectrogramBuf32[y * w + colX] = spectrogramPalette[idx];
    }
}

function renderSpectrogram() {
    const ctx = getSpectrogramCtx();
    if (!ctx || !spectrogramImageData) return;
    ctx.putImageData(spectrogramImageData, 0, 0);
}

function applyViewMode(mode) {
    state.viewMode = mode === 'spectrogram' ? 'spectrogram' : 'spectrum';
    if (els.canvas) els.canvas.style.display = state.viewMode === 'spectrum' ? 'block' : 'none';
    if (els.spectrogramCanvas) els.spectrogramCanvas.style.display = state.viewMode === 'spectrogram' ? 'block' : 'none';
    // Spectrum's x-axis (freq labels) is meaningless in spectrogram mode (freq is on Y there)
    const xAxis = document.querySelector('.canvas-container .axis-labels.x-axis');
    if (xAxis) xAxis.style.display = state.viewMode === 'spectrogram' ? 'none' : (state.logScale ? 'none' : '');
    if (els.viewTabs) {
        els.viewTabs.querySelectorAll('.view-tab').forEach(btn => {
            const active = btn.dataset.view === state.viewMode;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
    if (state.viewMode === 'spectrogram') {
        initSpectrogramBuffer();
        renderSpectrogram();
    }
}

// ---------- Vibrato analysis ----------
const VIBRATO_BUFFER_MS = 5000;
const VIBRATO_ANALYSIS_MS = 2200;   // shorter window → snappier reaction (≈9 cycles @ 4 Hz)
const VIBRATO_CONF_DISPLAY_GATE = 0.3; // below this, don't assert Rate/Extent/Type — show "測定中…"
                                       // Lowered from 0.4: real (non-pure-sine) vibrato sat just under the old gate.
const VIBRATO_ANALYSIS_INTERVAL = 200;

function pushPitchSample(hz, clarity = 0) {
    const t = performance.now();
    const buf = state.vibratoAnalysis.pitchBuf;
    buf.push({ t, hz: hz > 0 ? hz : null, clarity });
    const cutoff = t - VIBRATO_BUFFER_MS;
    while (buf.length > 0 && buf[0].t < cutoff) buf.shift();
}

function resetVibratoUi() {
    const va = state.vibratoAnalysis;
    va.rate = 0; va.extent = 0; va.regularity = 0; va.confidence = 0;
    va.verdict = '—'; va.f0Median = 0;
    va.fitOmega = 0; va.fitA = 0; va.fitB = 0; va.fitSampleRate = 0; va.fitT0 = 0;
    va.trace = [];
    if (els.vibRate) els.vibRate.textContent = '—';
    if (els.vibExtent) els.vibExtent.textContent = '—';
    if (els.vibRegularity) els.vibRegularity.textContent = '—';
    if (els.vibConfidence) els.vibConfidence.textContent = '—';
    if (els.vibVerdict) els.vibVerdict.textContent = '—';
    if (els.vibF0) els.vibF0.textContent = '—';
    if (els.vibVerdictBox) els.vibVerdictBox.classList.remove('is-good', 'is-warn');
    if (els.vibAnalysisBody) els.vibAnalysisBody.classList.remove('is-lowconf');
    if (els.vibQualityFill) els.vibQualityFill.style.width = '0%';
}

// Vibrato analysis pipeline:
//  (1) 3-tap median filter on raw f0 — kills single-sample spikes from autocorr glitches
//  (2) Outlier rejection vs. median (drops residual octave errors)
//  (3) Linear detrend (least-squares — robust to slow drift / portamento)
//  (4) Hann window before Goertzel — cuts spectral leakage for accurate extent
//  (5) Parabolic peak interpolation on Goertzel grid — sub-bin Rate accuracy
//  (6) Least-squares cos/sin fit at peak freq on the unwindowed signal — best amplitude & phase
//  (7) Composite confidence: regularity × validity ratio × peak prominence
const VIBRATO_OUTLIER_CENTS = 700;
function analyzeVibrato() {
    const va = state.vibratoAnalysis;
    const now = performance.now();
    va.lastAnalysisAt = now;

    const buf = va.pitchBuf;
    if (buf.length < 24) { resetVibratoUi(); return; }

    const cutoff = now - VIBRATO_ANALYSIS_MS;
    let idx0 = 0;
    for (let i = 0; i < buf.length; i++) { if (buf[i].t >= cutoff) { idx0 = i; break; } }
    const slice = buf.slice(idx0);
    if (slice.length < 20) { resetVibratoUi(); return; }

    // (0) Clarity gate: drop pitch frames whose YIN periodicity confidence is low.
    //     Weak/noisy frames are the main source of jitter and octave glitches.
    const gz = (s) => (s && s.hz != null && (s.clarity == null || s.clarity >= VIBRATO_CLARITY_GATE)) ? s.hz : null;

    // (1) 3-tap median filter (preserves edges, removes 1-sample spikes)
    const filtHz = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
        const a = i > 0 ? gz(slice[i - 1]) : null;
        const b = gz(slice[i]);
        const c = i < slice.length - 1 ? gz(slice[i + 1]) : null;
        const v = [a, b, c].filter(x => x != null);
        if (v.length === 0) { filtHz[i] = null; continue; }
        v.sort((x, y) => x - y);
        filtHz[i] = v[Math.floor(v.length / 2)];
    }

    const valid = filtHz.filter(h => h != null);
    if (valid.length < slice.length * 0.33 || valid.length < 15) { resetVibratoUi(); return; }

    // Median pitch
    const sortedHz = valid.slice().sort((a, b) => a - b);
    const median = sortedHz[Math.floor(sortedHz.length / 2)];
    if (median <= 0) { resetVibratoUi(); return; }
    va.f0Median = median;

    // (2) Outlier rejection
    let validCount = 0;
    const hzClean = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
        const h = filtHz[i];
        if (h == null) { hzClean[i] = null; continue; }
        const c = 1200 * Math.log2(h / median);
        if (Math.abs(c) > VIBRATO_OUTLIER_CENTS) { hzClean[i] = null; continue; }
        hzClean[i] = h;
        validCount++;
    }
    if (validCount < 15) { resetVibratoUi(); return; }

    // Build cents series, holding last value through gaps
    const N = slice.length;
    const cents = new Float64Array(N);
    const centsRaw = new Float64Array(N); // pre-window, for LS fit and trace
    let lastC = 0;
    for (let i = 0; i < N; i++) {
        if (hzClean[i] != null) lastC = 1200 * Math.log2(hzClean[i] / median);
        cents[i] = lastC;
    }

    // (3) Linear detrend
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < N; i++) { sx += i; sy += cents[i]; sxx += i * i; sxy += i * cents[i]; }
    const den = N * sxx - sx * sx;
    const slope = den !== 0 ? (N * sxy - sx * sy) / den : 0;
    const intercept = (sy - slope * sx) / N;
    for (let i = 0; i < N; i++) {
        const d = cents[i] - (slope * i + intercept);
        cents[i] = d;
        centsRaw[i] = d;
    }

    const durationSec = (slice[N - 1].t - slice[0].t) / 1000;
    if (durationSec < 0.7) { resetVibratoUi(); return; }
    const sampleRate = (N - 1) / durationSec;

    // (4) Hann window in-place (only on `cents`, NOT on `centsRaw`)
    for (let i = 0; i < N; i++) {
        const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
        cents[i] *= w;
    }

    // Goertzel scan 2–12 Hz at 0.1 Hz
    const F_LO = 2.0, F_HI = 12.0, F_STEP = 0.1;
    const nBins = Math.round((F_HI - F_LO) / F_STEP) + 1;
    const powers = new Float64Array(nBins);
    let peakIdx = 0, peakPower = 0, totalPower = 0;
    for (let k = 0; k < nBins; k++) {
        const f = F_LO + k * F_STEP;
        const omega = 2 * Math.PI * f / sampleRate;
        const cosW = Math.cos(omega);
        const sinW = Math.sin(omega);
        const coeff = 2 * cosW;
        let q1 = 0, q2 = 0;
        for (let i = 0; i < N; i++) {
            const q0 = coeff * q1 - q2 + cents[i];
            q2 = q1; q1 = q0;
        }
        const real = q1 - q2 * cosW;
        const imag = q2 * sinW;
        const power = real * real + imag * imag;
        powers[k] = power;
        totalPower += power;
        if (power > peakPower) { peakPower = power; peakIdx = k; }
    }

    // (5) Parabolic peak interpolation
    let peakFreq = F_LO + peakIdx * F_STEP;
    if (peakIdx > 0 && peakIdx < nBins - 1) {
        const yL = powers[peakIdx - 1], yC = powers[peakIdx], yR = powers[peakIdx + 1];
        const denP = (yL - 2 * yC + yR);
        if (Math.abs(denP) > 1e-12) {
            const delta = 0.5 * (yL - yR) / denP;
            peakFreq += delta * F_STEP;
        }
    }

    // (6) Least-squares cos/sin fit at peakFreq on the unwindowed detrended signal
    //     y[i] ≈ A cos(ω i) + B sin(ω i), then Extent = sqrt(A²+B²)
    const omegaPeak = 2 * Math.PI * peakFreq / sampleRate;
    let sCC = 0, sSS = 0, sCS = 0, sYC = 0, sYS = 0;
    for (let i = 0; i < N; i++) {
        const c = Math.cos(omegaPeak * i);
        const s = Math.sin(omegaPeak * i);
        sCC += c * c; sSS += s * s; sCS += c * s;
        sYC += centsRaw[i] * c; sYS += centsRaw[i] * s;
    }
    const detM = sCC * sSS - sCS * sCS;
    let fitA = 0, fitB = 0;
    if (Math.abs(detM) > 1e-10) {
        fitA = (sSS * sYC - sCS * sYS) / detM;
        fitB = (sCC * sYS - sCS * sYC) / detM;
    }
    const fitExtent = Math.sqrt(fitA * fitA + fitB * fitB);

    // Residual SNR for regularity (compare fit energy to residual energy)
    let resEnergy = 0, sigEnergy = 0;
    for (let i = 0; i < N; i++) {
        const fit = fitA * Math.cos(omegaPeak * i) + fitB * Math.sin(omegaPeak * i);
        const resid = centsRaw[i] - fit;
        resEnergy += resid * resid;
        sigEnergy += centsRaw[i] * centsRaw[i];
    }
    const explainedVar = sigEnergy > 0 ? Math.max(0, 1 - resEnergy / sigEnergy) : 0; // R²-like

    // Peak prominence (vs. average non-peak power)
    let nonPeakSum = 0, nonPeakCount = 0;
    for (let k = 0; k < nBins; k++) {
        if (Math.abs(k - peakIdx) > 2) { nonPeakSum += powers[k]; nonPeakCount++; }
    }
    const meanNonPeak = nonPeakCount > 0 ? nonPeakSum / nonPeakCount : 1e-12;
    const prominence = meanNonPeak > 0 ? Math.min(1, peakPower / (meanNonPeak * 15)) : 0;

    // Regularity = explained variance of the dominant sine
    const regularity = explainedVar;

    // Composite confidence
    const validityRatio = validCount / N;
    const durationScore = Math.min(1, durationSec / 2);
    const confidence = Math.max(0, Math.min(1,
        0.45 * regularity + 0.20 * prominence + 0.20 * validityRatio + 0.15 * durationScore
    ));

    let verdict = '—', verdictClass = '';
    if (fitExtent < 12) { verdict = 'Straight'; verdictClass = 'is-warn'; }
    else if (peakFreq < 4.5) { verdict = fitExtent > 25 ? 'Wobble' : 'Slow'; verdictClass = 'is-warn'; }
    else if (peakFreq > 7.5) { verdict = 'Tremor'; verdictClass = 'is-warn'; }
    else if (regularity < 0.3) { verdict = 'Unsteady'; verdictClass = 'is-warn'; }
    else { verdict = 'Good'; verdictClass = 'is-good'; }

    va.rate = peakFreq;
    va.extent = fitExtent;
    va.regularity = regularity;
    va.confidence = confidence;
    va.verdict = verdict;
    va.fitOmega = omegaPeak;
    va.fitA = fitA;
    va.fitB = fitB;
    va.fitSampleRate = sampleRate;
    va.fitT0 = slice[0].t;
    va.trace = slice.map((s, i) => ({
        t: s.t,
        cents: hzClean[i] != null ? 1200 * Math.log2(hzClean[i] / median) - (slope * i + intercept) : null,
    }));

    // Low-confidence guard: don't assert Rate/Extent/Type when the estimate is shaky.
    // f0 / Regularity / Confidence still show so the user can see *why* it's withheld.
    const lowConf = confidence < VIBRATO_CONF_DISPLAY_GATE;
    if (els.vibRate) els.vibRate.textContent = lowConf ? '—' : peakFreq.toFixed(1);
    if (els.vibExtent) els.vibExtent.textContent = lowConf ? '—' : Math.round(fitExtent);
    if (els.vibRegularity) els.vibRegularity.textContent = Math.round(regularity * 100);
    if (els.vibConfidence) els.vibConfidence.textContent = Math.round(confidence * 100);
    if (els.vibVerdict) els.vibVerdict.textContent = lowConf ? '測定中…' : verdict;
    if (els.vibF0) els.vibF0.textContent = Math.round(median);
    if (els.vibVerdictBox) {
        els.vibVerdictBox.classList.remove('is-good', 'is-warn');
        if (!lowConf && verdictClass) els.vibVerdictBox.classList.add(verdictClass);
    }
    if (els.vibAnalysisBody) els.vibAnalysisBody.classList.toggle('is-lowconf', lowConf);
    if (els.vibQualityFill) {
        els.vibQualityFill.style.width = Math.round(confidence * 100) + '%';
        els.vibQualityFill.style.backgroundColor =
            confidence >= 0.7 ? '#4caf50' : confidence >= VIBRATO_CONF_DISPLAY_GATE ? '#fbc02d' : '#ef6c00';
    }
}

let vibratoCanvasCtx = null;
function getVibratoCanvasCtx() {
    if (!vibratoCanvasCtx && els.vibratoCanvas) {
        vibratoCanvasCtx = els.vibratoCanvas.getContext('2d');
    }
    return vibratoCanvasCtx;
}

function drawVibratoTrace() {
    const c = els.vibratoCanvas;
    const ctx = getVibratoCanvasCtx();
    if (!c || !ctx) return;
    const w = c.clientWidth || 600;
    const h = c.clientHeight || 110;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#fdfcf6';
    ctx.fillRect(0, 0, w, h);

    const va = state.vibratoAnalysis;
    const series = va.trace;
    const Y_RANGE = 150;
    const yForCents = (cents) => h / 2 - (cents / Y_RANGE) * (h / 2 - 6);

    // Grid lines
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const c0 of [-100, -50, 50, 100]) {
        const y = yForCents(c0);
        ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
    ctx.stroke();

    // Left-side cents labels (always)
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const c0 of [-100, 0, 100]) {
        ctx.fillText(`${c0 > 0 ? '+' : ''}${c0}¢`, 4, yForCents(c0));
    }

    if (!series || series.length < 2) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('マイクをON → 持続音を発声するとビブラートを検出します', w / 2, h / 2);
        return;
    }

    const t0 = series[0].t;
    const tN = series[series.length - 1].t;
    const tSpan = Math.max(1, tN - t0);
    const xFor = (t) => ((t - t0) / tSpan) * w;

    // Extent band (shaded ±extent zone) — gives instant sense of how big the wobble is
    if (va.extent > 0 && va.confidence > 0.2) {
        const eClamped = Math.min(Y_RANGE, va.extent);
        const yTop = yForCents(eClamped);
        const yBot = yForCents(-eClamped);
        ctx.fillStyle = 'rgba(76, 175, 80, 0.08)';
        ctx.fillRect(0, yTop, w, yBot - yTop);
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.35)';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(0, yTop); ctx.lineTo(w, yTop);
        ctx.moveTo(0, yBot); ctx.lineTo(w, yBot);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Detected sine overlay (LS fit) — visual proof that detection is locked
    if (va.fitSampleRate > 0 && va.confidence > 0.2 && (va.fitA !== 0 || va.fitB !== 0)) {
        ctx.strokeStyle = 'rgba(76, 175, 80, 0.85)';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        const samplesPerMs = va.fitSampleRate / 1000;
        for (let px = 0; px <= w; px += 2) {
            const tMs = t0 + (px / w) * tSpan;
            const i = (tMs - va.fitT0) * samplesPerMs;
            const yC = va.fitA * Math.cos(va.fitOmega * i) + va.fitB * Math.sin(va.fitOmega * i);
            const y = yForCents(Math.max(-Y_RANGE, Math.min(Y_RANGE, yC)));
            if (px === 0) ctx.moveTo(px, y);
            else ctx.lineTo(px, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Cents curve (blue, primary) — drawn on top
    ctx.strokeStyle = '#1e88e5';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    let started = false;
    for (const s of series) {
        if (s.cents == null) { started = false; continue; }
        const x = xFor(s.t);
        const y = yForCents(Math.max(-Y_RANGE, Math.min(Y_RANGE, s.cents)));
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Footer: time span + legend
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (va.confidence > 0.2) {
        ctx.fillStyle = 'rgba(30, 136, 229, 0.85)';
        ctx.fillText('— 実測ピッチ偏差', 6, h - 2);
        ctx.fillStyle = 'rgba(76, 175, 80, 0.85)';
        ctx.fillText('-- 検出された正弦波', 96, h - 2);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.textAlign = 'right';
    ctx.fillText(`${(tSpan / 1000).toFixed(1)}s`, w - 4, h - 2);
}

// =====================================================================
// Vowel Space (F1 × F2 chart, uses LPC v3 cached formant data)
// =====================================================================
// Cardinal vowel reference values, adult-male baseline (IPA convention).
// Each entry has acoustic (f1, f2) for nearest-vowel matching AND canonical
// chart position (sCanon, tCanon) for IPA trapezoid layout where
//   s in [0, 1]: 0 = back, 1 = front
//   t in [0, 1]: 0 = high (close), 1 = low (open)
// JP: 日本標準語5母音 (杉藤・神山 1990 系) / EN: Peterson & Barney 1952 (male)
// Voice scaling (Fant 1966 / Nordström 1977 系): female ≈ +18%, child ≈ +40%
const VOWEL_PRESETS_BASE = {
    jp: [
        { ipa: '/a/', label: '/a/', f1: 800, f2: 1300, sCanon: 0.55, tCanon: 0.94 },
        { ipa: '/i/', label: '/i/', f1: 280, f2: 2300, sCanon: 0.95, tCanon: 0.05 },
        { ipa: '/ɯ/', label: '/ɯ/', f1: 350, f2: 1300, sCanon: 0.18, tCanon: 0.10 },
        { ipa: '/e/', label: '/e/', f1: 450, f2: 2000, sCanon: 0.92, tCanon: 0.48 },
        { ipa: '/o/', label: '/o/', f1: 480, f2: 900,  sCanon: 0.07, tCanon: 0.42 },
    ],
    en: [
        { ipa: '/i/', label: '/i/', f1: 270, f2: 2290, sCanon: 0.95, tCanon: 0.05 },
        { ipa: '/ɪ/', label: '/ɪ/', f1: 390, f2: 1990, sCanon: 0.85, tCanon: 0.18 },
        { ipa: '/e/', label: '/e/', f1: 530, f2: 1840, sCanon: 0.92, tCanon: 0.45 },
        { ipa: '/ɛ/', label: '/ɛ/', f1: 610, f2: 1900, sCanon: 0.88, tCanon: 0.58 },
        { ipa: '/æ/', label: '/æ/', f1: 660, f2: 1720, sCanon: 0.82, tCanon: 0.85 },
        { ipa: '/a/', label: '/a/', f1: 850, f2: 1610, sCanon: 0.68, tCanon: 0.97 },
        { ipa: '/ɑ/', label: '/ɑ/', f1: 730, f2: 1090, sCanon: 0.05, tCanon: 0.95 },
        { ipa: '/ɔ/', label: '/ɔ/', f1: 570, f2: 840,  sCanon: 0.06, tCanon: 0.65 },
        { ipa: '/o/', label: '/o/', f1: 440, f2: 1020, sCanon: 0.05, tCanon: 0.40 },
        { ipa: '/ʊ/', label: '/ʊ/', f1: 440, f2: 1020, sCanon: 0.12, tCanon: 0.18 },
        { ipa: '/u/', label: '/u/', f1: 300, f2: 870,  sCanon: 0.05, tCanon: 0.05 },
        { ipa: '/ʌ/', label: '/ʌ/', f1: 640, f2: 1190, sCanon: 0.48, tCanon: 0.58 },
        { ipa: '/ə/', label: '/ə/', f1: 500, f2: 1500, sCanon: 0.48, tCanon: 0.45 },
        { ipa: '/ɚ/', label: '/ɚ/', f1: 470, f2: 1400, sCanon: 0.48, tCanon: 0.30 },
    ],
};

const VOICE_TYPE_SCALE = {
    male:   { f1: 1.0,  f2: 1.0  },
    female: { f1: 1.18, f2: 1.17 },
    child:  { f1: 1.40, f2: 1.35 },
};

// Muted palette aligned with the app's calm tone — distinguishable but not gaudy
const VOWEL_PALETTE = [
    '#7c6f8a', // dusty mauve
    '#5b7a9a', // muted slate-blue
    '#6e8e7c', // soft sage
    '#a07b62', // warm taupe
    '#7d8794', // cool gray
    '#9b7e8a', // dusty rose
    '#6f8d8c', // muted teal
    '#8a8264', // olive khaki
    '#7e6f8e', // smoky lavender
    '#8d7766', // chestnut
    '#677a6a', // forest sage
];

const VS_TRAIL_MS = 1500;
const VS_SMOOTH_MS = 250;   // window for median-smoothing the live readout / nearest-vowel decision

// IPA trapezoid corners in normalized canvas coords [0,1]
// Slanted left edge (front-bottom indented to match articulatory chart)
// Right margin (after the trapezoid) reserved for High/Mid/Low + F1 Hz axis
// Bottom margin reserved for F2 Hz axis
const VS_TRAP = {
    tl: { sx: 0.08, sy: 0.12 },   // High Front  — /i/ corner
    tr: { sx: 0.82, sy: 0.12 },   // High Back   — /u/ corner
    br: { sx: 0.82, sy: 0.80 },   // Low  Back   — /ɑ/ corner
    bl: { sx: 0.30, sy: 0.80 },   // Low  Front  — /a/ corner (indented inward)
};

// Map IPA (s, t) coords → canvas pixel coords.
// s: 0 = back, 1 = front;  t: 0 = high, 1 = low
function vsSTtoXY(s, t, w, h) {
    const tl = VS_TRAP.tl, tr = VS_TRAP.tr, br = VS_TRAP.br, bl = VS_TRAP.bl;
    const frontX = tl.sx + t * (bl.sx - tl.sx);
    const backX  = tr.sx + t * (br.sx - tr.sx);
    const y      = tl.sy + t * (bl.sy - tl.sy);
    const x      = backX + s * (frontX - backX);
    return { x: x * w, y: y * h };
}

// Map measured (F1, F2) Hz → IPA (s, t). Voice-scaled so a female /i/ still
// lands at the top-front corner, etc.
function vsF1F2toST(f1, f2) {
    const sc = VOICE_TYPE_SCALE[state.vowelSpace.voiceType] || VOICE_TYPE_SCALE.male;
    const F1_HI = 250 * sc.f1;    // /i/, /u/ (high vowels)
    const F1_LO = 900 * sc.f1;    // /a/, /ɑ/ (low vowels)
    const F2_BK = 800 * sc.f2;    // /u/, /ɑ/ (back vowels)
    const F2_FR = 2300 * sc.f2;   // /i/, /e/ (front vowels)
    const t = (Math.log2(f1) - Math.log2(F1_HI)) / (Math.log2(F1_LO) - Math.log2(F1_HI));
    const s = (Math.log2(f2) - Math.log2(F2_BK)) / (Math.log2(F2_FR) - Math.log2(F2_BK));
    return {
        s: Math.max(-0.08, Math.min(1.08, s)),
        t: Math.max(-0.08, Math.min(1.08, t)),
    };
}

function vowelPresets() {
    const lang = state.vowelSpace.language;
    if (state.vowelSpace.voiceType === 'me') {
        const personal = state.vowelSpace.calibration.saved?.[lang];
        if (personal && personal.length > 0) {
            return personal.map((p, i) => ({
                ...p,
                color: VOWEL_PALETTE[i % VOWEL_PALETTE.length],
            }));
        }
    }
    const base = VOWEL_PRESETS_BASE[lang] || VOWEL_PRESETS_BASE.jp;
    const sc = VOICE_TYPE_SCALE[state.vowelSpace.voiceType] || VOICE_TYPE_SCALE.male;
    return base.map((v, i) => ({
        ...v,
        f1: v.f1 * sc.f1,
        f2: v.f2 * sc.f2,
        color: VOWEL_PALETTE[i % VOWEL_PALETTE.length],
    }));
}

// ---------- Per-user calibration ----------
const CAL_STORAGE_KEY = 'sf_vowel_calibration_v1';
const CAL_PREPARE_MS = 1500;
const CAL_RECORD_MS = 2000;

function loadCalibrationFromStorage() {
    try {
        const raw = localStorage.getItem(CAL_STORAGE_KEY);
        if (!raw) return null;
        const data = JSON.parse(raw);
        return (data && typeof data === 'object') ? data : null;
    } catch (_) { return null; }
}

function saveCalibrationToStorage(data) {
    try { localStorage.setItem(CAL_STORAGE_KEY, JSON.stringify(data)); } catch (_) {}
}

// ---------- Loudness ceiling meter ----------
// A manual "don't sing louder than this" guard. Reuses the raw mic RMS already
// computed in detectPitchFromMic(); the ceiling is user-set and persisted.
const LOUD_STORAGE_KEY = 'sf_loudness_ceiling_v1';
const LOUD_METER_MIN_DB = -60; // bar left edge
const LOUD_METER_MAX_DB = 0;   // bar right edge
const LOUD_GREEN_MARGIN = 6;   // dB below the ceiling that still reads green

function loadLoudnessCeiling() {
    try {
        const raw = localStorage.getItem(LOUD_STORAGE_KEY);
        if (raw == null) return null;
        const v = parseFloat(raw);
        return Number.isFinite(v) ? v : null;
    } catch (_) { return null; }
}

function saveLoudnessCeiling(db) {
    try { localStorage.setItem(LOUD_STORAGE_KEY, String(db)); } catch (_) {}
}

// Map a dB value to a 0..100 fill percentage across the meter's range.
function loudDbToPct(db) {
    const t = (db - LOUD_METER_MIN_DB) / (LOUD_METER_MAX_DB - LOUD_METER_MIN_DB);
    return Math.max(0, Math.min(1, t)) * 100;
}

function resetLoudnessMeter() {
    state.loudnessDb = LOUD_METER_MIN_DB;
    if (els.loudFill) { els.loudFill.style.width = '0%'; els.loudFill.style.backgroundColor = '#cfd8dc'; }
    if (els.loudVal) els.loudVal.textContent = '— dB';
}

// Called every animation frame while the mic is active (and not paused).
function updateLoudnessMeter() {
    const ceiling = state.loudnessCeilingDb;
    if (els.loudMarker) els.loudMarker.style.left = loudDbToPct(ceiling) + '%';

    const level = state.cachedMicLevel;
    const db = level > 0 ? 20 * Math.log10(level) : -120;
    if (db <= LOUD_METER_MIN_DB) { // effectively silent
        state.loudnessDb = LOUD_METER_MIN_DB;
        if (els.loudFill) { els.loudFill.style.width = '0%'; els.loudFill.style.backgroundColor = '#cfd8dc'; }
        if (els.loudVal) els.loudVal.textContent = '— dB';
        return;
    }
    // EMA — faster attack than release so peaks register but the bar settles smoothly.
    const a = db > state.loudnessDb ? 0.5 : 0.2;
    state.loudnessDb = state.loudnessDb * (1 - a) + db * a;

    const sdb = state.loudnessDb;
    let color;
    if (sdb >= ceiling) color = '#e53935';                         // over ceiling → red
    else if (sdb >= ceiling - LOUD_GREEN_MARGIN) color = '#fbc02d'; // approaching → amber
    else color = '#43a047';                                        // safe → green
    if (els.loudFill) { els.loudFill.style.width = loudDbToPct(sdb) + '%'; els.loudFill.style.backgroundColor = color; }
    if (els.loudVal) els.loudVal.textContent = Math.round(sdb) + ' dB';
}

function startCalibration() {
    const cal = state.vowelSpace.calibration;
    cal.active = true;
    cal.step = 0;
    cal.phase = 'prepare';
    cal.phaseStart = performance.now();
    cal.samples = [];
    cal.results = [];
    updateCalibrateButton();
}

function cancelCalibration() {
    const cal = state.vowelSpace.calibration;
    cal.active = false;
    cal.samples = [];
    cal.results = [];
    updateCalibrateButton();
    drawVowelSpace();
}

function finishCalibration() {
    const cal = state.vowelSpace.calibration;
    const lang = state.vowelSpace.language;
    if (!cal.results || cal.results.length === 0) { cancelCalibration(); return; }
    if (!cal.saved) cal.saved = {};
    cal.saved[lang] = cal.results;
    saveCalibrationToStorage(cal.saved);
    cal.active = false;
    updateCalibrateButton();
    updateVoiceTypeTabs();
    applyVowelSpaceVoice('me');
}

function advanceCalibration(now) {
    const cal = state.vowelSpace.calibration;
    if (!cal.active) return;
    const base = VOWEL_PRESETS_BASE[state.vowelSpace.language] || VOWEL_PRESETS_BASE.jp;
    if (cal.step >= base.length) { finishCalibration(); return; }
    const elapsed = now - cal.phaseStart;
    if (cal.phase === 'prepare') {
        if (elapsed >= CAL_PREPARE_MS) {
            cal.phase = 'record';
            cal.phaseStart = now;
            cal.samples = [];
        }
    } else if (cal.phase === 'record') {
        // Sample current formants
        if (state.cachedMicFormants) {
            const f1 = vsFormantHz(state.cachedMicFormants.f1);
            const f2 = vsFormantHz(state.cachedMicFormants.f2);
            if (f1 != null && f2 != null) cal.samples.push({ f1, f2 });
        }
        if (elapsed >= CAL_RECORD_MS) {
            const v = base[cal.step];
            if (cal.samples.length >= 8) {
                const f1s = cal.samples.map(s => s.f1).sort((a, b) => a - b);
                const f2s = cal.samples.map(s => s.f2).sort((a, b) => a - b);
                const f1med = f1s[Math.floor(f1s.length / 2)];
                const f2med = f2s[Math.floor(f2s.length / 2)];
                cal.results.push({ ipa: v.ipa, label: v.label, f1: f1med, f2: f2med });
            } else {
                // Not enough samples — fallback to default
                cal.results.push({ ipa: v.ipa, label: v.label, f1: v.f1, f2: v.f2 });
            }
            cal.step++;
            cal.phase = 'prepare';
            cal.phaseStart = now;
        }
    }
}

function drawCalibrationOverlay(ctx, w, h, pad) {
    const cal = state.vowelSpace.calibration;
    const base = VOWEL_PRESETS_BASE[state.vowelSpace.language] || VOWEL_PRESETS_BASE.jp;
    const total = base.length;
    const step = Math.min(cal.step, total - 1);
    const current = base[step];

    // Semi-transparent overlay
    ctx.fillStyle = 'rgba(253, 252, 246, 0.94)';
    ctx.fillRect(0, 0, w, h);

    // Progress bar at top
    const barH = 4, barY = 12;
    const barX = pad.left, barW = w - pad.left - pad.right;
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = 'var(--accent-color, #2196F3)';
    const completed = cal.results.length / total;
    ctx.fillStyle = '#2196F3';
    ctx.fillRect(barX, barY, barW * completed, barH);

    // Step counter
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(`${cal.results.length} / ${total}`, w / 2, barY + barH + 6);

    // Phase label
    const elapsed = performance.now() - cal.phaseStart;
    let phaseText, remaining, accentColor;
    if (cal.phase === 'prepare') {
        const left = Math.max(0, CAL_PREPARE_MS - elapsed) / 1000;
        phaseText = `準備 — 次の母音`;
        remaining = `${left.toFixed(1)}s`;
        accentColor = '#888';
    } else {
        const left = Math.max(0, CAL_RECORD_MS - elapsed) / 1000;
        phaseText = `発声してください`;
        remaining = `録音中 ${left.toFixed(1)}s`;
        accentColor = '#e53935';
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.font = '11px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(phaseText, w / 2, h / 2 - 60);

    // Big IPA vowel
    ctx.fillStyle = cal.phase === 'record' ? '#1a1a1a' : 'rgba(0,0,0,0.4)';
    ctx.font = '600 64px "Charis SIL", "Doulos SIL", "Lucida Sans Unicode", system-ui, sans-serif';
    ctx.fillText(current.label, w / 2, h / 2);

    // Remaining time + sample count
    ctx.fillStyle = accentColor;
    ctx.font = '600 12px Inter, sans-serif';
    ctx.fillText(remaining, w / 2, h / 2 + 50);

    if (cal.phase === 'record') {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.font = '10px Inter, sans-serif';
        ctx.fillText(`サンプル: ${cal.samples.length}`, w / 2, h / 2 + 70);
    }

    // Cancel hint
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.font = '10px Inter, sans-serif';
    ctx.textBaseline = 'bottom';
    ctx.fillText('Cancel ボタンで中断', w / 2, h - 10);
}

function updateCalibrateButton() {
    if (!els.vsCalibrateBtn) return;
    const active = state.vowelSpace.calibration.active;
    els.vsCalibrateBtn.textContent = active ? 'Cancel' : '🎯 Calibrate';
    els.vsCalibrateBtn.classList.toggle('is-active', active);
}

function updateVoiceTypeTabs() {
    if (!els.vsVoiceTabs) return;
    const hasPersonal = !!(state.vowelSpace.calibration.saved &&
                          state.vowelSpace.calibration.saved[state.vowelSpace.language]);
    const meBtn = els.vsVoiceTabs.querySelector('[data-voice="me"]');
    if (meBtn) {
        meBtn.disabled = !hasPersonal;
        meBtn.style.opacity = hasPersonal ? '' : '0.4';
        meBtn.style.cursor = hasPersonal ? 'pointer' : 'not-allowed';
    }
}

// Map mic RMS level (loudness) → color. Quiet = soft blue, loud = hot red.
// Perceptual (dB) so the ramp spreads evenly across soft→loud singing.
function vsIntensityColor(level, alpha = 1) {
    if (!(level > 0)) return `rgba(150, 160, 170, ${alpha})`;
    const db = 20 * Math.log10(level);
    const t = Math.max(0, Math.min(1, (db + 45) / 33)); // -45 dB quiet → -12 dB loud
    const hue = 210 * (1 - t);   // 210 blue (soft) → 0 red (loud)
    const sat = 55 + t * 35;     // more vivid when loud
    const light = 58 - t * 10;   // denser when loud
    return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
}

// Map mic RMS level → dot radius (px). Perceptual (dB) so soft/loud spread evenly.
function vsLevelRadius(level) {
    if (!(level > 0)) return 5;
    const db = 20 * Math.log10(level);
    const t = Math.max(0, Math.min(1, (db + 45) / 33)); // -45 dB → min, -12 dB → max
    return 4 + t * 11; // 4..15 px
}

// f0 display: a large faint gray note-name watermark with Hz + cents below,
// centered in the chart — identical in spirit to the Spectrum view's tuner overlay.
// Drawn BEHIND the dot/trail as a quiet reference.
function drawVsPitchMarker(ctx, w, h, f0) {
    if (!(f0 > 0)) return;
    const yTop = VS_TRAP.tl.sy * h;
    const yBot = VS_TRAP.br.sy * h;
    const cx = (VS_TRAP.bl.sx + VS_TRAP.tr.sx) / 2 * w;
    const cy = (yTop + yBot) / 2;

    ctx.save();
    ctx.textAlign = 'center';

    // Large note name
    ctx.fillStyle = 'rgba(0, 0, 0, 0.10)';
    ctx.font = '700 48px Inter, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(freqToNote(f0), cx, cy - 8);

    // Hz + cents below
    const cents = freqToCents(f0);
    const centsLabel = `${cents > 0 ? '+' : (cents < 0 ? '' : '±')}${cents}¢`;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
    ctx.font = '400 16px Inter, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`${Math.round(f0)} Hz  ${centsLabel}`, cx, cy + 24);

    ctx.restore();
}

let vowelSpaceCtx = null;
function getVowelSpaceCtx() {
    if (!vowelSpaceCtx && els.vowelSpaceCanvas) {
        vowelSpaceCtx = els.vowelSpaceCanvas.getContext('2d');
    }
    return vowelSpaceCtx;
}

function vsLog(v) { return Math.log10(Math.max(1, v)); }
function vsLogDist(a, b) {
    // Perceptual distance in log Hz, scaled to a cents-like number for readability
    const d1 = (vsLog(a.f1) - vsLog(b.f1));
    const d2 = (vsLog(a.f2) - vsLog(b.f2));
    return Math.sqrt(d1 * d1 + d2 * d2) * 1200 / Math.log10(2);
}

// Median-smoothed current (F1, F2) over the last VS_SMOOTH_MS of the trail.
// LPC frames jitter frame-to-frame; the median is robust to single-frame spikes
// so the live dot and the nearest-vowel decision stop flickering.
function vsSmoothedCurrent() {
    const trail = state.vowelSpace.trail;
    if (trail.length === 0) return null;
    const cutoff = trail[trail.length - 1].t - VS_SMOOTH_MS;
    const f1s = [], f2s = [], f0s = [], levels = [];
    for (let i = trail.length - 1; i >= 0; i--) {
        if (trail[i].t < cutoff) break;
        f1s.push(trail[i].f1);
        f2s.push(trail[i].f2);
        if (trail[i].f0 > 0) f0s.push(trail[i].f0);
        if (trail[i].level > 0) levels.push(trail[i].level);
    }
    const med = (arr) => arr[Math.floor(arr.length / 2)];
    const f0 = f0s.length ? med(f0s.slice().sort((a, b) => a - b)) : 0;
    const level = levels.length ? med(levels.slice().sort((a, b) => a - b)) : 0;
    if (f1s.length === 0) {
        const last = trail[trail.length - 1];
        return { f1: last.f1, f2: last.f2, f0, level };
    }
    f1s.sort((a, b) => a - b);
    f2s.sort((a, b) => a - b);
    return { f1: med(f1s), f2: med(f2s), f0, level };
}

function vsNearestVowel(f1, f2) {
    const presets = vowelPresets();
    let best = null, bestD = Infinity;
    for (const v of presets) {
        const d = vsLogDist({ f1, f2 }, v);
        if (d < bestD) { bestD = d; best = v; }
    }
    return best ? { vowel: best, dist: bestD } : null;
}

// Formant cache stores entries as either a plain number (older peak path)
// or { freq, db } objects (LPC paths). Extract Hz safely.
function vsFormantHz(entry) {
    if (entry == null) return null;
    if (typeof entry === 'number') return entry > 0 ? entry : null;
    if (typeof entry === 'object' && typeof entry.freq === 'number') {
        return entry.freq > 0 ? entry.freq : null;
    }
    return null;
}

function pushVowelSample() {
    if (!state.isMicActive || !state.cachedMicFormants) return;
    const f1 = vsFormantHz(state.cachedMicFormants.f1);
    const f2 = vsFormantHz(state.cachedMicFormants.f2);
    if (f1 == null || f2 == null) return;
    const t = performance.now();
    const trail = state.vowelSpace.trail;
    // Capture f0 + level alongside the formants so the dot's pitch color and size
    // persist for the trail-fade window even after voicing stops.
    trail.push({ t, f1, f2, f0: state.cachedMicPitch, level: state.cachedMicLevel });
    const cutoff = t - VS_TRAIL_MS;
    while (trail.length > 0 && trail[0].t < cutoff) trail.shift();
}

function drawVowelSpace() {
    const c = els.vowelSpaceCanvas;
    const ctx = getVowelSpaceCtx();
    if (!c || !ctx) return;
    const w = c.clientWidth || 600;
    const h = c.clientHeight || 320;
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;

    // Background
    ctx.fillStyle = '#fdfcf6';
    ctx.fillRect(0, 0, w, h);

    // --- IPA trapezoid frame ---
    // Compute corner pixels from VS_TRAP
    const corners = {
        tl: { x: VS_TRAP.tl.sx * w, y: VS_TRAP.tl.sy * h },
        tr: { x: VS_TRAP.tr.sx * w, y: VS_TRAP.tr.sy * h },
        br: { x: VS_TRAP.br.sx * w, y: VS_TRAP.br.sy * h },
        bl: { x: VS_TRAP.bl.sx * w, y: VS_TRAP.bl.sy * h },
    };

    // Light fill inside the trapezoid
    ctx.beginPath();
    ctx.moveTo(corners.tl.x, corners.tl.y);
    ctx.lineTo(corners.tr.x, corners.tr.y);
    ctx.lineTo(corners.br.x, corners.br.y);
    ctx.lineTo(corners.bl.x, corners.bl.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(33, 150, 243, 0.025)';
    ctx.fill();

    // Row dividers (High / Mid / Low) — horizontal lines following the trapezoid slant
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 1;
    const rowTs = [0.33, 0.67];
    for (const tRow of rowTs) {
        const fL = vsSTtoXY(1, tRow, w, h);
        const fR = vsSTtoXY(0, tRow, w, h);
        ctx.beginPath();
        ctx.moveTo(fL.x, fL.y);
        ctx.lineTo(fR.x, fR.y);
        ctx.stroke();
    }

    // Column dividers (Front | Central | Back) — vertical lines at s=0.66, s=0.33
    const colSs = [0.66, 0.33];
    for (const sCol of colSs) {
        const top = vsSTtoXY(sCol, 0, w, h);
        const bot = vsSTtoXY(sCol, 1, w, h);
        ctx.beginPath();
        ctx.moveTo(top.x, top.y);
        ctx.lineTo(bot.x, bot.y);
        ctx.stroke();
    }

    // Trapezoid outline (drawn on top of dividers)
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(corners.tl.x, corners.tl.y);
    ctx.lineTo(corners.tr.x, corners.tr.y);
    ctx.lineTo(corners.br.x, corners.br.y);
    ctx.lineTo(corners.bl.x, corners.bl.y);
    ctx.closePath();
    ctx.stroke();

    // Column labels: Front / Central / Back — above the trapezoid top edge
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const colLabelY = corners.tl.y - 6;
    const frontCx = vsSTtoXY(0.83, 0, w, h).x;
    const centralCx = vsSTtoXY(0.5, 0, w, h).x;
    const backCx = vsSTtoXY(0.17, 0, w, h).x;
    ctx.fillText('Front', frontCx, colLabelY);
    ctx.fillText('Central', centralCx, colLabelY);
    ctx.fillText('Back', backCx, colLabelY);

    // Row labels: High / Mid / Low — right side only (IPA chart convention)
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.font = '600 10px Inter, sans-serif';
    const rowMidTs = [0.16, 0.5, 0.83];
    const rowLabels = ['High', 'Mid', 'Low'];
    for (let i = 0; i < 3; i++) {
        const rightEdge = vsSTtoXY(0, rowMidTs[i], w, h);
        ctx.textAlign = 'left';
        ctx.fillText(rowLabels[i], rightEdge.x + 6, rightEdge.y);
    }

    // --- Hz axis scales (voice-type aware) ---
    const sc = VOICE_TYPE_SCALE[state.vowelSpace.voiceType] || VOICE_TYPE_SCALE.male;
    const F1_HI = 250 * sc.f1, F1_LO = 900 * sc.f1;
    const F2_BK = 800 * sc.f2, F2_FR = 2300 * sc.f2;

    // F1 Hz scale — right side, further out than High/Mid/Low
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const f1Ticks = [300, 400, 500, 700, 900].map(v => Math.round(v * sc.f1));
    for (const f1 of f1Ticks) {
        const t = (Math.log2(f1) - Math.log2(F1_HI)) / (Math.log2(F1_LO) - Math.log2(F1_HI));
        if (t < -0.02 || t > 1.02) continue;
        const pt = vsSTtoXY(0, t, w, h);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x + 3, pt.y);
        ctx.stroke();
        ctx.fillText(`${f1}`, pt.x + 38, pt.y);
    }
    // "F1 (Hz)" axis title — vertical, far right
    ctx.save();
    ctx.translate(corners.tr.x + 64, (corners.tr.y + corners.br.y) / 2);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.font = '600 9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText('F1 (Hz)', 0, 0);
    ctx.restore();

    // F2 Hz scale — below the bottom edge
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const f2Ticks = [800, 1000, 1500, 2000, 2300].map(v => Math.round(v * sc.f2));
    for (const f2 of f2Ticks) {
        const s = (Math.log2(f2) - Math.log2(F2_BK)) / (Math.log2(F2_FR) - Math.log2(F2_BK));
        if (s < -0.02 || s > 1.02) continue;
        const pt = vsSTtoXY(s, 1, w, h);
        ctx.beginPath();
        ctx.moveTo(pt.x, pt.y);
        ctx.lineTo(pt.x, pt.y + 3);
        ctx.stroke();
        ctx.fillText(`${f2}`, pt.x, pt.y + 6);
    }
    // "F2 (Hz)" axis title — below ticks
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.font = '600 9px Inter, sans-serif';
    ctx.fillText('F2 (Hz)', (corners.bl.x + corners.br.x) / 2, h - 12);

    // --- Vowel reference labels (canonical IPA positions) ---
    const presets = vowelPresets();
    for (const v of presets) {
        const pt = vsSTtoXY(v.sCanon ?? 0.5, v.tCanon ?? 0.5, w, h);
        // Subtle halo
        ctx.globalAlpha = 0.10;
        ctx.fillStyle = v.color;
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // Label — large IPA glyph, no marker dot needed
        ctx.fillStyle = 'rgba(30, 30, 30, 0.85)';
        ctx.font = '600 15px "Charis SIL", "Doulos SIL", "Lucida Sans Unicode", "Helvetica Neue", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Strip slashes for IPA chart aesthetics ('/a/' → 'a')
        const glyph = v.label.replace(/^\/|\/$/g, '');
        ctx.fillText(glyph, pt.x, pt.y);
    }

    // --- Trail of measured points ---
    const trail = state.vowelSpace.trail;
    if (trail.length > 0) {
        const now = performance.now();
        // Connecting line
        ctx.strokeStyle = 'rgba(30, 136, 229, 0.5)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let started = false;
        for (const p of trail) {
            const st = vsF1F2toST(p.f1, p.f2);
            const pt = vsSTtoXY(st.s, st.t, w, h);
            if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
            else ctx.lineTo(pt.x, pt.y);
        }
        ctx.stroke();
        // Fading dots
        for (const p of trail) {
            const age = (now - p.t) / VS_TRAIL_MS;
            const alpha = Math.max(0.05, 1 - age);
            const st = vsF1F2toST(p.f1, p.f2);
            const pt = vsSTtoXY(st.s, st.t, w, h);
            ctx.fillStyle = `rgba(30, 136, 229, ${alpha * 0.4})`;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
            ctx.fill();
        }
        // Current point — median-smoothed over the last VS_SMOOTH_MS (stable dot)
        const cur = vsSmoothedCurrent() || trail[trail.length - 1];
        const curST = vsF1F2toST(cur.f1, cur.f2);
        const curPt = vsSTtoXY(curST.s, curST.t, w, h);
        // Color + size the dot by intensity (RMS loudness); show f0 as a marker behind.
        // Values come from the trail-smoothed snapshot so they persist while the dot
        // lingers after voicing stops (cachedMicPitch/Level reset to 0).
        const f0 = (cur.f0 > 0) ? cur.f0 : state.cachedMicPitch;
        const level = (cur.level > 0) ? cur.level : state.cachedMicLevel;
        const dotColor = vsIntensityColor(level);
        const r = vsLevelRadius(level); // dot size = loudness

        // f0 watermark (note + Hz + cents), drawn BEHIND the dot like the Spectrum tuner
        drawVsPitchMarker(ctx, w, h, f0);

        // Soft glow halo in the intensity color for a more tactile read
        ctx.fillStyle = vsIntensityColor(level, 0.18);
        ctx.beginPath();
        ctx.arc(curPt.x, curPt.y, r + 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = dotColor;
        ctx.beginPath();
        ctx.arc(curPt.x, curPt.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Update readouts
        const nearest = vsNearestVowel(cur.f1, cur.f2);
        state.vowelSpace.nearest = nearest;
        if (els.vsNearest) els.vsNearest.textContent = nearest ? `${nearest.vowel.label} (${Math.round(nearest.dist)}¢)` : '—';
        if (els.vsF1) els.vsF1.textContent = Math.round(cur.f1);
        if (els.vsF2) els.vsF2.textContent = Math.round(cur.f2);
        if (els.vsF3) {
            const f3hz = state.cachedMicFormants ? vsFormantHz(state.cachedMicFormants.f3) : null;
            els.vsF3.textContent = f3hz != null ? Math.round(f3hz) : '—';
        }
        if (els.vsRatio) els.vsRatio.textContent = (cur.f2 / cur.f1).toFixed(2);
    } else {
        // Empty hint — placed inside trapezoid
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const hint = vsSTtoXY(0.5, 0.5, w, h);
        ctx.fillText('マイクON → 母音を発声するとここにプロットされます', hint.x, hint.y);
        if (els.vsNearest) els.vsNearest.textContent = '—';
        if (els.vsF1) els.vsF1.textContent = '—';
        if (els.vsF2) els.vsF2.textContent = '—';
        if (els.vsF3) els.vsF3.textContent = '—';
        if (els.vsRatio) els.vsRatio.textContent = '—';
    }

    // Calibration overlay on top (if active)
    if (state.vowelSpace.calibration.active) {
        // Pass a synthetic 'pad' for overlay positioning
        const pad = { left: corners.tl.x, right: w - corners.tr.x, top: corners.tl.y, bottom: h - corners.bl.y };
        drawCalibrationOverlay(ctx, w, h, pad);
    }
}

function applyVowelSpaceMode(mode) {
    const m = mode === 'advanced' ? 'advanced' : 'basic';
    state.vowelSpace.mode = m;
    if (els.vsBody) {
        els.vsBody.classList.toggle('is-basic', m === 'basic');
        els.vsBody.classList.toggle('is-advanced', m === 'advanced');
    }
    if (els.vsModeTabs) {
        els.vsModeTabs.querySelectorAll('.vib-mode-tab').forEach(btn => {
            const active = btn.dataset.mode === m;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
}

function applyVowelSpaceLanguage(lang) {
    state.vowelSpace.language = lang === 'en' ? 'en' : 'jp';
    if (els.vsLangTabs) {
        els.vsLangTabs.querySelectorAll('.vs-lang-tab').forEach(btn => {
            const active = btn.dataset.lang === state.vowelSpace.language;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
    // Personal calibration is per-language → enable/disable "Me" tab
    if (typeof updateVoiceTypeTabs === 'function') updateVoiceTypeTabs();
    // If user was on "me" but no personal data for this language, fall back to male
    if (state.vowelSpace.voiceType === 'me') {
        const personal = state.vowelSpace.calibration.saved?.[state.vowelSpace.language];
        if (!personal || personal.length === 0) {
            if (typeof applyVowelSpaceVoice === 'function') applyVowelSpaceVoice('male');
        }
    }
    drawVowelSpace();
}

function applyVowelSpaceVoice(voice) {
    const v = ['male', 'female', 'child'].includes(voice) ? voice : 'male';
    state.vowelSpace.voiceType = v;
    if (els.vsVoiceTabs) {
        els.vsVoiceTabs.querySelectorAll('.vs-lang-tab').forEach(btn => {
            const active = btn.dataset.voice === v;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
    drawVowelSpace();
}

function updateSynthVibratoDisplay() {
    const v = state.vibrato;
    if (!v) return;
    const fmt = (n, d = 1) => Number.isFinite(n) ? n.toFixed(d) : '—';
    if (els.vibSynthRate) els.vibSynthRate.textContent = fmt(v.rate, 1);
    if (els.vibSynthExtent) els.vibSynthExtent.textContent = Math.round(v.extent ?? 0);
    if (els.vibSynthDelay) els.vibSynthDelay.textContent = Math.round(v.onsetDelay ?? 0);
    if (els.vibSynthRamp) els.vibSynthRamp.textContent = Math.round(v.onsetRamp ?? 0);
    if (els.vibSynthAm) els.vibSynthAm.textContent = Math.round(v.amDepth ?? 0);
    if (els.vibSynthWave) els.vibSynthWave.textContent = v.waveform || '—';
    if (els.vibSynthStatus) {
        const playing = isPlaying;
        const off = !v.enabled || (v.extent ?? 0) === 0;
        els.vibSynthStatus.textContent = !playing ? '(停止中)' : (off ? '(Off)' : '');
    }
}

function applyVibAnalysisMode(mode) {
    const m = mode === 'advanced' ? 'advanced' : 'basic';
    if (els.vibAnalysisBody) {
        els.vibAnalysisBody.classList.toggle('is-basic', m === 'basic');
        els.vibAnalysisBody.classList.toggle('is-advanced', m === 'advanced');
    }
    if (els.vibModeTabs) {
        els.vibModeTabs.querySelectorAll('.vib-mode-tab').forEach(btn => {
            const active = btn.dataset.mode === m;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
    }
}

let lastVibPanelMicState = null;
function updateVibratoPanelVisibility() {
    // Panel is a collapsible <details> that is always present in the DOM.
    // We only need to clear the UI / trace when mic transitions off.
    if (state.isMicActive !== lastVibPanelMicState) {
        if (!state.isMicActive) {
            resetVibratoUi();
            drawVibratoTrace(); // repaint hint
        }
        lastVibPanelMicState = state.isMicActive;
    }
}

// --- Visualizer ---

function resizeCanvas() {
    els.canvas.width = els.canvas.clientWidth;
    els.canvas.height = els.canvas.clientHeight;
}

function drawVisualizer() {
    if (!isPlaying && !state.isMicActive) return;

    // Pitch sampling + vibrato analysis (independent of view mode)
    if (state.isMicActive && micAnalyser) {
        if (!state.isMicPaused) {
            const micPitch = detectPitchFromMic();
            state.cachedMicPitch = micPitch;
            pushPitchSample(micPitch, _yinClarity);
        }
    } else if (state.vibratoAnalysis.pitchBuf.length) {
        state.vibratoAnalysis.pitchBuf = [];
        resetVibratoUi();
    }

    const nowT = performance.now();
    const va = state.vibratoAnalysis;
    if (state.isMicActive && nowT - va.lastAnalysisAt >= VIBRATO_ANALYSIS_INTERVAL) {
        analyzeVibrato();
        drawVibratoTrace();
    }
    updateVibratoPanelVisibility();

    // Vowel Space: push F1/F2 sample every frame, redraw if panel open (~30fps)
    if (state.isMicActive) pushVowelSample();
    if (state.isMicActive && !state.isMicPaused) updateLoudnessMeter();
    if (state.vowelSpace.calibration.active) advanceCalibration(nowT);
    if (els.vowelSpacePanel && els.vowelSpacePanel.open) {
        if (!drawVisualizer._lastVsDraw || nowT - drawVisualizer._lastVsDraw > 33) {
            drawVowelSpace();
            drawVisualizer._lastVsDraw = nowT;
        }
    }

    // Spectrogram view: replace spectrum drawing entirely
    if (state.viewMode === 'spectrogram') {
        initSpectrogramBuffer();
        pushSpectrogramColumn();
        renderSpectrogram();
        animationId = requestAnimationFrame(drawVisualizer);
        return;
    }

    resizeCanvas();
    const width = els.canvas.width;
    const height = els.canvas.height;

    // Clear background
    canvasCtx.fillStyle = '#FFFEF9';
    canvasCtx.fillRect(0, 0, width, height);

    // Draw Selection Background Highlight (Glassmorphism-ish)
    if (state.selectionActive) {
        const x1 = Math.max(0, freqToX(state.selectionMinFreq, width));
        const x2 = Math.min(width, freqToX(state.selectionMaxFreq, width));
        const selWidth = x2 - x1;

        if (selWidth > 0) {
            const selGradient = canvasCtx.createLinearGradient(0, 0, 0, height);
            selGradient.addColorStop(0, 'rgba(33, 150, 243, 0.12)');
            selGradient.addColorStop(1, 'rgba(33, 150, 243, 0.04)');
            canvasCtx.fillStyle = selGradient;
            canvasCtx.fillRect(x1, 0, selWidth, height);

            canvasCtx.beginPath();
            canvasCtx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
            canvasCtx.setLineDash([4, 4]);
            canvasCtx.lineWidth = 1;
            canvasCtx.moveTo(x1, 0);
            canvasCtx.lineTo(x1, height);
            canvasCtx.moveTo(x2, 0);
            canvasCtx.lineTo(x2, height);
            canvasCtx.stroke();
            canvasCtx.setLineDash([]);
        }
    }

    // Tuner-style pitch display from mic input (pitch already cached at top of drawVisualizer)
    if (state.isMicActive && micAnalyser) {
        const detectedPitch = state.cachedMicPitch;

        if (detectedPitch > 0) {
            const noteName = freqToNote(detectedPitch);
            canvasCtx.save();

            // Large note name (like a tuner)
            canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.1)';
            canvasCtx.font = '700 48px Inter, sans-serif';
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillText(noteName, width / 2, height / 2 - 10);

            // Frequency below
            canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.08)';
            canvasCtx.font = '400 18px Inter, sans-serif';
            const cents = freqToCents(detectedPitch);
            const centsLabel = `${cents > 0 ? '+' : (cents < 0 ? '' : '±')}${cents}¢`;
            canvasCtx.fillText(`${Math.round(detectedPitch)} Hz  ${centsLabel}`, width / 2, height / 2 + 28);

            canvasCtx.restore();
        }
    }

    // Draw Grid lines
    canvasCtx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    canvasCtx.lineWidth = 1;
    canvasCtx.beginPath();

    const gridFreqs = state.logScale
        ? [100, 200, 500, 1000, 2000, 5000]
        : [1000, 2000, 3000, 4000, 5000];

    for (const gf of gridFreqs) {
        const x = freqToX(gf, width);
        canvasCtx.moveTo(x, 0);
        canvasCtx.lineTo(x, height);
    }
    canvasCtx.stroke();

    // Grid frequency labels (drawn on canvas so they match the actual scale)
    if (state.logScale) {
        canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.2)';
        canvasCtx.font = '9px Inter, sans-serif';
        canvasCtx.textAlign = 'center';
        canvasCtx.textBaseline = 'bottom';
        for (const gf of gridFreqs) {
            const x = freqToX(gf, width);
            const label = gf >= 1000 ? `${gf / 1000}k` : `${gf}`;
            canvasCtx.fillText(label, x, height - 2);
        }
    }

    const nyquist = audioCtx ? audioCtx.sampleRate / 2 : 24000;

    // Helper to draw a single frequency spectrum
    const drawSpectrum = (analyzerNode, strokeColor, fillColor, boost, dataArrayOverride = null) => {
        if (!analyzerNode) return;
        const bufferLength = analyzerNode.frequencyBinCount;

        let dataArray;
        if (dataArrayOverride) {
            dataArray = dataArrayOverride;
        } else {
            dataArray = new Float32Array(bufferLength);
            analyzerNode.getFloatFrequencyData(dataArray);
        }

        const maxDb = analyzerNode.maxDecibels;
        const minDb = analyzerNode.minDecibels;
        const dbRange = maxDb - minDb;

        canvasCtx.beginPath();
        canvasCtx.strokeStyle = strokeColor;
        canvasCtx.lineWidth = 2;
        canvasCtx.moveTo(0, height);

        let isFirst = true;
        for (let i = 0; i < bufferLength; i++) {
            const freq = (i * nyquist) / bufferLength;
            if (freq > MAX_FREQ_DISPLAY) break;

            const x = freqToX(freq, width);
            let db = dataArray[i];
            if (!isFinite(db)) db = minDb;
            const normalizedValue = Math.max(0, (db - minDb) / dbRange);
            const displayVal = Math.pow(normalizedValue, boost);
            const y = height - (displayVal * height * 0.9);

            if (isFirst) {
                canvasCtx.lineTo(x, y);
                isFirst = false;
            } else {
                canvasCtx.lineTo(x, y);
            }
        }

        const endXPos = canvasCtx.currentX || width;
        canvasCtx.lineTo(endXPos, height);

        if (fillColor) {
            canvasCtx.fillStyle = fillColor;
            canvasCtx.fill();
        }
        canvasCtx.stroke();
    };

    // Estimate formants using Peak Picking with pitch-aware smoothing and pre-emphasis
    const estimatePeakFormants = (dataArray, minDb, dbRange, nyq, pitch) => {
        const bufferLength = dataArray.length;
        const smoothed = new Float32Array(bufferLength);

        let windowSize = Math.max(2, Math.floor(bufferLength * 0.01));
        if (pitch > 50 && pitch < 1200) {
            // Smooth over harmonics based on detected pitch
            windowSize = Math.max(2, Math.floor((pitch / nyq) * bufferLength * 0.7));
        }

        for (let i = 0; i < bufferLength; i++) {
            let sum = 0;
            let count = 0;
            for (let j = Math.max(0, i - windowSize); j <= Math.min(bufferLength - 1, i + windowSize); j++) {
                const f = (j * nyq) / bufferLength;
                const tilt = Math.max(0, 6 * Math.log2(Math.max(10, f) / 1000));
                sum += dataArray[j] + tilt;
                count++;
            }
            smoothed[i] = sum / count;
        }

        const findPeakWithParabolicInterpolation = (minHz, maxHz) => {
            let peakBinVal = -Infinity;
            let peakBinIndex = -1;

            const minBin = Math.floor((minHz / nyq) * bufferLength);
            const maxBin = Math.floor((maxHz / nyq) * bufferLength);

            for (let i = Math.max(1, minBin); i <= Math.min(bufferLength - 2, maxBin); i++) {
                if (smoothed[i] > peakBinVal && smoothed[i] > smoothed[i - 1] && smoothed[i] > smoothed[i + 1]) {
                    peakBinVal = smoothed[i];
                    peakBinIndex = i;
                }
            }

            if (peakBinIndex !== -1 && peakBinVal > minDb + (dbRange * 0.15)) {
                // Parabolic Interpolation
                const alpha = smoothed[peakBinIndex - 1];
                const beta = smoothed[peakBinIndex];
                const gamma = smoothed[peakBinIndex + 1];

                const denom = alpha - 2 * beta + gamma;
                let p = 0;
                if (Math.abs(denom) > 1e-6) {
                    p = 0.5 * (alpha - gamma) / denom;
                }
                const truePeakFreq = ((peakBinIndex + p) * nyq) / bufferLength;
                const tiltToRemove = Math.max(0, 6 * Math.log2(Math.max(10, truePeakFreq) / 1000));

                return { freq: truePeakFreq, db: beta - tiltToRemove };
            }
            return null;
        };

        return {
            f1: findPeakWithParabolicInterpolation(300, 1000),
            f2: findPeakWithParabolicInterpolation(1000, 2500),
            f3: findPeakWithParabolicInterpolation(2500, 3500),
            f4: findPeakWithParabolicInterpolation(3500, 4500),
            f5: findPeakWithParabolicInterpolation(4500, 5500)
        };
    };

    let lpcTimeData = null;
    const estimateLpcFormants = (analyzer, minDb, dbRange, nyq) => {
        const p = 40; // LPC order (40 is typical for 48kHz to capture all resonances)
        const timeDomainSize = analyzer.fftSize;
        if (!lpcTimeData || lpcTimeData.length !== timeDomainSize) {
            lpcTimeData = new Float32Array(timeDomainSize);
        }
        analyzer.getFloatTimeDomainData(lpcTimeData);

        // Check RMS to avoid analyzing pure silence/noise which produces unstable LPC
        let rms = 0;
        for (let i = 0; i < timeDomainSize; i++) {
            rms += lpcTimeData[i] * lpcTimeData[i];
        }
        rms = Math.sqrt(rms / timeDomainSize);
        if (rms < 0.005) return { f1: null, f2: null, f3: null, f4: null, f5: null };

        // 1. Pre-emphasis and Windowing using Double Precision (Float64)
        const preEmpTime = new Float64Array(timeDomainSize);
        for (let i = 0; i < timeDomainSize; i++) {
            const x_n = lpcTimeData[i];
            const x_n1 = i > 0 ? lpcTimeData[i - 1] : 0;
            const signal = x_n - 0.95 * x_n1; // Pre-emphasis flattens the spectrum
            // Hann windowing
            const window = 0.5 * (1 - Math.cos(2 * Math.PI * i / (timeDomainSize - 1)));
            preEmpTime[i] = signal * window;
        }

        // 2. Autocorrelation (R)
        const R = new Float64Array(p + 1);
        for (let k = 0; k <= p; k++) {
            let sum = 0;
            for (let n = 0; n < timeDomainSize - k; n++) {
                sum += preEmpTime[n] * preEmpTime[n + k];
            }
            R[k] = sum;
        }

        // 3. Levinson-Durbin Recursion
        const a = new Float64Array(p + 1);
        const kArr = new Float64Array(p + 1);
        let E = R[0];
        a[0] = 1;

        if (E <= 1e-10) return { f1: null, f2: null, f3: null, f4: null, f5: null };

        for (let i = 1; i <= p; i++) {
            let sum = 0;
            for (let j = 1; j < i; j++) {
                sum += a[j] * R[i - j];
            }
            kArr[i] = (R[i] - sum) / E;

            // Stability check - if Reflection coefficient >= 1, filter is unstable
            if (Math.abs(kArr[i]) >= 1.0) {
                break; // Stop at previous stable order
            }

            const a_prev = new Float64Array(a);
            a[i] = kArr[i];
            for (let j = 1; j < i; j++) {
                a[j] = a_prev[j] - kArr[i] * a_prev[i - j];
            }
            E = (1 - kArr[i] * kArr[i]) * E;
            if (E <= 1e-10 || isNaN(E)) {
                break;
            }
        }

        // 4. Evaluate Frequency Response of the LPC filter
        const N = 2048; // Higher resolution for smooth envelope
        const envelope = new Float64Array(N);
        const maxDb = minDb + dbRange;

        for (let k = 0; k < N; k++) {
            const omega = Math.PI * (k / N);
            let real = 1.0;
            let imag = 0.0;
            for (let i = 1; i <= p; i++) {
                // Evaluate 1 - sum(a_i * z^-i)
                real -= a[i] * Math.cos(i * omega);
                imag += a[i] * Math.sin(i * omega);
            }
            const magSq = real * real + imag * imag;
            const mag = 1.0 / Math.sqrt(magSq);
            // Convert to dB, add approximate offset 
            const db = 20 * Math.log10(magSq === 0 ? 1e-10 : mag) + (maxDb - 30);
            envelope[k] = db;
        }

        // 5. Peak picking strategy
        const findPeakInEnvelope = (minHz, maxHz) => {
            const minBin = Math.floor((minHz / nyq) * N);
            const maxBin = Math.ceil((maxHz / nyq) * N);
            let peakVal = -Infinity;
            let peakBin = -1;

            for (let i = Math.max(1, minBin); i <= Math.min(N - 2, maxBin); i++) {
                if (envelope[i] > peakVal && envelope[i] > envelope[i - 1] && envelope[i] > envelope[i + 1]) {
                    peakVal = envelope[i];
                    peakBin = i;
                }
            }

            if (peakBin !== -1 && peakVal > minDb + (dbRange * 0.05)) { // Lowered threshold slightly
                // Parabolic interpolation for sub-bin precision
                const alpha = envelope[peakBin - 1];
                const beta = envelope[peakBin];
                const gamma = envelope[peakBin + 1];
                const denom = alpha - 2 * beta + gamma;
                let p_interp = 0;
                if (Math.abs(denom) > 1e-6) p_interp = 0.5 * (alpha - gamma) / denom;
                const trueFreq = ((peakBin + p_interp) * nyq) / N;

                return { freq: trueFreq, db: beta };
            }
            return null;
        };

        return {
            f1: findPeakInEnvelope(300, 1000),
            f2: findPeakInEnvelope(1000, 2500),
            f3: findPeakInEnvelope(2500, 3500),
            f4: findPeakInEnvelope(3500, 4500),
            f5: findPeakInEnvelope(4500, 5500)
        };
    };

    // Frequency bands used as bootstrap (no prior anchors) and as fallback for unassigned slots
    const formantBands = () => state.voiceType === 'treble'
        ? [[250, 1200], [800, 2800], [2200, 3600], [3200, 4500], [4000, 5500]]
        : [[200, 1000], [700, 2500], [2000, 3300], [2900, 4200], [3800, 5400]];

    // Continuity-based assignment: prefer last frame's positions, fall back to bands.
    // Enforces F1 < F2 < F3 < F4 < F5 to prevent slot swaps when formants are close (e.g. /i/).
    // anchors: { f1, f2, f3, f4, f5 } where each is the previous smoothed freq (or null).
    const assignFormants = (candidates, anchors) => {
        const keys = ['f1', 'f2', 'f3', 'f4', 'f5'];
        const result = { f1: null, f2: null, f3: null, f4: null, f5: null };
        const used = new Array(candidates.length).fill(false);
        const maxDist = [220, 420, 520, 700, 800]; // per-slot Hz tolerance
        const MIN_GAP = 60; // minimum Hz spacing between adjacent formants

        // Ordering guard: a freq is allowed for slot i only if it sits strictly between
        // the nearest already-assigned neighbors (with MIN_GAP margin).
        const violatesOrdering = (slotIdx, freq) => {
            for (let q = slotIdx - 1; q >= 0; q--) {
                if (result[keys[q]] != null) { if (freq <= result[keys[q]] + MIN_GAP) return true; break; }
            }
            for (let q = slotIdx + 1; q < 5; q++) {
                if (result[keys[q]] != null) { if (freq >= result[keys[q]] - MIN_GAP) return true; break; }
            }
            return false;
        };

        // Pass 1: anchor-based, greedy by best distance first (not slot order)
        if (anchors) {
            const pairs = [];
            for (let i = 0; i < 5; i++) {
                const target = anchors[keys[i]];
                if (target == null) continue;
                for (let j = 0; j < candidates.length; j++) {
                    const d = Math.abs(candidates[j].freq - target);
                    if (d <= maxDist[i]) pairs.push({ i, j, d });
                }
            }
            pairs.sort((a, b) => a.d - b.d);
            for (const p of pairs) {
                if (result[keys[p.i]] != null || used[p.j]) continue;
                const f = candidates[p.j].freq;
                if (violatesOrdering(p.i, f)) continue;
                result[keys[p.i]] = f;
                used[p.j] = true;
            }
        }

        // Pass 2: band-based fallback for still-empty slots (also enforces ordering)
        const bands = formantBands();
        for (let i = 0; i < 5; i++) {
            const k = keys[i];
            if (result[k] != null) continue;
            const [lo, hi] = bands[i];
            for (let j = 0; j < candidates.length; j++) {
                if (used[j]) continue;
                const f = candidates[j].freq;
                if (f < lo || f > hi) continue;
                if (violatesOrdering(i, f)) continue;
                result[k] = f;
                used[j] = true;
                break;
            }
        }
        return result;
    };

    // Shared LPC pipeline (Praat-inspired): decimate → voicing → LPC → root-find → formant assignment.
    // anchors: previous smoothed F1-F5 for continuity tracking (null = bootstrap).
    // Returns { voiced: true, raw: {f1..f5} } or { voiced: false }.
    const lpcCoreExtract = (analyzer, anchors) => {
        const sr = audioCtx.sampleRate;
        const N = analyzer.fftSize;

        if (!lpcCoreState.timeBuf || lpcCoreState.timeBuf.length !== N) {
            lpcCoreState.timeBuf = new Float32Array(N);
        }
        const buf = lpcCoreState.timeBuf;
        analyzer.getFloatTimeDomainData(buf);

        // RMS gate
        let rms = 0;
        for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
        rms = Math.sqrt(rms / N);
        if (rms < 0.004) return { voiced: false };

        // Decimate by 4 (box-average lowpass)
        const decimFactor = 4;
        const decN = Math.floor(N / decimFactor);
        const decSr = sr / decimFactor;
        if (!lpcCoreState.decimated || lpcCoreState.decimated.length !== decN) {
            lpcCoreState.decimated = new Float32Array(decN);
        }
        const dec = lpcCoreState.decimated;
        for (let i = 0; i < decN; i++) {
            const base = i * decimFactor;
            let s = 0;
            for (let k = 0; k < decimFactor; k++) s += buf[base + k];
            dec[i] = s / decimFactor;
        }

        // Voicing strength via autocorrelation peak ratio
        const minP = Math.max(2, Math.floor(decSr / 1100));
        const maxP = Math.min(decN - 1, Math.floor(decSr / 70));
        let r0 = 0;
        for (let i = 0; i < decN; i++) r0 += dec[i] * dec[i];
        if (r0 < 1e-9) return { voiced: false };
        let bestRatio = 0;
        for (let pp = minP; pp <= maxP; pp++) {
            let s = 0;
            for (let i = 0; i < decN - pp; i++) s += dec[i] * dec[i + pp];
            const ratio = s / r0;
            if (ratio > bestRatio) bestRatio = ratio;
        }
        if (bestRatio < 0.25) return { voiced: false };

        // Pre-emphasis (cutoff = 50 Hz) + Hann window
        const alpha = Math.exp(-2 * Math.PI * 50 / decSr);
        if (!lpcCoreState.preEmp || lpcCoreState.preEmp.length !== decN) {
            lpcCoreState.preEmp = new Float64Array(decN);
        }
        const x = lpcCoreState.preEmp;
        for (let i = 0; i < decN; i++) {
            const xn = dec[i];
            const xn1 = i > 0 ? dec[i - 1] : 0;
            const sig = xn - alpha * xn1;
            const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (decN - 1)));
            x[i] = sig * w;
        }

        // LPC via Burg method (Praat default — more accurate than autocorrelation for short windows)
        const p = 12;
        const kCurrent = burgLpc(x, decN, p);
        if (!kCurrent) return { voiced: false };

        // Multi-frame reflection coefficient averaging (temporal stabilization).
        // Reset history if voicing resumed after a long silence so we don't blend in stale state.
        const tNow = performance.now();
        if (tNow - lpcCoreState.lastVoicedTime > 200) lpcCoreState.kHistory.length = 0;
        lpcCoreState.lastVoicedTime = tNow;

        lpcCoreState.kHistory.push(kCurrent);
        if (lpcCoreState.kHistory.length > LPC_K_HISTORY_LEN) lpcCoreState.kHistory.shift();
        const kAvg = new Float64Array(p + 1);
        for (const hist of lpcCoreState.kHistory) {
            for (let i = 1; i <= p; i++) kAvg[i] += hist[i];
        }
        const histN = lpcCoreState.kHistory.length;
        for (let i = 1; i <= p; i++) kAvg[i] /= histN;

        const a = reflectionsToPredictions(kAvg, p);

        // Root finding (Durand-Kerner)
        const polyCoeffs = new Float64Array(p + 1);
        polyCoeffs[0] = 1;
        for (let i = 1; i <= p; i++) polyCoeffs[i] = -a[i];
        const roots = durandKerner(polyCoeffs, p);
        if (!roots) return { voiced: false };

        // Extract formant candidates from upper-half-plane roots
        const candidates = [];
        for (let i = 0; i < p; i++) {
            const re = roots[2 * i];
            const im = roots[2 * i + 1];
            if (im <= 0) continue;
            const mag = Math.sqrt(re * re + im * im);
            if (mag <= 0 || mag >= 1.0) continue;
            const freq = Math.atan2(im, re) * decSr / (2 * Math.PI);
            const bw = -Math.log(mag) * decSr / Math.PI;
            if (freq < 90 || freq > 5500) continue;
            if (bw > 600) continue;
            candidates.push({ freq, bw });
        }
        candidates.sort((u, v) => u.freq - v.freq);

        // Assign F1-F5 by continuity (with band-assignment fallback)
        const raw = assignFormants(candidates, anchors);

        const foundCount = ['f1', 'f2', 'f3', 'f4', 'f5'].filter(k => raw[k] != null).length;
        if (foundCount < 2) return { voiced: false };

        // Per-frame confidence ∈ [0,1]: voicing strength × F1/F2 sharpness × completeness.
        // Used downstream to freeze the formant display on shaky frames instead of
        // letting a spurious root yank the readout to the wrong vowel.
        const voicingScore = Math.max(0, Math.min(1, (bestRatio - 0.30) / 0.50)); // 0.30→0, 0.80→1
        const bwOf = (f) => {
            if (f == null) return 600;
            let best = 600, bd = Infinity;
            for (const c of candidates) {
                const d = Math.abs(c.freq - f);
                if (d < bd) { bd = d; best = c.bw; }
            }
            return best;
        };
        const meanBw = (bwOf(raw.f1) + bwOf(raw.f2)) / 2;        // narrow = resonant = trustworthy
        const sharpScore = Math.max(0, Math.min(1, 1 - (meanBw - 80) / 320)); // 80Hz→1, 400Hz→0
        const countScore = Math.min(1, foundCount / 3);
        const confidence = voicingScore * (0.35 + 0.45 * sharpScore + 0.20 * countScore);

        // Snapshot LPC coefficients for the envelope overlay
        lpcCoreState.lastCoefs = a;
        lpcCoreState.lastP = p;
        lpcCoreState.lastDecSr = decSr;
        lpcCoreState.lastUpdate = performance.now();

        return { voiced: true, raw, confidence };
    };

    const FORMANT_KEYS = ['f1', 'f2', 'f3', 'f4', 'f5'];

    // v2: light median+EMA smoothing (median-of-3, EMA τ=0.30, hold 120ms)
    const estimateLpcV2Formants = (analyzer, minDb, dbRange) => {
        const dbVal = minDb + dbRange * 0.5;
        const core = lpcCoreExtract(analyzer, lpcV2State.smoothed);

        if (!core.voiced) {
            const stale = performance.now() - lpcV2State.lastVoiced > 120;
            if (stale) {
                for (const k of FORMANT_KEYS) {
                    lpcV2State.history[k] = [];
                    lpcV2State.smoothed[k] = null;
                }
                return { f1: null, f2: null, f3: null, f4: null, f5: null };
            }
            const out = {};
            for (const k of FORMANT_KEYS) {
                out[k] = lpcV2State.smoothed[k] != null ? { freq: lpcV2State.smoothed[k], db: dbVal } : null;
            }
            return out;
        }

        lpcV2State.lastVoiced = performance.now();
        const tau = 0.30; // EMA weight on previous value (lower = more responsive)
        const picked = {};
        for (const k of FORMANT_KEYS) {
            const r = core.raw[k];
            const hist = lpcV2State.history[k];
            if (r != null) {
                hist.push(r);
                if (hist.length > LPC_V2_HISTORY_LEN) hist.shift();
                const sorted = [...hist].sort((u, v) => u - v);
                const median = sorted[Math.floor(sorted.length / 2)];
                const prev = lpcV2State.smoothed[k];
                const next = prev == null ? median : (tau * prev + (1 - tau) * median);
                lpcV2State.smoothed[k] = next;
                picked[k] = { freq: next, db: dbVal };
            } else {
                picked[k] = lpcV2State.smoothed[k] != null ? { freq: lpcV2State.smoothed[k], db: dbVal } : null;
            }
        }
        return picked;
    };

    // v3: One-Euro adaptive filter (smooth at rest, responsive to fast changes)
    const estimateLpcV3Formants = (analyzer, minDb, dbRange) => {
        const dbVal = minDb + dbRange * 0.5;
        const now = performance.now();
        // Anchors for continuity: previous One-Euro output
        const anchors = {
            f1: lpcV3State.filters.f1?.prevX ?? null,
            f2: lpcV3State.filters.f2?.prevX ?? null,
            f3: lpcV3State.filters.f3?.prevX ?? null,
            f4: lpcV3State.filters.f4?.prevX ?? null,
            f5: lpcV3State.filters.f5?.prevX ?? null
        };
        const core = lpcCoreExtract(analyzer, anchors);

        if (!core.voiced) {
            const stale = now - lpcV3State.lastVoiced > 120;
            if (stale) {
                for (const k of FORMANT_KEYS) lpcV3State.filters[k] = null;
                return { f1: null, f2: null, f3: null, f4: null, f5: null };
            }
            const out = {};
            for (const k of FORMANT_KEYS) {
                const f = lpcV3State.filters[k];
                out[k] = (f && f.prevX != null) ? { freq: f.prevX, db: dbVal } : null;
            }
            return out;
        }

        lpcV3State.lastVoiced = now;
        state.cachedMicFormantConfidence = core.confidence;

        // Low-confidence freeze: don't ingest a shaky frame into the One-Euro filters
        // (that would drag the smoothed value toward a likely-wrong root). Hold the
        // previous output so the dot sits still instead of jumping to a bad vowel.
        if (core.confidence < LPC_CONF_GATE) {
            const out = {};
            for (const k of FORMANT_KEYS) {
                const f = lpcV3State.filters[k];
                out[k] = (f && f.prevX != null) ? { freq: f.prevX, db: dbVal } : null;
            }
            return out;
        }

        const picked = {};
        for (const k of FORMANT_KEYS) {
            const r = core.raw[k];
            if (r != null) {
                if (!lpcV3State.filters[k]) lpcV3State.filters[k] = makeOneEuro();
                const filtered = oneEuroStep(lpcV3State.filters[k], r, now);
                picked[k] = { freq: filtered, db: dbVal };
            } else {
                const f = lpcV3State.filters[k];
                picked[k] = (f && f.prevX != null) ? { freq: f.prevX, db: dbVal } : null;
            }
        }
        return picked;
    };

    // Durand-Kerner polynomial root finder.
    // poly[0]*z^n + poly[1]*z^(n-1) + ... + poly[n] = 0
    // Returns Float64Array of length 2n (re, im pairs), or null on failure.
    function durandKerner(poly, n) {
        // Normalize to monic
        if (poly[0] === 0) return null;
        const c = new Float64Array(n + 1);
        for (let i = 0; i <= n; i++) c[i] = poly[i] / poly[0];

        // Initial guesses: evenly spaced on a circle of radius 0.9 (slightly inside unit disc)
        const r = new Float64Array(2 * n);
        const radius = 0.9;
        for (let k = 0; k < n; k++) {
            const theta = 2 * Math.PI * k / n + 0.123; // small offset to avoid symmetry
            r[2 * k] = radius * Math.cos(theta);
            r[2 * k + 1] = radius * Math.sin(theta);
        }

        const MAX_ITER = 60;
        const EPS = 1e-10;
        for (let iter = 0; iter < MAX_ITER; iter++) {
            let maxDelta = 0;
            for (let k = 0; k < n; k++) {
                const xr = r[2 * k], xi = r[2 * k + 1];
                // Evaluate p(x) using Horner
                let pr = 1, pi = 0;
                for (let i = 1; i <= n; i++) {
                    // (pr+j*pi) * (xr+j*xi) + c[i]
                    const nr = pr * xr - pi * xi + c[i];
                    const ni = pr * xi + pi * xr;
                    pr = nr; pi = ni;
                }
                // Compute denominator = prod_{j != k} (x_k - x_j)
                let dr = 1, di = 0;
                for (let j = 0; j < n; j++) {
                    if (j === k) continue;
                    const yr = xr - r[2 * j];
                    const yi = xi - r[2 * j + 1];
                    const nr = dr * yr - di * yi;
                    const ni = dr * yi + di * yr;
                    dr = nr; di = ni;
                }
                const denomMag = dr * dr + di * di;
                if (denomMag < 1e-30) continue;
                // delta = p(x) / denom
                const deltaR = (pr * dr + pi * di) / denomMag;
                const deltaI = (pi * dr - pr * di) / denomMag;
                r[2 * k] = xr - deltaR;
                r[2 * k + 1] = xi - deltaI;
                const dMag = Math.sqrt(deltaR * deltaR + deltaI * deltaI);
                if (dMag > maxDelta) maxDelta = dMag;
                if (!isFinite(r[2 * k]) || !isFinite(r[2 * k + 1])) return null;
            }
            if (maxDelta < EPS) break;
        }
        return r;
    }

    // 1. Draw Simulated Spectrum (Blue, filled)
    if (isPlaying && analyser) {
        const gradient = canvasCtx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, 'rgba(33, 150, 243, 0.6)');
        gradient.addColorStop(1, 'rgba(33, 150, 243, 0.0)');

        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        analyser.getFloatFrequencyData(dataArray);

        if (state.selectionActive) {
            canvasCtx.globalAlpha = 0.25; // Dim out-of-range
            drawSpectrum(analyser, 'rgba(33, 150, 243, 0.9)', gradient, 1.5, dataArray);
            canvasCtx.globalAlpha = 1.0;

            const x1 = Math.max(0, freqToX(state.selectionMinFreq, width));
            const x2 = Math.min(width, freqToX(state.selectionMaxFreq, width));

            canvasCtx.save();
            canvasCtx.beginPath();
            canvasCtx.rect(x1, 0, x2 - x1, height);
            canvasCtx.clip();
            drawSpectrum(analyser, 'rgba(33, 150, 243, 0.9)', gradient, 1.5, dataArray);
            canvasCtx.restore();
        } else {
            drawSpectrum(analyser, 'rgba(33, 150, 243, 0.9)', gradient, 1.5, dataArray);
        }

        const maxDb = analyser.maxDecibels;
        const minDb = analyser.minDecibels;
        const dbRange = maxDb - minDb;

        canvasCtx.font = '10px monospace';
        canvasCtx.textAlign = 'center';

        const f0 = state.pitch;
        const searchRangeHz = f0 * 0.1; // Search +/- 10% around expected harmonic freq for the exact FFT bin peak

        // Roughness overlay: two layered strips at top
        //   Layer 1 (Roughness, ERB):  gradient blue → orange via f₀/ERB(f) ratio
        //   Layer 2 (Resolution):      hard boundaries at H9*f₀ (Resolved→Unresolved) and 5 kHz (→Ceiling)
        const roughOn = state.roughnessVisible;
        const roughNERB = roughOn ? computeResolvedLimit(f0) : Infinity;
        const roughNCeil = Math.floor(PITCH_CEILING_HZ / f0) + 1;

        if (roughOn) {
            const STRIP_GAP = 3;
            const STRIP_H = 14;
            const ROUGHNESS_Y = 6;
            const RESOLUTION_Y = ROUGHNESS_Y + STRIP_H + STRIP_GAP;

            // --- Layer 1: Roughness strip (gradient by f₀/ERB ratio) ---
            // Color blend: t=0 (ratio≥1) → blue; t=1 (ratio→0) → orange
            const PURE_RGB = [33, 150, 243];
            const ROUGH_RGB = [217, 125, 31];
            const colorAt = (f) => {
                const erb = erbHz(Math.max(f, 1));
                const ratio = f0 / erb;          // >1: pure / <1: rough
                const t = Math.max(0, Math.min(1, 1 - ratio));
                const r = Math.round(PURE_RGB[0] + (ROUGH_RGB[0] - PURE_RGB[0]) * t);
                const g = Math.round(PURE_RGB[1] + (ROUGH_RGB[1] - PURE_RGB[1]) * t);
                const b = Math.round(PURE_RGB[2] + (ROUGH_RGB[2] - PURE_RGB[2]) * t);
                return `rgb(${r}, ${g}, ${b})`;
            };
            canvasCtx.save();
            const step = 2; // 2-px resolution for the gradient strip
            for (let px = 0; px < width; px += step) {
                const f = (px / width) * MAX_FREQ_DISPLAY;
                canvasCtx.fillStyle = colorAt(f);
                canvasCtx.fillRect(px, ROUGHNESS_Y, step, STRIP_H);
            }
            // Strip outline
            canvasCtx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
            canvasCtx.lineWidth = 1;
            canvasCtx.strokeRect(0.5, ROUGHNESS_Y + 0.5, width - 1, STRIP_H - 1);
            // Strip labels (Pure left, Rough right)
            canvasCtx.font = 'bold 10px sans-serif';
            canvasCtx.fillStyle = 'rgba(255,255,255,0.95)';
            canvasCtx.textAlign = 'left';
            canvasCtx.fillText('Roughness: Pure', 6, ROUGHNESS_Y + 10);
            canvasCtx.textAlign = 'right';
            canvasCtx.fillText('Rough', width - 6, ROUGHNESS_Y + 10);
            canvasCtx.restore();

            // --- Layer 2: Resolution strip (3 hard segments) ---
            const xH9 = freqToX(Math.min(PITCH_INTEGRATION_LIMIT_N * f0, MAX_FREQ_DISPLAY), width);
            const xCeil = freqToX(Math.min(PITCH_CEILING_HZ, MAX_FREQ_DISPLAY), width);
            const segments = [
                // [x0, x1, fill, label]
                [0, Math.min(xH9, xCeil), 'rgba(46, 156, 100, 0.95)', 'Resolved (n<9)'],
                [Math.min(xH9, xCeil), xCeil, 'rgba(210, 69, 69, 0.85)', 'Unresolved (n≥9)'],
                [xCeil, width, 'rgba(140, 140, 140, 0.85)', 'Ceiling (>5kHz)']
            ];
            canvasCtx.save();
            for (const [x0, x1, fill, label] of segments) {
                if (x1 <= x0) continue;
                canvasCtx.fillStyle = fill;
                canvasCtx.fillRect(x0, RESOLUTION_Y, x1 - x0, STRIP_H);
                // Segment label, only if wide enough
                canvasCtx.font = 'bold 10px sans-serif';
                const labelW = canvasCtx.measureText(label).width;
                if (x1 - x0 > labelW + 12) {
                    canvasCtx.fillStyle = 'rgba(255,255,255,0.95)';
                    canvasCtx.textAlign = 'center';
                    canvasCtx.fillText(label, (x0 + x1) / 2, RESOLUTION_Y + 10);
                }
            }
            // Strip outline
            canvasCtx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
            canvasCtx.lineWidth = 1;
            canvasCtx.strokeRect(0.5, RESOLUTION_Y + 0.5, width - 1, STRIP_H - 1);
            // Left margin label
            canvasCtx.font = 'bold 10px sans-serif';
            canvasCtx.fillStyle = 'rgba(255,255,255,0.95)';
            canvasCtx.textAlign = 'left';
            canvasCtx.fillText('Resolution:', 6, RESOLUTION_Y + 10);
            canvasCtx.restore();

            // Faint guides at H9*f₀ and 5kHz dropping down from strips into the spectrum
            canvasCtx.save();
            canvasCtx.setLineDash([3, 5]);
            canvasCtx.lineWidth = 1;
            if (PITCH_INTEGRATION_LIMIT_N * f0 < PITCH_CEILING_HZ && PITCH_INTEGRATION_LIMIT_N * f0 <= MAX_FREQ_DISPLAY) {
                canvasCtx.strokeStyle = 'rgba(210, 69, 69, 0.35)';
                canvasCtx.beginPath();
                canvasCtx.moveTo(xH9, RESOLUTION_Y + STRIP_H);
                canvasCtx.lineTo(xH9, height);
                canvasCtx.stroke();
            }
            if (PITCH_CEILING_HZ <= MAX_FREQ_DISPLAY) {
                canvasCtx.strokeStyle = 'rgba(140, 140, 140, 0.45)';
                canvasCtx.beginPath();
                canvasCtx.moveTo(xCeil, RESOLUTION_Y + STRIP_H);
                canvasCtx.lineTo(xCeil, height);
                canvasCtx.stroke();
            }
            canvasCtx.restore();

            // Annotation in the empty area right of 5 kHz (under the Ceiling segment) — concise
            if (PITCH_CEILING_HZ < MAX_FREQ_DISPLAY) {
                canvasCtx.save();
                canvasCtx.textAlign = 'left';
                const annoX = Math.round(xCeil + 6);
                const annoY1 = Math.round(RESOLUTION_Y + STRIP_H + 14);
                canvasCtx.fillStyle = 'rgba(60, 60, 60, 1)';
                canvasCtx.font = 'bold 12px sans-serif';
                canvasCtx.fillText('├──┤ = ERB(n·f₀)', annoX, annoY1);
                canvasCtx.fillStyle = 'rgba(110, 110, 110, 1)';
                canvasCtx.font = '10px sans-serif';
                canvasCtx.fillText('耳が1音にまとめちゃう幅', annoX, annoY1 + 13);
                canvasCtx.fillStyle = 'rgba(60, 60, 60, 1)';
                canvasCtx.font = '11px sans-serif';
                canvasCtx.fillText('重なり = Rough', annoX, annoY1 + 28);
                canvasCtx.restore();
            }

            // ERB-width markers: thin black lines, staircase descending left→right (1 step per H)
            const ERB_BAR_Y_BASE = RESOLUTION_Y + STRIP_H + 6;
            const ERB_Y_STEP = 5;
            const maxH = Math.min(64, Math.floor(MAX_FREQ_DISPLAY / f0));
            canvasCtx.save();
            canvasCtx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
            canvasCtx.lineWidth = 1;
            for (let n = 1; n <= maxH; n++) {
                const freq = n * f0;
                if (freq > MAX_FREQ_DISPLAY) break;
                const erb = erbHz(freq);
                const xLeft = freqToX(Math.max(freq - erb / 2, 1), width);
                const xRight = freqToX(freq + erb / 2, width);
                const y = ERB_BAR_Y_BASE + (n - 1) * ERB_Y_STEP;
                canvasCtx.beginPath();
                canvasCtx.moveTo(xLeft, y);
                canvasCtx.lineTo(xRight, y);
                canvasCtx.stroke();
                // Tick caps
                canvasCtx.beginPath();
                canvasCtx.moveTo(xLeft, y - 2);
                canvasCtx.lineTo(xLeft, y + 2);
                canvasCtx.moveTo(xRight, y - 2);
                canvasCtx.lineTo(xRight, y + 2);
                canvasCtx.stroke();
            }
            canvasCtx.restore();


            canvasCtx.font = '10px monospace';
            canvasCtx.textAlign = 'center';
        }

        for (let h = 1; (f0 * h) <= MAX_FREQ_DISPLAY && h <= MAX_HARMONICS_ON_SPECTRUM; h++) {
            const expectedFreq = f0 * h;

            // Find actual peak bin around expected freq
            const minFreq = expectedFreq - searchRangeHz;
            const maxFreq = expectedFreq + searchRangeHz;

            let peakVal = -Infinity;
            let peakFreq = expectedFreq;

            for (let i = 0; i < bufferLength; i++) {
                const f = (i * nyquist) / bufferLength;
                if (f >= minFreq && f <= maxFreq) {
                    if (dataArray[i] > peakVal) {
                        peakVal = dataArray[i];
                        peakFreq = f;
                    }
                }
            }

            // Only draw if it's somewhat prominent (above noise floor + some margin)
            if (peakVal > minDb + (dbRange * 0.15)) {
                const normalizedValue = Math.max(0, (peakVal - minDb) / dbRange);
                const displayVal = Math.pow(normalizedValue, 1.5); // use same boost as drawing
                const y = height - (displayVal * height * 0.9);
                const x = freqToX(peakFreq, width);

                if (state.selectionActive && (expectedFreq < state.selectionMinFreq || expectedFreq > state.selectionMaxFreq)) {
                    canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                } else if (roughOn) {
                    canvasCtx.fillStyle = ROUGH_ZONE_COLOR[classifyHarmonic(h, f0, roughNERB)];
                } else {
                    canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.85)';
                }

                canvasCtx.fillText(HARMONIC_LABEL(h), x, y - 8);
            }
        }
    }

    // 2. Draw Live Microphone Spectrum (Green, outline only)
    if (state.isMicActive && micAnalyser) {
        if (!state.cachedMicData) {
            state.cachedMicData = new Float32Array(micAnalyser.frequencyBinCount);
        }

        // While a recording is playing, the spectrum comes from computePlaybackSpectrum()
        // (offline FFT of the decoded buffer, set in updatePlaybackUi) — don't overwrite
        // state.cachedMicData with the silent analyser (iOS feeds it nothing anyway).
        const pbActiveSpec = !!playbackAudio && !playbackAudio.paused && !!playbackBuffer;
        if (!state.isMicPaused && !pbActiveSpec) {
            micAnalyser.getFloatFrequencyData(state.cachedMicData);
        }

        drawSpectrum(micAnalyser, 'rgba(79, 150, 80, 0.95)', null, 1.2, state.cachedMicData);

        // --- Mic spectrum peak Hz labels ---
        // Find local maxima in the mic spectrum and label each with its Hz.
        // Independent of pitch detection so it works even on weak signals.
        if (state.cachedMicData) {
            const micBufLen = state.cachedMicData.length;
            const micNyq = audioCtx.sampleRate / 2;
            const micMinDb = micAnalyser.minDecibels;
            const micMaxDb = micAnalyser.maxDecibels;
            const micDbRange = micMaxDb - micMinDb;
            // Peak qualification thresholds
            const dbThresh = micMinDb + micDbRange * 0.25;
            // Compute bin range we care about (≤ MAX_FREQ_DISPLAY)
            const maxBin = Math.min(micBufLen - 2, Math.ceil((MAX_FREQ_DISPLAY / micNyq) * micBufLen));
            // Minimum horizontal pixel spacing between labels to avoid overlap
            const MIN_LABEL_PX = 32;
            // Local-maxima window in bins (smooths against tiny FFT ripples)
            const WIN = 3;

            const labels = [];
            for (let i = WIN; i < maxBin; i++) {
                const v = state.cachedMicData[i];
                if (v < dbThresh) continue;
                let isLocalMax = true;
                for (let k = 1; k <= WIN; k++) {
                    if (state.cachedMicData[i - k] >= v || state.cachedMicData[i + k] > v) {
                        isLocalMax = false; break;
                    }
                }
                if (!isLocalMax) continue;
                const f = (i * micNyq) / micBufLen;
                labels.push({ freq: f, val: v });
            }

            if (labels.length) {
                canvasCtx.save();
                canvasCtx.textAlign = 'center';
                canvasCtx.font = 'bold 9px monospace';

                // Greedy filter: keep tallest peaks first, drop ones too close in x
                labels.sort((a, b) => b.val - a.val);
                const kept = [];
                for (const lab of labels) {
                    const x = freqToX(lab.freq, width);
                    if (kept.every(k => Math.abs(k.x - x) >= MIN_LABEL_PX)) {
                        kept.push({ ...lab, x });
                    }
                }

                for (const lab of kept) {
                    const normVal = Math.max(0, (lab.val - micMinDb) / micDbRange);
                    const displayVal = Math.pow(normVal, 1.5);
                    const y = height - (displayVal * height * 0.9);
                    const hzTxt = `${Math.round(lab.freq)}Hz`;
                    const txtW = canvasCtx.measureText(hzTxt).width;
                    canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.88)';
                    canvasCtx.fillRect(lab.x - txtW / 2 - 3, y - 22, txtW + 6, 12);
                    canvasCtx.fillStyle = 'rgba(40, 100, 40, 0.95)';
                    canvasCtx.fillText(hzTxt, lab.x, y - 13);
                }
                canvasCtx.restore();
            }
        }

        // --- Real-time Formant Tracking (Mic F1 / F2) ---
        const maxDb = micAnalyser.maxDecibels;
        const minDb = micAnalyser.minDecibels;
        const dbRange = maxDb - minDb;
        const nyq = audioCtx.sampleRate / 2;

        let estFormants;
        const FORMANT_CACHE_HOLD_MS = 800; // how long to keep showing a dropped formant from cache
        if (!state.cachedMicFormants) {
            state.cachedMicFormants = { f1: null, f2: null, f3: null, f4: null, f5: null };
            state.cachedMicFormantsTime = { f1: 0, f2: 0, f3: 0, f4: 0, f5: 0 };
        }
        if (state.isMicPaused) {
            // Pause: freeze formants at the moment of pause (use cached snapshot)
            estFormants = state.cachedMicFormants;
        } else {
            // During playback, prefer the precomputed offline formant track (speed-independent,
            // iOS-safe). Falls back to live LPC until the track finishes building.
            const pbFormants = (!!playbackAudio && !playbackAudio.paused)
                ? lookupFormantTrack(playbackAudio.currentTime) : null;
            estFormants = pbFormants ? pbFormants : (
                state.micFormantMethod === 'lpc-v3' ? estimateLpcV3Formants(micAnalyser, minDb, dbRange) :
                state.micFormantMethod === 'lpc-v2' ? estimateLpcV2Formants(micAnalyser, minDb, dbRange) :
                state.micFormantMethod === 'lpc'    ? estimateLpcFormants(micAnalyser, minDb, dbRange, nyq) :
                                                      estimatePeakFormants(state.cachedMicData, minDb, dbRange, nyq, state.cachedMicPitch));
            // Per-formant cache with timed fallback:
            // - Update cache when a formant is detected
            // - For undetected formants, fall back to cache value if it's recent enough
            // This bridges momentary LPC dropouts (e.g. F4/F5 clustering in Yell mode).
            const now = performance.now();
            for (const k of ['f1', 'f2', 'f3', 'f4', 'f5']) {
                if (estFormants[k] != null) {
                    state.cachedMicFormants[k] = estFormants[k];
                    state.cachedMicFormantsTime[k] = now;
                } else if (state.cachedMicFormants[k] != null
                           && now - state.cachedMicFormantsTime[k] < FORMANT_CACHE_HOLD_MS) {
                    estFormants[k] = state.cachedMicFormants[k];
                }
            }
        }

        // LPC envelope overlay (v2/v3): the REAL all-pole magnitude response of the same
        // coefficients whose roots are the F1–F5 markers — so the curve and the markers are
        // guaranteed consistent (markers sit on the envelope peaks).
        if ((state.micFormantMethod === 'lpc-v2' || state.micFormantMethod === 'lpc-v3')
            && lpcCoreState.lastCoefs
            && (state.isMicPaused || performance.now() - lpcCoreState.lastUpdate < 200)) {
            const a = lpcCoreState.lastCoefs;
            const p = lpcCoreState.lastP;
            const decSr = lpcCoreState.lastDecSr;
            const maxFreq = Math.min(MAX_FREQ_DISPLAY, decSr / 2);
            const samples = 256;
            const dbs = new Float32Array(samples);
            const freqs = new Float32Array(samples);
            let envMin = Infinity, envMax = -Infinity;
            for (let s = 0; s < samples; s++) {
                const freq = (s / (samples - 1)) * maxFreq;
                const omega = 2 * Math.PI * freq / decSr;
                let reA = 1, imA = 0;
                for (let i = 1; i <= p; i++) {
                    reA -= a[i] * Math.cos(i * omega);
                    imA += a[i] * Math.sin(i * omega);
                }
                const magSq = reA * reA + imA * imA;
                const db = -10 * Math.log10(magSq < 1e-30 ? 1e-30 : magSq);
                dbs[s] = db; freqs[s] = freq;
                if (db < envMin) envMin = db;
                if (db > envMax) envMax = db;
            }
            const span = Math.max(1e-3, envMax - envMin);
            canvasCtx.save();
            canvasCtx.beginPath();
            canvasCtx.strokeStyle = 'rgba(140, 90, 200, 0.65)';
            canvasCtx.lineWidth = 1.8;
            canvasCtx.setLineDash([6, 3]);
            let lastY = 0;
            for (let s = 0; s < samples; s++) {
                const x = freqToX(freqs[s], width);
                const norm = (dbs[s] - envMin) / span;
                const y = height - norm * height * 0.78 - height * 0.10;
                if (s === 0) canvasCtx.moveTo(x, y);
                else canvasCtx.lineTo(x, y);
                lastY = y;
            }
            if (maxFreq < MAX_FREQ_DISPLAY) canvasCtx.lineTo(freqToX(MAX_FREQ_DISPLAY, width), lastY);
            canvasCtx.stroke();
            canvasCtx.setLineDash([]);
            canvasCtx.restore();
        }

        const drawMicFormantMarker = (formant, label, colorHex) => {
            if (!formant) return;
            const x = freqToX(formant.freq, width);
            // Fixed y for all Mic Fx pills so they align horizontally regardless of peak intensity
            const yPillTop = state.roughnessVisible ? 90 : 20;
            const yPillBottom = yPillTop + 16;
            // Hz readout sits just below the label pill
            const yHzTop = yPillBottom + 2;
            const yHzBottom = yHzTop + 13;

            // Animated vertical dashed line below the Hz readout down to canvas bottom
            canvasCtx.save();
            canvasCtx.beginPath();
            canvasCtx.globalAlpha = 0.6;
            canvasCtx.strokeStyle = colorHex;
            canvasCtx.lineDashOffset = -Date.now() / 20; // Animate dash pattern falling
            canvasCtx.setLineDash([4, 4]);
            canvasCtx.moveTo(x, yHzBottom + 2);
            canvasCtx.lineTo(x, height);
            canvasCtx.stroke();
            canvasCtx.setLineDash([]);

            // Label pill
            canvasCtx.globalAlpha = 0.9;
            canvasCtx.fillStyle = colorHex;
            canvasCtx.font = 'bold 10px monospace';
            const txtWidth = canvasCtx.measureText(label).width;
            canvasCtx.fillRect(x - txtWidth / 2 - 5, yPillTop, txtWidth + 10, 16);
            canvasCtx.globalAlpha = 1.0;
            canvasCtx.fillStyle = '#fff';
            canvasCtx.textAlign = 'center';
            canvasCtx.fillText(label, x, yPillTop + 12);

            // Hz numeric readout (white-backed pill for legibility over spectrum)
            const hzText = Math.round(formant.freq) + 'Hz';
            canvasCtx.font = 'bold 9px monospace';
            const hzWidth = canvasCtx.measureText(hzText).width;
            canvasCtx.globalAlpha = 0.88;
            canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.92)';
            canvasCtx.fillRect(x - hzWidth / 2 - 3, yHzTop, hzWidth + 6, 13);
            canvasCtx.globalAlpha = 1.0;
            canvasCtx.fillStyle = colorHex;
            canvasCtx.fillText(hzText, x, yHzTop + 10);
            canvasCtx.restore();
        };

        drawMicFormantMarker(estFormants.f1, 'F1', '#D24545'); // Red
        drawMicFormantMarker(estFormants.f2, 'F2', '#2196F3'); // Blue
        drawMicFormantMarker(estFormants.f3, 'F3', '#9C3CD9'); // Purple
        drawMicFormantMarker(estFormants.f4, 'F4', '#E68B30'); // Orange
        drawMicFormantMarker(estFormants.f5, 'F5', '#D946EF'); // Pink
    }

    // 3. Draw Formant Overlay Envelopes (Only when simulating)
    if (isPlaying) {
        const drawFormantEnvelope = (freq, q, label, color, enabled) => {
            if (!enabled) return;

            const cx = freqToX(freq, width);

            // Simple bell curve visualization based on Q factor to represent the filter shape
            canvasCtx.beginPath();
            canvasCtx.strokeStyle = color;
            canvasCtx.setLineDash([5, 5]);
            canvasCtx.lineWidth = 2;

            const numPoints = 100;
            // bandwidth approx freq / Q
            const bw = freq / q;

            for (let j = 0; j <= numPoints; j++) {
                const px = cx - (freqToX(bw, width) * 2) + (freqToX(bw, width) * 4 * (j / numPoints));

                // Gaussian bell curve approximation for visual
                const dist = Math.abs(px - cx) / freqToX(bw, width);
                let val = Math.exp(-0.5 * Math.pow(dist * 1.5, 2));

                const py = height - (val * height * 0.8);

                if (j === 0) canvasCtx.moveTo(px, py);
                else canvasCtx.lineTo(px, py);
            }
            canvasCtx.stroke();
            canvasCtx.setLineDash([]);

            // Label (placed below two-strip roughness band when ON, otherwise near top)
            canvasCtx.fillStyle = color;
            canvasCtx.font = '12px monospace';
            const fRxY = state.roughnessVisible ? 74 : 20;
            canvasCtx.fillText(label, cx - 10, fRxY);
        };

        drawFormantEnvelope(state.formants.f1.freq, state.formants.f1.q, 'fR1', '#D24545', state.formants.f1.enabled); // Red
        drawFormantEnvelope(state.formants.f2.freq, state.formants.f2.q, 'fR2', '#2196F3', state.formants.f2.enabled); // Blue
        drawFormantEnvelope(state.formants.f3.freq, state.formants.f3.q, 'fR3', '#9C3CD9', state.formants.f3.enabled); // Purple
        drawFormantEnvelope(state.formants.f4.freq, state.formants.f4.q, 'fR4', '#E68B30', state.formants.f4.enabled); // Orange
        drawFormantEnvelope(state.formants.f5.freq, state.formants.f5.q, 'fR5', '#D946EF', state.formants.f5.enabled); // Pink
    }

    // 4. Draw Slope Approximation Line (dashed yellow)
    if (state.showSlopeLine && isPlaying && analyser) {
        const slopeBufferLength = analyser.frequencyBinCount;
        const slopeDataArray = new Float32Array(slopeBufferLength);
        analyser.getFloatFrequencyData(slopeDataArray);

        const slopeMaxDb = analyser.maxDecibels;
        const slopeMinDb = analyser.minDecibels;
        const slopeDbRange = slopeMaxDb - slopeMinDb;

        // Find the 1fo (fundamental) peak dB value as our starting reference
        const f0 = state.pitch;
        const h0BinIndex = Math.round((f0 / nyquist) * slopeBufferLength);
        let h0Db = slopeDataArray[Math.min(h0BinIndex, slopeBufferLength - 1)];
        if (!isFinite(h0Db)) h0Db = slopeMinDb;

        canvasCtx.beginPath();
        canvasCtx.strokeStyle = 'rgba(217, 125, 31, 0.85)'; // Gold/Yellow
        canvasCtx.setLineDash([8, 6]);
        canvasCtx.lineWidth = 2;

        const slopeDbPerOctave = state.spectrumSlope; // Negative value e.g. -12

        // Draw from f0 to MAX_FREQ_DISPLAY
        const numSlopePoints = 200;
        for (let j = 0; j <= numSlopePoints; j++) {
            const fraction = j / numSlopePoints;
            // Logarithmic frequency sweep from f0 to MAX_FREQ_DISPLAY
            const freq = f0 * Math.pow(MAX_FREQ_DISPLAY / f0, fraction);
            if (freq > MAX_FREQ_DISPLAY) break;

            const x = freqToX(freq, width);

            // How many octaves above f0?
            const octavesAboveF0 = Math.log2(freq / f0);
            // The theoretical dB at this frequency
            const theoreticalDb = h0Db + (octavesAboveF0 * slopeDbPerOctave);

            // Convert to canvas Y using the same normalization as the spectrum
            const normalizedValue = Math.max(0, (theoreticalDb - slopeMinDb) / slopeDbRange);
            const displayVal = Math.pow(normalizedValue, 1.5);
            const y = height - (displayVal * height * 0.9);

            if (j === 0) canvasCtx.moveTo(x, y);
            else canvasCtx.lineTo(x, y);
        }
        canvasCtx.stroke();
        canvasCtx.setLineDash([]);

        // Label
        canvasCtx.fillStyle = 'rgba(217, 125, 31, 0.95)';
        canvasCtx.font = '11px monospace';
        canvasCtx.textAlign = 'left';
        canvasCtx.fillText(`Slope: ${slopeDbPerOctave}dB/oct`, freqToX(f0, width) + 5, 40);
    }

    // 5. Draw Target Harmonic Overlay (cyan dashed lines at target pitch harmonics)
    if (typeof VocalTractData !== 'undefined') {
        const targetKey = els.targetTimbre ? els.targetTimbre.value : 'none';
        if (targetKey !== 'none') {
            const preset = VocalTractData.targetPresets[targetKey];
            if (preset && preset.source && preset.source.pitch) {
                const targetF0 = preset.source.pitch;
                const targetFormants = preset.formants || {};

                canvasCtx.save();
                canvasCtx.setLineDash([4, 4]);
                canvasCtx.lineWidth = 1.5;

                const maxHarmonics = Math.floor(MAX_FREQ_DISPLAY / targetF0);
                const harmonicCap = IS_MOBILE ? 10 : 12;
                for (let h = 1; h <= maxHarmonics && h <= harmonicCap; h++) {
                    const hFreq = targetF0 * h;
                    if (hFreq > MAX_FREQ_DISPLAY) break;
                    const hx = freqToX(hFreq, width);

                    // Check if this harmonic sits near a target formant
                    let nearFormant = false;
                    let formantColor = 'rgba(33, 150, 243, 0.5)';
                    const fKeys = ['f1', 'f2', 'f3', 'f4', 'f5'];
                    const fColors = ['rgba(210, 69, 69, 0.5)', 'rgba(33, 150, 243, 0.5)', 'rgba(156, 60, 217, 0.5)', 'rgba(230, 139, 48, 0.5)', 'rgba(217, 70, 239, 0.5)'];
                    for (let fi = 0; fi < fKeys.length; fi++) {
                        const fVal = targetFormants[fKeys[fi]];
                        if (fVal && Math.abs(hFreq - fVal) < targetF0 * 0.4) {
                            nearFormant = true;
                            formantColor = fColors[fi];
                            break;
                        }
                    }

                    // Draw subtle background highlight for the entire harmonic column if near a formant
                    if (nearFormant) {
                        canvasCtx.fillStyle = formantColor.replace('0.5', '0.15').replace('0.25', '0.1'); // Make it very transparent
                        canvasCtx.fillRect(hx - 10, 0, 20, height);
                    }

                    // Vertical dashed line
                    canvasCtx.beginPath();
                    canvasCtx.strokeStyle = nearFormant ? formantColor : 'rgba(33, 150, 243, 0.4)';
                    canvasCtx.lineWidth = nearFormant ? 3 : 1.5;
                    if (nearFormant) {
                        canvasCtx.setLineDash([8, 6]); // Longer dashes for emphasized lines
                    } else {
                        canvasCtx.setLineDash([4, 4]);
                    }
                    canvasCtx.moveTo(hx, 0);
                    canvasCtx.lineTo(hx, height);
                    canvasCtx.stroke();

                    // Label target harmonics at bottom with background pill
                    if (nearFormant) {
                        canvasCtx.fillStyle = 'rgba(0,0,0,0.6)'; // Pill background
                        canvasCtx.fillRect(hx - 14, height - 16, 28, 14);

                        canvasCtx.fillStyle = formantColor;
                        canvasCtx.font = 'bold 11px monospace';
                        canvasCtx.textAlign = 'center';
                        canvasCtx.fillText(HARMONIC_LABEL(h), hx, height - 5);
                    }
                }

                canvasCtx.setLineDash([]);
                canvasCtx.restore();
            }
        }
    }

    animationId = requestAnimationFrame(drawVisualizer);
}

// --- Event Listeners ---

// Play/Stop
els.btnPlay.addEventListener('click', () => {
    if (isPlaying) stopAudio();
    else startAudio();
    updateSynthVibratoDisplay();
});

// Mic Toggle
els.btnMic.addEventListener('click', async () => {
    if (state.isMicActive) {
        // Disconnect and stop
        if (micStream) {
            micStream.getTracks().forEach(track => track.stop());
            micStream = null;
        }
        if (micGainNode) {
            micGainNode.disconnect();
            micGainNode = null;
        }
        if (micSource) {
            micSource.disconnect();
            micSource = null;
        }
        if (micAnalyserPitch) {
            try { micAnalyserPitch.disconnect(); } catch (_) {}
            micAnalyserPitch = null;
        }
        state.isMicActive = false;
        state.isMicPaused = false;
        state.cachedMicFormants = null;
        state.cachedMicFormantsTime = null;
        els.btnMic.classList.remove('mic-active');
        updateVibratoPanelVisibility();
        resetLoudnessMeter();
        // Stop any in-progress recording when mic is turned off
        if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
        if (els.btnMicRecord) {
            els.btnMicRecord.style.display = 'none';
            els.btnMicRecord.classList.remove('is-recording');
            if (els.micRecordTimer) els.micRecordTimer.textContent = '';
        }
        if (els.btnMicPause) {
            els.btnMicPause.style.display = 'none';
            els.btnMicPause.classList.remove('mic-paused');
            const svgPause = '<svg viewBox="0 0 24 24" width="' + (isMobilePage ? 20 : 12) + '" height="' + (isMobilePage ? 20 : 12) + '" fill="currentColor" style="vertical-align: ' + (isMobilePage ? 'top' : '-1px') + '; ' + (isMobilePage ? '' : 'margin-right: 4px;') + '"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            els.btnMicPause.innerHTML = isMobilePage ? svgPause : `${svgPause}Pause`;
        }
    } else {
        // Request permissions and start
        try {
            const audioConstraints = {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
            };
            if (state.micDeviceId) audioConstraints.deviceId = { exact: state.micDeviceId };
            micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
            // After permission granted, enumerateDevices returns real labels — refresh the picker
            refreshMicDevices();

            // Ensure full audio infrastructure is initialized (filters, gain, analyser)
            initAudio();
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }

            micSource = audioCtx.createMediaStreamSource(micStream);
            micGainNode = audioCtx.createGain();
            micGainNode.gain.value = state.micGain;

            micAnalyser = audioCtx.createAnalyser();
            micAnalyser.fftSize = 4096;
            micAnalyser.smoothingTimeConstant = 0.8;

            // Dedicated low-latency analyser for pitch detection (43ms window vs 85ms)
            micAnalyserPitch = audioCtx.createAnalyser();
            micAnalyserPitch.fftSize = 2048;
            micAnalyserPitch.smoothingTimeConstant = 0;

            // Connect mic source -> gain -> analyzer entirely locally (NO route to audioCtx.destination)
            micSource.connect(micGainNode);
            micGainNode.connect(micAnalyser);
            micGainNode.connect(micAnalyserPitch);

            // Fix: WebKit/Blink optimizes away disconnected media stream graphs.
            // Create a silent dummy oscillator attached to destination to keep the audio tick active, 
            // and link the analyser to it so the browser considers the mic stream "consumed".
            const silenceFilter = audioCtx.createGain();
            silenceFilter.gain.value = 0;
            micAnalyser.connect(silenceFilter);

            // Add an oscillator that generates 0Hz (DC) just to keep the graph alive
            const dummyOsc = audioCtx.createOscillator();
            dummyOsc.frequency.value = 0;
            dummyOsc.connect(silenceFilter);
            dummyOsc.start();

            // Store reference so it can be stopped later
            state.micDummyOsc = dummyOsc;

            silenceFilter.connect(audioCtx.destination);

            state.isMicActive = true;
            els.btnMic.classList.add('mic-active');
            if (els.btnMicPause) {
                els.btnMicPause.style.display = 'inline-flex';
            }
            if (els.btnMicRecord) {
                els.btnMicRecord.style.display = 'inline-flex';
            }

            // Kick off visualizer if it wasn't already running
            if (!isPlaying) {
                cancelAnimationFrame(animationId);
                drawVisualizer();
            }
        } catch (err) {
            console.error('Microphone access denied or error:', err);
            alert('Could not access the microphone. Please grant permission in your browser.');
        }
    }
});

// Mic Pause Toggle
if (els.btnMicPause) {
    els.btnMicPause.addEventListener('click', () => {
        if (!state.isMicActive) return;

        state.isMicPaused = !state.isMicPaused;

        if (state.isMicPaused) {
            els.btnMicPause.classList.add('mic-paused');
            const svgPlay = '<svg viewBox="0 0 24 24" width="' + (isMobilePage ? 20 : 12) + '" height="' + (isMobilePage ? 20 : 12) + '" fill="currentColor" style="vertical-align: ' + (isMobilePage ? 'top' : '-1px') + '; ' + (isMobilePage ? '' : 'margin-right: 4px;') + '"><path d="M8 5v14l11-7z"/></svg>';
            els.btnMicPause.innerHTML = isMobilePage ? svgPlay : `${svgPlay}Resume`;
        } else {
            els.btnMicPause.classList.remove('mic-paused');
            const svgPause = '<svg viewBox="0 0 24 24" width="' + (isMobilePage ? 20 : 12) + '" height="' + (isMobilePage ? 20 : 12) + '" fill="currentColor" style="vertical-align: ' + (isMobilePage ? 'top' : '-1px') + '; ' + (isMobilePage ? '' : 'margin-right: 4px;') + '"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            els.btnMicPause.innerHTML = isMobilePage ? svgPause : `${svgPause}Pause`;
        }
    });
}

// ============================================================
// Recording (local IndexedDB) — record / playback / list / delete
// ============================================================
const REC_MAX_MS = 60000;
let mediaRecorder = null;
let recChunks = [];
let recStartTs = 0;
let recTimerId = null;
let recAutoStopId = null;

// Playback uses an HTMLAudioElement for native pitch-preserving rate changes and
// free seeking. It is NOT routed through createMediaElementSource (iOS Safari won't
// feed an AnalyserNode); instead the recording is decoded into an AudioBuffer that is
// analysed offline at the playback position — speed-independent and iOS-safe.
// See computePlaybackSpectrum() (spectrum) and lookupFormantTrack() (formants).
let playbackAudio = null;       // HTMLAudioElement (audible, preservesPitch)
let playbackObjectUrl = null;   // object URL for the blob
let playbackBuffer = null;      // decoded AudioBuffer — analysis only (not audible)
let playbackRecId = null;
let playbackRate = 1.0;
let playbackLoop = false;
let playbackLoopA = 0;   // section-loop start, ratio [0,1]
let playbackLoopB = 1;   // section-loop end, ratio [0,1]
let playbackDurationSec = 0; // duration (sec); WebM elements can report Infinity
let pbSeeking = false;       // true only while actively dragging the seek slider

function pbDuration() {
    if (playbackDurationSec > 0) return playbackDurationSec;
    if (playbackBuffer && playbackBuffer.duration > 0) return playbackBuffer.duration;
    const d = playbackAudio ? playbackAudio.duration : 0;
    return isFinite(d) ? d : 0;
}

function pausePlayback() {
    if (playbackAudio && !playbackAudio.paused) { try { playbackAudio.pause(); } catch (_) {} }
    renderRecordingsList();
}

function resumePlayback() {
    if (playbackAudio && playbackAudio.paused) { playbackAudio.play().catch(() => {}); }
    if (!playbackUiRaf) playbackUiRaf = requestAnimationFrame(updatePlaybackUi);
    renderRecordingsList();
}
let playbackGainNode = null;    // audible output branch
let playbackUiRaf = null;
let micWasActiveBeforePlayback = false;

function fmtDuration(ms) {
    const s = Math.max(0, ms / 1000);
    return s.toFixed(1) + 's';
}
function fmtTimestamp(ms) {
    const d = new Date(ms);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pickRecorderMime() {
    const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4;codecs=mp4a.40.2',
        'audio/mp4',
        'audio/ogg;codecs=opus'
    ];
    for (const m of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
}

function updateRecTimer() {
    if (!els.micRecordTimer) return;
    const elapsed = performance.now() - recStartTs;
    const remain = Math.max(0, REC_MAX_MS - elapsed);
    els.micRecordTimer.textContent = (remain / 1000).toFixed(1) + 's';
}

async function startRecording() {
    if (!micStream || !state.isMicActive) {
        alert('まずマイクを ON にしてください');
        return;
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') return;

    const mime = pickRecorderMime();
    try {
        mediaRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream);
    } catch (err) {
        console.error('MediaRecorder init failed:', err);
        alert('このブラウザは録音をサポートしていません');
        return;
    }
    recChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
        const actualMime = mediaRecorder.mimeType || mime || 'audio/webm';
        const blob = new Blob(recChunks, { type: actualMime });
        const durationMs = Math.min(REC_MAX_MS, performance.now() - recStartTs);
        try {
            await RecordingsDB.save({
                blob,
                durationMs,
                mimeType: actualMime,
                sampleRate: audioCtx ? audioCtx.sampleRate : null
            });
            await refreshRecordingsList();
        } catch (err) {
            console.error('Failed to save recording:', err);
            alert('録音の保存に失敗しました: ' + err.message);
        }
        recChunks = [];
        if (els.btnMicRecord) els.btnMicRecord.classList.remove('is-recording');
        if (els.micRecordTimer) els.micRecordTimer.textContent = '';
        if (recTimerId) { clearInterval(recTimerId); recTimerId = null; }
        if (recAutoStopId) { clearTimeout(recAutoStopId); recAutoStopId = null; }
    };

    recStartTs = performance.now();
    mediaRecorder.start();
    // Auto-expand the recordings panel so the new item is visible after stop
    if (els.recordingsPanel) els.recordingsPanel.open = true;
    if (els.btnMicRecord) els.btnMicRecord.classList.add('is-recording');
    updateRecTimer();
    recTimerId = setInterval(updateRecTimer, 100);
    recAutoStopId = setTimeout(() => stopRecording(), REC_MAX_MS);
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
    }
}

// Ensure mic analysis pipeline exists even when live mic is off (for playback)
async function ensureAnalysisPipeline() {
    initAudio();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    if (!micGainNode) {
        micGainNode = audioCtx.createGain();
        micGainNode.gain.value = state.micGain;
    }
    if (!micAnalyser) {
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 4096;
        micAnalyser.smoothingTimeConstant = 0.8;
        micGainNode.connect(micAnalyser);
        // Keep graph alive (same trick as live mic path)
        const silenceFilter = audioCtx.createGain();
        silenceFilter.gain.value = 0;
        micAnalyser.connect(silenceFilter);
        silenceFilter.connect(audioCtx.destination);
    }
    if (!micAnalyserPitch) {
        micAnalyserPitch = audioCtx.createAnalyser();
        micAnalyserPitch.fftSize = 2048;
        micAnalyserPitch.smoothingTimeConstant = 0;
        micGainNode.connect(micAnalyserPitch);
    }
}

function ensurePlaybackGain() {
    if (!audioCtx) return;
    if (!playbackGainNode) {
        playbackGainNode = audioCtx.createGain();
        playbackGainNode.gain.value = 1.0;
        playbackGainNode.connect(audioCtx.destination);
    }
}

// ============================================================
// Offline playback analysis (ported from 2ae0a1b). Lets spectrum / Vowel Space
// react during <audio> playback WITHOUT an AnalyserNode — required on iOS Safari,
// where MediaElementSource does not feed an analyser. Operates on the decoded
// AudioBuffer at the absolute recording time, so it is speed-independent.
// ============================================================
let playbackFormantTrack = null; // { hop: sec, frames: [{f1..f5}|null] }

// Standalone Durand-Kerner (the live one is a closure; keep this self-contained).
function _dkRoots(poly, n) {
    if (poly[0] === 0) return null;
    const c = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) c[i] = poly[i] / poly[0];
    const r = new Float64Array(2 * n);
    for (let k = 0; k < n; k++) {
        const th = 2 * Math.PI * k / n + 0.123;
        r[2 * k] = 0.9 * Math.cos(th); r[2 * k + 1] = 0.9 * Math.sin(th);
    }
    for (let iter = 0; iter < 60; iter++) {
        let maxD = 0;
        for (let k = 0; k < n; k++) {
            const xr = r[2 * k], xi = r[2 * k + 1];
            let pr = 1, pi = 0;
            for (let i = 1; i <= n; i++) {
                const nr = pr * xr - pi * xi + c[i];
                const ni = pr * xi + pi * xr;
                pr = nr; pi = ni;
            }
            let dr = 1, di = 0;
            for (let j = 0; j < n; j++) {
                if (j === k) continue;
                const er = xr - r[2 * j], ei = xi - r[2 * j + 1];
                const tr = dr * er - di * ei, ti = dr * ei + di * er;
                dr = tr; di = ti;
            }
            const den = dr * dr + di * di;
            if (den < 1e-30) continue;
            const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
            r[2 * k] = xr - qr; r[2 * k + 1] = xi - qi;
            const d = Math.hypot(qr, qi);
            if (d > maxD) maxD = d;
        }
        if (maxD < 1e-10) break;
    }
    return r;
}

// Windowed-sinc anti-alias decimation to ~targetSr (proper LPF, unlike the live box avg).
function _offlineDecimate(mono, srOrig, targetSr) {
    const factor = Math.max(1, Math.round(srOrig / targetSr));
    if (factor === 1) return { data: mono, sr: srOrig };
    const fc = 0.45 / factor;                 // cutoff in cycles/sample (0.9 × new Nyquist)
    const M = 8 * factor + 1, c = (M - 1) / 2;
    const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const ker = new Float64Array(M);
    let ksum = 0;
    for (let n = 0; n < M; n++) {
        const ham = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (M - 1));
        ker[n] = sinc(2 * fc * (n - c)) * ham;
        ksum += ker[n];
    }
    for (let n = 0; n < M; n++) ker[n] /= ksum; // unity DC gain
    const outN = Math.floor(mono.length / factor);
    const out = new Float32Array(outN);
    const half = (M - 1) >> 1;
    for (let i = 0; i < outN; i++) {
        const center = i * factor;
        let acc = 0;
        for (let n = 0; n < M; n++) {
            const idx = center + n - half;
            if (idx >= 0 && idx < mono.length) acc += ker[n] * mono[idx];
        }
        out[i] = acc;
    }
    return { data: out, sr: srOrig / factor };
}

// Assign F1–F5 across frames by continuity + band priors, then median-smooth.
function _trackAndSmooth(frames, hopSec) {
    const SLOTS = 5;
    const priors = [500, 1500, 2500, 3500, 4500];
    const tol = [350, 500, 650, 800, 950]; // max Hz from anchor for assignment
    const assignedAll = new Array(frames.length);
    let anchor = priors.slice();
    for (let fi = 0; fi < frames.length; fi++) {
        const cands = frames[fi];
        const assigned = [null, null, null, null, null];
        if (cands && cands.length) {
            const used = new Array(cands.length).fill(false);
            for (let s = 0; s < SLOTS; s++) {
                let best = -1, bd = Infinity;
                for (let j = 0; j < cands.length; j++) {
                    if (used[j]) continue;
                    if (s > 0 && assigned[s - 1] != null && cands[j].freq <= assigned[s - 1] + 30) continue;
                    const d = Math.abs(cands[j].freq - anchor[s]);
                    if (d < bd) { bd = d; best = j; }
                }
                if (best >= 0 && bd <= tol[s]) { assigned[s] = cands[best].freq; used[best] = true; }
            }
        }
        assignedAll[fi] = assigned;
        anchor = assigned.map((v, s) => (v != null ? v : priors[s]));
    }
    const W = 2; // ±2 frames (5-tap) median
    const res = new Array(frames.length);
    for (let fi = 0; fi < frames.length; fi++) {
        const obj = { f1: null, f2: null, f3: null, f4: null, f5: null };
        for (let s = 0; s < SLOTS; s++) {
            const vals = [];
            for (let d = -W; d <= W; d++) {
                const kk = fi + d;
                if (kk >= 0 && kk < frames.length && assignedAll[kk][s] != null) vals.push(assignedAll[kk][s]);
            }
            if (vals.length) { vals.sort((a, b) => a - b); obj['f' + (s + 1)] = vals[Math.floor(vals.length / 2)]; }
        }
        res[fi] = obj;
    }
    return { hop: hopSec, frames: res };
}

function analyzeRecordingFormantsOffline(audioBuffer) {
    const srOrig = audioBuffer.sampleRate;
    const nch = audioBuffer.numberOfChannels;
    const ch0 = audioBuffer.getChannelData(0);
    let mono = ch0;
    if (nch > 1) {
        mono = new Float32Array(ch0.length);
        const ch1 = audioBuffer.getChannelData(1);
        for (let i = 0; i < mono.length; i++) mono[i] = 0.5 * (ch0[i] + ch1[i]);
    }
    const { data: sig, sr } = _offlineDecimate(mono, srOrig, 11025);
    const hopSec = 0.01;
    const hop = Math.max(1, Math.round(hopSec * sr));
    const p = Math.min(16, Math.max(10, Math.round(sr / 1000) + 2)); // ≈13 at 11 kHz
    const minLag = Math.floor(sr / 500), maxLag = Math.floor(sr / 70); // f0 70–500 Hz
    const w40 = Math.floor(0.04 * sr);
    const minWin = Math.floor(0.02 * sr), maxWin = Math.floor(0.05 * sr);
    const frames = [];
    const preAlpha = 0.97;

    for (let center = 0; center < sig.length; center += hop) {
        // f0 via normalized autocorrelation on a 40 ms window
        let s0 = center - (w40 >> 1); if (s0 < 0) s0 = 0;
        let s1 = s0 + w40; if (s1 > sig.length) { s1 = sig.length; s0 = Math.max(0, s1 - w40); }
        let r0 = 0; for (let i = s0; i < s1; i++) r0 += sig[i] * sig[i];
        const rms = Math.sqrt(r0 / Math.max(1, s1 - s0));
        if (rms < 0.005) { frames.push(null); continue; }
        let bestLag = -1, bestVal = 0;
        for (let lag = minLag; lag <= maxLag && lag < (s1 - s0); lag++) {
            let acc = 0;
            for (let i = s0; i + lag < s1; i++) acc += sig[i] * sig[i + lag];
            const norm = acc / (r0 || 1);
            if (norm > bestVal) { bestVal = norm; bestLag = lag; }
        }
        const voiced = bestVal > 0.3 && bestLag > 0;
        const period = voiced ? bestLag : Math.floor(0.025 * sr);
        // pitch-synchronous window ≈ 4 periods (bounded 20–50 ms)
        let winLen = Math.max(minWin, Math.min(maxWin, 4 * period));
        let a0 = center - (winLen >> 1); if (a0 < 0) a0 = 0;
        let a1 = a0 + winLen; if (a1 > sig.length) { a1 = sig.length; a0 = Math.max(0, a1 - winLen); }
        const M = a1 - a0;
        if (M < p + 4) { frames.push(null); continue; }
        const x = new Float64Array(M);
        for (let i = 0; i < M; i++) {
            const xn = sig[a0 + i], xn1 = i > 0 ? sig[a0 + i - 1] : sig[a0 + i];
            const pe = xn - preAlpha * xn1;
            const wnd = 0.5 * (1 - Math.cos(2 * Math.PI * i / (M - 1)));
            x[i] = pe * wnd;
        }
        const k = burgLpc(x, M, p);
        if (!k) { frames.push(null); continue; }
        const a = reflectionsToPredictions(k, p);
        const poly = new Float64Array(p + 1); poly[0] = 1;
        for (let i = 1; i <= p; i++) poly[i] = -a[i];
        const roots = _dkRoots(poly, p);
        if (!roots) { frames.push(null); continue; }
        const cands = [];
        for (let i = 0; i < p; i++) {
            const re = roots[2 * i], im = roots[2 * i + 1];
            if (im <= 0) continue;
            const mag = Math.hypot(re, im);
            if (mag <= 0 || mag >= 1) continue;
            const freq = Math.atan2(im, re) * sr / (2 * Math.PI);
            const bw = -Math.log(mag) * sr / Math.PI;
            if (freq < 90 || freq > 5500 || bw > 700) continue;
            cands.push({ freq, bw });
        }
        cands.sort((u, v) => u.freq - v.freq);
        frames.push(cands.length ? cands : null);
    }
    return _trackAndSmooth(frames, hopSec);
}

// Analyze an already-decoded AudioBuffer in the background; applied once ready
// (live path used until then). Takes a decoded buffer to avoid a second decode.
async function buildPlaybackFormantTrack(audioBuffer) {
    playbackFormantTrack = null;
    if (!audioBuffer) return;
    try {
        const track = analyzeRecordingFormantsOffline(audioBuffer);
        if (playbackAudio) playbackFormantTrack = track; // still playing?
    } catch (err) {
        console.warn('Offline formant analysis failed:', err);
        playbackFormantTrack = null;
    }
}

// Look up the precomputed formant frame at a playback time → estFormants shape.
function lookupFormantTrack(timeSec) {
    const tr = playbackFormantTrack;
    if (!tr || !tr.frames.length) return null;
    let idx = Math.round(timeSec / tr.hop);
    if (idx < 0) idx = 0;
    if (idx >= tr.frames.length) idx = tr.frames.length - 1;
    const f = tr.frames[idx];
    if (!f) return null;
    const mk = (hz) => (hz != null ? { freq: hz, db: 0 } : null);
    return { f1: mk(f.f1), f2: mk(f.f2), f3: mk(f.f3), f4: mk(f.f4), f5: mk(f.f5) };
}

// ---- Minimal radix-2 FFT (in-place) for the playback spectrum window ----
function fftRadix2(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr;
            const ti = im[i]; im[i] = im[j]; im[j] = ti;
        }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -2 * Math.PI / len;
        const wr = Math.cos(ang), wi = Math.sin(ang);
        const half = len >> 1;
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < half; k++) {
                const ar = re[i + k], ai = im[i + k];
                const br = re[i + k + half], bi = im[i + k + half];
                const vr = br * cr - bi * ci, vi = br * ci + bi * cr;
                re[i + k] = ar + vr; im[i + k] = ai + vi;
                re[i + k + half] = ar - vr; im[i + k + half] = ai - vi;
                const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}

// Compute a dB spectrum at playback time `timeSec` from the decoded buffer and
// fill state.cachedMicData, so drawSpectrum renders it without an AnalyserNode.
let _pbSpecRe = null, _pbSpecIm = null, _pbSpecWin = null;
function computePlaybackSpectrum(timeSec) {
    if (!playbackBuffer || !micAnalyser) return;
    const N = micAnalyser.fftSize;              // 4096
    const bins = micAnalyser.frequencyBinCount; // 2048
    const sr = playbackBuffer.sampleRate;
    const ch = playbackBuffer.getChannelData(0);
    const start = Math.round(timeSec * sr) - (N >> 1);
    if (!_pbSpecRe || _pbSpecRe.length !== N) {
        _pbSpecRe = new Float64Array(N);
        _pbSpecIm = new Float64Array(N);
        _pbSpecWin = new Float64Array(N);
        for (let i = 0; i < N; i++) _pbSpecWin[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    }
    let rms = 0;
    for (let i = 0; i < N; i++) {
        const idx = start + i;
        const s = (idx >= 0 && idx < ch.length) ? ch[idx] : 0;
        rms += s * s;
        _pbSpecRe[i] = s * _pbSpecWin[i];
        _pbSpecIm[i] = 0;
    }
    state.cachedMicLevel = Math.sqrt(rms / N); // expose level so Vowel Space admits samples
    fftRadix2(_pbSpecRe, _pbSpecIm);
    if (!state.cachedMicData || state.cachedMicData.length !== bins) {
        state.cachedMicData = new Float32Array(bins);
    }
    const arr = state.cachedMicData;
    const norm = 2 / N;
    const minDb = micAnalyser.minDecibels, maxDb = micAnalyser.maxDecibels;
    const smooth = 0.6; // EMA to mimic AnalyserNode smoothingTimeConstant
    for (let i = 0; i < bins; i++) {
        const mag = Math.hypot(_pbSpecRe[i], _pbSpecIm[i]) * norm;
        let db = 20 * Math.log10(mag + 1e-9);
        if (db < minDb) db = minDb; else if (db > maxDb) db = maxDb;
        arr[i] = (arr[i] && isFinite(arr[i])) ? (arr[i] * smooth + db * (1 - smooth)) : db;
    }
}

function updatePlaybackUi() {
    if (!playbackAudio || playbackAudio.paused) { playbackUiRaf = null; return; }
    const dur = pbDuration();
    const cur = playbackAudio.currentTime || 0;
    // Section loop: wrap back to A when the playhead reaches B (full-track loop
    // with B≈1 is handled by the 'ended' listener instead).
    if (playbackLoop && dur > 0 && playbackLoopB < 0.999
        && cur >= playbackLoopB * dur - 0.02) {
        playbackAudio.currentTime = playbackLoopA * dur;
    }
    if (els.pbSeek && !pbSeeking) {
        els.pbSeek.value = String(dur > 0 ? Math.round((cur / dur) * 1000) : 0);
    }
    if (els.pbCurTime) els.pbCurTime.textContent = cur.toFixed(1) + 's';
    // Offline spectrum at the current recording time (analysis branch; formants come
    // from the precomputed track via drawVisualizer). Speed-independent.
    if (playbackBuffer) computePlaybackSpectrum(cur);
    playbackUiRaf = requestAnimationFrame(updatePlaybackUi);
}

// Reflect playbackLoopA/B onto the region highlight + handle positions
function updateLoopRegionUi() {
    if (els.pbRegion) {
        els.pbRegion.style.left = (playbackLoopA * 100) + '%';
        els.pbRegion.style.width = ((playbackLoopB - playbackLoopA) * 100) + '%';
    }
    if (els.pbHandleA) els.pbHandleA.style.left = (playbackLoopA * 100) + '%';
    if (els.pbHandleB) els.pbHandleB.style.left = (playbackLoopB * 100) + '%';
}

async function playRecording(id) {
    if (playbackAudio) stopPlayback();

    const rec = await RecordingsDB.get(id);   // only await before play() (iOS gesture)
    if (!rec) return;

    // Detach live mic from analysis path during playback
    micWasActiveBeforePlayback = !!(micSource && state.isMicActive);
    if (micWasActiveBeforePlayback && micSource) {
        try { micSource.disconnect(micGainNode); } catch (_) {}
    }

    // <audio> element: pitch-preserving rate, native seeking. NOT routed into Web Audio
    // (iOS won't feed an analyser). Analysis is done offline on the decoded buffer.
    playbackObjectUrl = URL.createObjectURL(rec.blob);
    playbackAudio = new Audio();
    playbackAudio.src = playbackObjectUrl;
    playbackAudio.preservesPitch = true;
    playbackAudio.mozPreservesPitch = true;
    playbackAudio.webkitPreservesPitch = true;
    playbackAudio.playbackRate = playbackRate;
    playbackAudio.loop = false; // section loop handled manually

    playbackDurationSec = (rec.durationMs || 0) / 1000; // WebM element duration can be Infinity
    if (els.pbTotalTime) els.pbTotalTime.textContent = playbackDurationSec.toFixed(1) + 's';

    playbackLoopA = 0;
    playbackLoopB = 1;
    updateLoopRegionUi();
    if (els.playbackControls) els.playbackControls.classList.toggle('is-loop', playbackLoop);

    playbackAudio.addEventListener('loadedmetadata', () => {
        if (isFinite(playbackAudio.duration) && playbackAudio.duration > 0) {
            playbackDurationSec = playbackAudio.duration;
            if (els.pbTotalTime) els.pbTotalTime.textContent = playbackDurationSec.toFixed(1) + 's';
        }
    });
    playbackAudio.addEventListener('ended', () => {
        if (playbackLoop) {
            playbackAudio.currentTime = playbackLoopA * pbDuration();
            playbackAudio.play().catch(() => {});
        } else {
            stopPlayback();
        }
    });

    playbackRecId = id;
    state.isMicActive = true;
    state.isMicPaused = false;
    if (els.btnMic) els.btnMic.classList.add('mic-active');
    if (els.pbRate) els.pbRate.value = String(playbackRate);
    if (els.playbackControls) els.playbackControls.style.display = 'flex';

    // Play ASAP — still in the gesture-initiated task — so iOS allows it.
    try {
        await playbackAudio.play();
    } catch (err) {
        console.error('audio.play() failed:', err);
        stopPlayback();
        return;
    }

    if (playbackUiRaf) cancelAnimationFrame(playbackUiRaf);
    playbackUiRaf = requestAnimationFrame(updatePlaybackUi);
    if (!isPlaying) {
        cancelAnimationFrame(animationId);
        drawVisualizer();
    }
    renderRecordingsList();

    // After play(): set up the analysis pipeline, decode the buffer, build the formant
    // track. Done off the gesture path so play() isn't blocked. Live path is used until ready.
    ensureAnalysisPipeline()
        .then(() => rec.blob.arrayBuffer())
        .then(buf => audioCtx.decodeAudioData(buf.slice(0)))
        .then(audioBuf => {
            if (playbackRecId !== id || !playbackAudio) return; // playback changed
            playbackBuffer = audioBuf;
            if (audioBuf.duration > 0) {
                playbackDurationSec = audioBuf.duration;
                if (els.pbTotalTime) els.pbTotalTime.textContent = playbackDurationSec.toFixed(1) + 's';
            }
            return buildPlaybackFormantTrack(audioBuf);
        })
        .catch(err => console.warn('Playback analysis prep failed:', err));
}

function stopPlayback() {
    if (playbackAudio) {
        try { playbackAudio.pause(); } catch (_) {}
        try { playbackAudio.removeAttribute('src'); playbackAudio.load(); } catch (_) {}
    }
    if (playbackObjectUrl) { URL.revokeObjectURL(playbackObjectUrl); playbackObjectUrl = null; }
    playbackAudio = null;
    playbackBuffer = null;
    playbackFormantTrack = null;
    playbackDurationSec = 0;
    if (playbackUiRaf) { cancelAnimationFrame(playbackUiRaf); playbackUiRaf = null; }
    if (els.playbackControls) els.playbackControls.style.display = 'none';
    cleanupPlayback();
}

function cleanupPlayback() {
    playbackRecId = null;
    if (micWasActiveBeforePlayback && micSource && micGainNode) {
        try { micSource.connect(micGainNode); } catch (_) {}
        micWasActiveBeforePlayback = false;
    } else {
        state.isMicActive = false;
        if (els.btnMic) els.btnMic.classList.remove('mic-active');
        state.cachedMicData = null;
        state.cachedMicFormants = null;
        updateVibratoPanelVisibility();
    }
    renderRecordingsList();
}

// Seek handler — <audio>.currentTime is cheap, so update directly on input.
if (els.pbSeek) {
    els.pbSeek.addEventListener('input', () => {
        const dur = pbDuration();
        if (!playbackAudio || !dur) return;
        const pos = (Number(els.pbSeek.value) / 1000) * dur;
        try { playbackAudio.currentTime = pos; } catch (_) {}
        if (els.pbCurTime) els.pbCurTime.textContent = pos.toFixed(1) + 's';
    });
    // Suppress the playhead auto-update only WHILE dragging (not merely focused).
    const seekStart = () => { pbSeeking = true; };
    const seekEnd = () => { pbSeeking = false; };
    els.pbSeek.addEventListener('pointerdown', seekStart);
    els.pbSeek.addEventListener('pointerup', seekEnd);
    els.pbSeek.addEventListener('pointercancel', seekEnd);
    els.pbSeek.addEventListener('change', seekEnd);   // keyboard / programmatic commit
    els.pbSeek.addEventListener('blur', seekEnd);
}

// Speed handler — <audio>.preservesPitch keeps pitch constant across rate changes.
if (els.pbRate) {
    els.pbRate.addEventListener('change', () => {
        const r = Number(els.pbRate.value);
        playbackRate = r;
        if (playbackAudio) playbackAudio.playbackRate = r;
    });
}

// Section-loop toggle — reveals the A/B handles + region when on
if (els.pbLoop) {
    els.pbLoop.addEventListener('click', () => {
        playbackLoop = !playbackLoop;
        els.pbLoop.classList.toggle('is-active', playbackLoop);
        if (els.playbackControls) els.playbackControls.classList.toggle('is-loop', playbackLoop);
        if (playbackLoop) updateLoopRegionUi();
    });
}

// A/B handle dragging (Pointer Events unify mouse + touch; touch-action:none in CSS).
function bindLoopHandle(handle, which) {
    if (!handle) return;
    const onMove = (clientX) => {
        if (!els.pbSeekWrap) return;
        const rect = els.pbSeekWrap.getBoundingClientRect();
        if (rect.width <= 0) return;
        let ratio = (clientX - rect.left) / rect.width;
        ratio = Math.max(0, Math.min(1, ratio));
        const MIN_GAP = 0.02;
        if (which === 'a') {
            playbackLoopA = Math.max(0, Math.min(ratio, playbackLoopB - MIN_GAP));
        } else {
            playbackLoopB = Math.min(1, Math.max(ratio, playbackLoopA + MIN_GAP));
        }
        updateLoopRegionUi();
    };
    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        const move = (ev) => onMove(ev.clientX);
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}
bindLoopHandle(els.pbHandleA, 'a');
bindLoopHandle(els.pbHandleB, 'b');

// ============================================================
// Export utilities — WAV (built-in) and MP3 (lamejs CDN)
// ============================================================
function _writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

function audioBufferToWav(buffer) {
    const numCh = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const samples = buffer.length;
    const bps = 2;
    const dataSize = samples * numCh * bps;
    const ab = new ArrayBuffer(44 + dataSize);
    const view = new DataView(ab);
    _writeStr(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    _writeStr(view, 8, 'WAVE');
    _writeStr(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true);
    view.setUint32(24, sr, true);
    view.setUint32(28, sr * numCh * bps, true);
    view.setUint16(32, numCh * bps, true);
    view.setUint16(34, 16, true);
    _writeStr(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    let off = 44;
    const channels = [];
    for (let c = 0; c < numCh; c++) channels.push(buffer.getChannelData(c));
    for (let i = 0; i < samples; i++) {
        for (let c = 0; c < numCh; c++) {
            let s = Math.max(-1, Math.min(1, channels[c][i]));
            view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            off += 2;
        }
    }
    return new Blob([ab], { type: 'audio/wav' });
}

function audioBufferToMp3(buffer, kbps = 128) {
    if (typeof lamejs === 'undefined') throw new Error('lamejs not loaded');
    const sr = buffer.sampleRate;
    const numCh = Math.min(2, buffer.numberOfChannels);
    const encoder = new lamejs.Mp3Encoder(numCh, sr, kbps);
    const samples = buffer.length;
    const leftF = buffer.getChannelData(0);
    const rightF = numCh > 1 ? buffer.getChannelData(1) : null;
    const leftI = new Int16Array(samples);
    const rightI = rightF ? new Int16Array(samples) : null;
    for (let i = 0; i < samples; i++) {
        leftI[i] = Math.max(-32768, Math.min(32767, Math.round(leftF[i] * 32768)));
        if (rightI) rightI[i] = Math.max(-32768, Math.min(32767, Math.round(rightF[i] * 32768)));
    }
    const blockSize = 1152;
    const parts = [];
    for (let i = 0; i < samples; i += blockSize) {
        const l = leftI.subarray(i, i + blockSize);
        const r = rightI ? rightI.subarray(i, i + blockSize) : null;
        const enc = r ? encoder.encodeBuffer(l, r) : encoder.encodeBuffer(l);
        if (enc.length > 0) parts.push(enc);
    }
    const flush = encoder.flush();
    if (flush.length > 0) parts.push(flush);
    return new Blob(parts, { type: 'audio/mp3' });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
}

async function exportRecording(id, format) {
    const rec = await RecordingsDB.get(id);
    if (!rec) return;
    // Need an AudioContext to decode (reuse global if available, else temporary)
    let ctx = audioCtx;
    let tempCtx = false;
    if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        tempCtx = true;
    }
    const arrayBuf = await rec.blob.arrayBuffer();
    let buf;
    try {
        buf = await ctx.decodeAudioData(arrayBuf.slice(0));
    } catch (err) {
        alert('音声データのデコードに失敗しました');
        if (tempCtx) ctx.close();
        return;
    }
    const baseName = `sourcefilter-${new Date(rec.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    let outBlob, ext;
    try {
        if (format === 'mp3') {
            outBlob = audioBufferToMp3(buf, 128);
            ext = 'mp3';
        } else {
            outBlob = audioBufferToWav(buf);
            ext = 'wav';
        }
    } catch (err) {
        console.error('Export failed:', err);
        alert(`${format.toUpperCase()} エクスポートに失敗: ${err.message}`);
        if (tempCtx) ctx.close();
        return;
    }
    downloadBlob(outBlob, `${baseName}.${ext}`);
    if (tempCtx) ctx.close();
}

async function deleteRecording(id) {
    if (playbackRecId === id) stopPlayback();
    if (!confirm('この録音を削除しますか？')) return;
    await RecordingsDB.remove(id);
    await refreshRecordingsList();
}

let cachedRecordingsList = [];
async function refreshRecordingsList() {
    cachedRecordingsList = await RecordingsDB.list();
    renderRecordingsList();
}

function renderRecordingsList() {
    if (!els.recordingsList) return;
    const list = cachedRecordingsList;
    els.recordingsList.innerHTML = '';
    if (els.recordingsMeta) els.recordingsMeta.textContent = `${list.length} 件`;
    if (els.recordingsEmpty) els.recordingsEmpty.style.display = list.length === 0 ? 'block' : 'none';

    for (const rec of list) {
        const li = document.createElement('li');
        li.className = 'recordings-item' + (rec.id === playbackRecId ? ' is-playing' : '');

        const timeEl = document.createElement('span');
        timeEl.className = 'rec-time';
        timeEl.textContent = fmtTimestamp(rec.createdAt);

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'rec-label-input';
        labelInput.placeholder = 'label (任意)';
        labelInput.maxLength = 60;
        labelInput.value = rec.label || '';
        const commitLabel = async () => {
            const v = labelInput.value.trim();
            if (v === (rec.label || '')) return;
            try { await RecordingsDB.updateLabel(rec.id, v); rec.label = v; }
            catch (err) { console.error('Failed to update label:', err); }
        };
        labelInput.addEventListener('blur', commitLabel);
        labelInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); labelInput.blur(); }
        });

        const durEl = document.createElement('span');
        durEl.className = 'rec-dur';
        durEl.textContent = fmtDuration(rec.durationMs);

        const playBtn = document.createElement('button');
        playBtn.className = 'rec-btn';
        playBtn.type = 'button';
        // Pause keeps the clip loaded so the next press resumes from the same
        // position; playRecording() always restarts from 0, so resume calls
        // the live element directly instead of re-entering playRecording().
        const isCurrent = rec.id === playbackRecId && playbackAudio;
        const isPlayingThis = isCurrent && !playbackAudio.paused;
        playBtn.textContent = isPlayingThis ? '⏸ Pause' : (isCurrent ? '▶ Resume' : '▶ Play');
        playBtn.addEventListener('click', () => {
            if (rec.id === playbackRecId && playbackAudio) {
                if (playbackAudio.paused) resumePlayback();
                else pausePlayback();
            } else {
                playRecording(rec.id);
            }
        });

        const dlBtn = document.createElement('button');
        dlBtn.className = 'rec-btn';
        dlBtn.type = 'button';
        dlBtn.textContent = '↓';
        dlBtn.title = 'Download (WAV / MP3)';
        dlBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openExportMenu(dlBtn, rec.id);
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'rec-btn danger';
        delBtn.type = 'button';
        delBtn.title = 'Delete';
        delBtn.setAttribute('aria-label', 'Delete recording');
        delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
        delBtn.addEventListener('click', () => deleteRecording(rec.id));

        li.append(timeEl, labelInput, durEl, playBtn, dlBtn, delBtn);
        els.recordingsList.appendChild(li);
    }
}

// Singleton export menu (position: fixed, anchored to the clicked ↓ button)
let _exportMenuEl = null;
function getExportMenu() {
    if (_exportMenuEl) return _exportMenuEl;
    const m = document.createElement('div');
    m.className = 'rec-export-menu';
    const wav = document.createElement('button');
    wav.type = 'button'; wav.textContent = 'WAV'; wav.dataset.fmt = 'wav';
    const mp3 = document.createElement('button');
    mp3.type = 'button'; mp3.textContent = 'MP3'; mp3.dataset.fmt = 'mp3';
    m.append(wav, mp3);
    document.body.appendChild(m);
    _exportMenuEl = m;
    return m;
}
function closeExportMenu() {
    if (_exportMenuEl) _exportMenuEl.classList.remove('is-open');
}
function openExportMenu(anchorBtn, recId) {
    const m = getExportMenu();
    // Re-bind handlers with the current recId
    for (const btn of m.querySelectorAll('button')) {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const fmt = btn.dataset.fmt;
            btn.disabled = true;
            const orig = btn.textContent;
            btn.textContent = '…';
            try { await exportRecording(recId, fmt); }
            finally { btn.disabled = false; btn.textContent = orig; closeExportMenu(); }
        };
    }
    // Position below-right of the anchor, clamped to viewport
    const r = anchorBtn.getBoundingClientRect();
    m.classList.add('is-open');
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    let left = r.right - mw;
    let top = r.bottom + 2;
    if (left < 4) left = 4;
    if (left + mw > window.innerWidth - 4) left = window.innerWidth - mw - 4;
    if (top + mh > window.innerHeight - 4) top = r.top - mh - 2;
    m.style.left = left + 'px';
    m.style.top = top + 'px';
}
document.addEventListener('click', (e) => {
    if (_exportMenuEl && !_exportMenuEl.contains(e.target)) closeExportMenu();
});
window.addEventListener('scroll', closeExportMenu, true);
window.addEventListener('resize', closeExportMenu);

if (els.btnMicRecord) {
    els.btnMicRecord.addEventListener('click', () => {
        if (mediaRecorder && mediaRecorder.state === 'recording') stopRecording();
        else startRecording();
    });
}

// ============================================================
// Import — load an external audio file and save as a recording
// ============================================================
async function importAudioFile(file) {
    if (!file) return;
    // Decode to obtain duration. Use a temporary AudioContext if needed.
    let ctx = audioCtx;
    let tempCtx = false;
    if (!ctx) {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        tempCtx = true;
    }
    let buf;
    try {
        const arr = await file.arrayBuffer();
        buf = await ctx.decodeAudioData(arr.slice(0));
    } catch (err) {
        console.error('Import decode failed:', err);
        alert(`「${file.name}」をデコードできませんでした。対応形式の音声ファイルを選んでください`);
        if (tempCtx) ctx.close();
        return;
    }
    const durationMs = buf.duration * 1000;
    const mimeType = file.type || 'audio/octet-stream';
    try {
        await RecordingsDB.save({
            blob: file,
            durationMs,
            mimeType,
            sampleRate: buf.sampleRate
        });
        // Use filename (without extension) as default label
        const list = await RecordingsDB.list();
        const newest = list[0];
        if (newest) {
            const base = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
            await RecordingsDB.updateLabel(newest.id, base);
        }
        await refreshRecordingsList();
    } catch (err) {
        console.error('Failed to save imported file:', err);
        alert('インポートに失敗しました: ' + err.message);
    }
    if (tempCtx) ctx.close();
}

if (els.btnImport && els.importInput) {
    // stopPropagation so clicking Import inside <summary> doesn't toggle the panel
    els.btnImport.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); els.importInput.click(); });
    els.importInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        for (const f of files) await importAudioFile(f);
        els.importInput.value = '';
        if (els.recordingsPanel) els.recordingsPanel.open = true;
    });
}

// Initial load
if (window.RecordingsDB) {
    refreshRecordingsList().catch(err => console.error('Initial recordings load failed:', err));
}

// App version — shown in the bottom-right corner (bump on each release)
const APP_VERSION = 'v1.11.0';
(() => { const el = document.getElementById('app-version'); if (el) el.textContent = APP_VERSION; })();

// Service Worker — enables offline use and "Add to Home Screen"
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => {
            console.warn('SW registration failed:', err);
        });
    });
}

// Source Controls
// Natural pitch range per voice type (PVA convention)
const VOICE_TYPE_RANGES = {
    treble:    { min: 260, max: 1000, defaultPitch: 440, defaultMech: 'm2' },
    nontreble: { min: 80,  max: 500,  defaultPitch: 220, defaultMech: 'm1' },
};

function updatePitchRangeHint() {
    const pitchRangeEl = document.getElementById('pitch-range');
    if (!pitchRangeEl) return;
    const r = VOICE_TYPE_RANGES[state.voiceType];
    pitchRangeEl.textContent = `${freqToNote(r.min)} – ${freqToNote(r.max)}`;
}

// Called when user explicitly clicks Voice Type toggle — resets to preset
function applyVoiceType(value) {
    state.voiceType = value;
    isPresetLoading = true;

    const r = VOICE_TYPE_RANGES[value];
    state.pitch = r.defaultPitch;
    els.pitchSlider.value = r.defaultPitch;

    state.formants.f1.freq = 500;
    els.f1Slider.value = 500;

    if (r.defaultMech === 'm2') {
        els.mechM2.checked = true; state.mechanism = 'm2';
    } else {
        els.mechM1.checked = true; state.mechanism = 'm1';
    }
    state.phonationMode = 'flow';
    els.resistanceSlider.value = 1.0; state.resistance = 1.0;
    els.pressureSlider.value = 1.0; state.pressure = 1.0;

    els.pitchVal.textContent = state.pitch;
    els.pitchNote.textContent = noteWithCents(state.pitch);
    els.f1Val.textContent = state.formants.f1.freq;
    els.resistanceVal.textContent = state.resistance.toFixed(1);
    els.pressureVal.textContent = state.pressure.toFixed(1);
    updatePitchRangeHint();
    reorderFormantBounds();

    updateSourceParams();
    updateFilterParams();

    isPresetLoading = false;
    analyzeAcoustics();
}

// Auto-sync Voice Type radio when pitch slider crosses into exclusive zone.
// Does NOT trigger applyVoiceType (no preset reset) — only updates the indicator.
function autoSyncVoiceTypeFromPitch(pitch) {
    let newType = state.voiceType;
    if (pitch >= 500) newType = 'treble';
    else if (pitch < 260) newType = 'nontreble';
    // overlap zone (260 <= pitch < 500): keep current

    if (newType === state.voiceType) return;
    state.voiceType = newType;
    document.querySelectorAll('input[name="voice-type"]').forEach(r => {
        r.checked = (r.value === newType);
    });
    if (els.voiceTypeSelect && els.voiceTypeSelect.tagName === 'SELECT') {
        els.voiceTypeSelect.value = newType;
    }
    updatePitchRangeHint();
}

// PC: radio group; Mobile: <select>. Both routed through applyVoiceType.
document.querySelectorAll('input[name="voice-type"]').forEach(r => {
    r.addEventListener('change', (e) => { if (e.target.checked) applyVoiceType(e.target.value); });
});
if (els.voiceTypeSelect && els.voiceTypeSelect.tagName === 'SELECT') {
    els.voiceTypeSelect.addEventListener('change', (e) => applyVoiceType(e.target.value));
}

function applyPitchChange(newPitch) {
    state.pitch = newPitch;
    els.pitchVal.textContent = state.pitch;
    els.pitchNote.textContent = noteWithCents(state.pitch);
    autoSyncVoiceTypeFromPitch(state.pitch);
    updateSourceParams();
    analyzeAcoustics();
    updateRoughnessReadout();
    // Keep both sliders in sync without firing each other's input events
    if (els.pitchSlider.value !== String(state.pitch)) els.pitchSlider.value = state.pitch;
    if (els.pitchMirror && els.pitchMirror.value !== String(state.pitch)) els.pitchMirror.value = state.pitch;
}

els.pitchSlider.addEventListener('input', (e) => {
    applyPitchChange(parseFloat(e.target.value));
});

if (els.pitchMirror) {
    els.pitchMirror.addEventListener('input', (e) => {
        applyPitchChange(parseFloat(e.target.value));
    });
}

els.pressureSlider.addEventListener('input', (e) => {
    state.pressure = parseFloat(e.target.value);
    els.pressureVal.textContent = state.pressure.toFixed(1);
    state.rdManual = null; // Reset Rd override when P/R changes
    if (els.rdSlider) els.rdSlider.value = computeLFParams().Rd;
    calcAerodynamics();
});

els.resistanceSlider.addEventListener('input', (e) => {
    state.resistance = parseFloat(e.target.value);
    els.resistanceVal.textContent = state.resistance.toFixed(1);
    state.rdManual = null; // Reset Rd override when P/R changes
    if (els.rdSlider) els.rdSlider.value = computeLFParams().Rd;
    calcAerodynamics();
});

// Rd slider — manual override for LF model shape parameter
if (els.rdSlider) {
    els.rdSlider.addEventListener('input', (e) => {
        state.rdManual = parseFloat(e.target.value);
        drawGlottalWaveform();
    });
    // Initialize slider with current auto Rd value
    els.rdSlider.value = computeLFParams().Rd;
}

els.masterVolume.addEventListener('input', (e) => {
    state.masterVolume = parseFloat(e.target.value);
    els.volumeVal.textContent = Math.round(state.masterVolume * 100) + '%';
    calcAerodynamics();
});

els.micGainSlider.addEventListener('input', (e) => {
    state.micGain = parseFloat(e.target.value);
    els.micGainVal.textContent = state.micGain.toFixed(1) + 'x';
    if (micGainNode) {
        micGainNode.gain.setTargetAtTime(state.micGain, audioCtx.currentTime, 0.05);
    }
});

if (els.loudCeilSlider) {
    els.loudCeilSlider.addEventListener('input', (e) => {
        state.loudnessCeilingDb = parseFloat(e.target.value);
        if (els.loudCeilVal) els.loudCeilVal.textContent = state.loudnessCeilingDb + ' dB';
        if (els.loudMarker) els.loudMarker.style.left = loudDbToPct(state.loudnessCeilingDb) + '%';
        saveLoudnessCeiling(state.loudnessCeilingDb);
    });
}

els.spectrumSlopeSlider.addEventListener('input', (e) => {
    state.spectrumSlope = parseFloat(e.target.value);
    if (els.slopeVal) els.slopeVal.textContent = state.spectrumSlope + 'dB';
    updateSpectralTilt();
});

// Vibrato controls
function applyVibratoLive() {
    if (!audioCtx) return;
    if (vibratoLFO) {
        vibratoLFO.frequency.setTargetAtTime(state.vibrato.rate, audioCtx.currentTime, 0.02);
    }
    if (vibratoFMGain) {
        const fmTarget = state.vibrato.enabled ? state.vibrato.extent : 0;
        vibratoFMGain.gain.setTargetAtTime(fmTarget, audioCtx.currentTime, 0.05);
    }
    if (vibratoAMGain) {
        const amTarget = state.vibrato.enabled ? (state.vibrato.amDepth / 100) : 0;
        vibratoAMGain.gain.setTargetAtTime(amTarget, audioCtx.currentTime, 0.05);
    }
}

if (els.vibratoEnable) {
    els.vibratoEnable.addEventListener('change', (e) => {
        state.vibrato.enabled = e.target.checked;
        const pill = e.target.parentElement.querySelector('.vibrato-enable-text');
        if (pill) pill.textContent = state.vibrato.enabled ? 'ON' : 'OFF';
        e.target.parentElement.classList.toggle('on', state.vibrato.enabled);
        if (isPlaying) startVibratoOnset();
        else applyVibratoLive();
    });
    els.vibratoEnable.parentElement.addEventListener('click', (e) => {
        // Prevent collapsible summary toggle when clicking enable toggle
        e.stopPropagation();
    });
}
if (els.vibratoRate) {
    els.vibratoRate.addEventListener('input', (e) => {
        state.vibrato.rate = parseFloat(e.target.value);
        els.vibratoRateVal.textContent = state.vibrato.rate.toFixed(1);
        applyVibratoLive();
        updateSynthVibratoDisplay();
    });
}
if (els.vibratoExtent) {
    els.vibratoExtent.addEventListener('input', (e) => {
        state.vibrato.extent = parseFloat(e.target.value);
        els.vibratoExtentVal.textContent = state.vibrato.extent;
        applyVibratoLive();
        updateSynthVibratoDisplay();
    });
}
if (els.vibratoDelay) {
    els.vibratoDelay.addEventListener('input', (e) => {
        state.vibrato.onsetDelay = parseFloat(e.target.value);
        els.vibratoDelayVal.textContent = state.vibrato.onsetDelay;
        updateSynthVibratoDisplay();
    });
}
if (els.vibratoRamp) {
    els.vibratoRamp.addEventListener('input', (e) => {
        state.vibrato.onsetRamp = parseFloat(e.target.value);
        els.vibratoRampVal.textContent = state.vibrato.onsetRamp;
        updateSynthVibratoDisplay();
    });
}
if (els.vibratoAm) {
    els.vibratoAm.addEventListener('input', (e) => {
        state.vibrato.amDepth = parseFloat(e.target.value);
        els.vibratoAmVal.textContent = state.vibrato.amDepth;
        applyVibratoLive();
        updateSynthVibratoDisplay();
    });
}
if (els.vibratoWave) {
    els.vibratoWave.addEventListener('change', (e) => {
        state.vibrato.waveform = e.target.value;
        if (vibratoLFO) vibratoLFO.type = state.vibrato.waveform;
        updateSynthVibratoDisplay();
    });
}

// Vibrato analysis Basic/Advanced mode
if (els.vibModeTabs) {
    els.vibModeTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.vib-mode-tab');
        if (!btn) return;
        applyVibAnalysisMode(btn.dataset.mode);
    });
    applyVibAnalysisMode('basic');
}
// Initial synth values
updateSynthVibratoDisplay();

// Vowel Space: language + mode tabs, repaint on open
if (els.vsLangTabs) {
    els.vsLangTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.vs-lang-tab');
        if (!btn) return;
        applyVowelSpaceLanguage(btn.dataset.lang);
    });
}
if (els.vsModeTabs) {
    els.vsModeTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.vib-mode-tab');
        if (!btn) return;
        applyVowelSpaceMode(btn.dataset.mode);
    });
}
if (els.vsVoiceTabs) {
    els.vsVoiceTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.vs-lang-tab');
        if (!btn || btn.disabled) return;
        applyVowelSpaceVoice(btn.dataset.voice);
    });
}
if (els.vsCalibrateBtn) {
    els.vsCalibrateBtn.addEventListener('click', () => {
        if (state.vowelSpace.calibration.active) {
            cancelCalibration();
        } else {
            if (!state.isMicActive) {
                alert('マイクを ON にしてからキャリブレーションを開始してください');
                return;
            }
            // Auto-open panel
            if (els.vowelSpacePanel && !els.vowelSpacePanel.open) {
                els.vowelSpacePanel.open = true;
            }
            startCalibration();
        }
    });
}
// Mic device picker
if (els.micDeviceSelect) {
    els.micDeviceSelect.addEventListener('change', (e) => {
        setMicDevice(e.target.value || null);
    });
}
// Refresh device list when the OS announces a change (USB mic plugged etc.)
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => refreshMicDevices());
}
// Initial enumerate — labels will be blank pre-permission, but we surface the picker afterwards anyway
refreshMicDevices();

// Load saved per-user calibration from localStorage
state.vowelSpace.calibration.saved = loadCalibrationFromStorage();

// Load saved loudness ceiling and sync the slider/marker
{
    const savedCeil = loadLoudnessCeiling();
    if (savedCeil != null) state.loudnessCeilingDb = savedCeil;
    if (els.loudCeilSlider) els.loudCeilSlider.value = state.loudnessCeilingDb;
    if (els.loudCeilVal) els.loudCeilVal.textContent = state.loudnessCeilingDb + ' dB';
    if (els.loudMarker) els.loudMarker.style.left = loudDbToPct(state.loudnessCeilingDb) + '%';
}
applyVowelSpaceMode('basic');
applyVowelSpaceLanguage('jp');
applyVowelSpaceVoice('male');
updateVoiceTypeTabs();
if (els.vowelSpacePanel) {
    els.vowelSpacePanel.addEventListener('toggle', () => {
        if (els.vowelSpacePanel.open) drawVowelSpace();
    });
    setTimeout(() => { if (els.vowelSpacePanel.open) drawVowelSpace(); }, 0);
}

// Slope Line Toggle
els.btnSlopeLine.addEventListener('click', () => {
    state.showSlopeLine = !state.showSlopeLine;
    els.btnSlopeLine.classList.toggle('slope-line-active', state.showSlopeLine);
});

// Roughness overlay toggle: show/hide educational legend + populate zone ranges
function formatHarmonicRange(fromN, toN) {
    if (toN < fromN) return '(該当なし)';
    if (fromN === toN) return `H${fromN}`;
    return `H${fromN}〜H${toN}`;
}

function updateRoughnessReadout() {
    const visible = state.roughnessVisible;
    if (els.roughnessLegend) {
        els.roughnessLegend.style.display = visible ? '' : 'none';
    }
    if (!visible || !els.roughnessLegend) return;

    const f0 = state.pitch;
    const nERB = computeResolvedLimit(f0);
    const ceilN = Math.floor(PITCH_CEILING_HZ / f0) + 1;

    // Header: current f₀ + sync mirror slider
    const f0El = els.roughnessLegend.querySelector('#rl-f0');
    if (f0El) f0El.textContent = `${Math.round(f0)} Hz ${noteWithCents(f0)}`;
    if (els.pitchMirror && els.pitchMirror.value !== String(Math.round(f0))) {
        els.pitchMirror.value = Math.round(f0);
    }

    const pureEnd = isFinite(nERB) ? nERB - 1 : ceilN - 1;
    const roughResStart = isFinite(nERB) ? nERB : Infinity;
    const roughResEnd = Math.min(PITCH_INTEGRATION_LIMIT_N - 1, ceilN - 1);
    const roughUnrStart = Math.max(isFinite(nERB) ? nERB : Infinity, PITCH_INTEGRATION_LIMIT_N);
    const roughUnrEnd = ceilN - 1;

    const setRange = (zone, text) => {
        const el = els.roughnessLegend.querySelector(`.rl-range[data-zone="${zone}"]`);
        if (el) el.textContent = text;
    };
    setRange('pure', formatHarmonicRange(1, pureEnd));

    const roughResEmpty = !isFinite(roughResStart) || roughResStart > roughResEnd;
    setRange('rough-res', roughResEmpty ? '(該当なし)' : formatHarmonicRange(roughResStart, roughResEnd));

    const emptyNote = els.roughnessLegend.querySelector('.rl-empty-note[data-zone="rough-res"]');
    if (emptyNote) {
        if (roughResEmpty) {
            emptyNote.innerHTML = `現在の f₀ (${Math.round(f0)} Hz) では ERB 幅 ≥ f₀ となるのが H${PITCH_INTEGRATION_LIMIT_N} 以降のため該当なし。<br>f₀ を <strong>≈ 120 Hz 以下</strong>（例: 80 Hz バス域）に下げると、H6–H8 がここに現れます。Bozeman 教科書の「H5–H8 = Rough &amp; Resolved」は低音前提の近似。`;
            emptyNote.style.display = '';
        } else {
            emptyNote.style.display = 'none';
        }
    }

    setRange('rough-unr', isFinite(roughUnrStart) ? formatHarmonicRange(roughUnrStart, roughUnrEnd) : '(該当なし)');
    setRange('ceiling', `H${ceilN}↑ (= ⌈5000/${Math.round(f0)}⌉)`);
}

if (els.btnRoughness) {
    els.btnRoughness.addEventListener('click', () => {
        state.roughnessVisible = !state.roughnessVisible;
        els.btnRoughness.classList.toggle('roughness-active', state.roughnessVisible);
        updateRoughnessReadout();
    });
}

// View tabs: Spectrum / Spectrogram
if (els.viewTabs) {
    els.viewTabs.addEventListener('click', (e) => {
        const btn = e.target.closest('.view-tab');
        if (!btn) return;
        applyViewMode(btn.dataset.view);
    });
    applyViewMode(state.viewMode);
}

// Repaint vibrato canvas when the <details> panel is expanded
// (collapsed state has 0 layout, so the canvas needs a re-fit on open)
if (els.vibratoPanel) {
    els.vibratoPanel.addEventListener('toggle', () => {
        if (els.vibratoPanel.open) drawVibratoTrace();
    });
    // Initial paint to show the empty-state hint without needing mic
    setTimeout(() => { if (els.vibratoPanel.open) drawVibratoTrace(); }, 0);
}

// Log/Linear Frequency Scale Toggle
if (els.btnLogScale) {
    els.btnLogScale.addEventListener('click', () => {
        state.logScale = !state.logScale;
        els.btnLogScale.classList.toggle('log-active', state.logScale);
        els.btnLogScale.textContent = state.logScale ? 'Lin' : 'Log';

        // Hide static HTML x-axis labels when in log mode (canvas draws its own)
        const xAxis = document.querySelector('.x-axis');
        if (xAxis) {
            xAxis.style.display = state.logScale ? 'none' : '';
        }
    });
}

// Fullscreen Toggle for Power Spectrum panel
if (els.btnFullscreen) {
    const visualizerPanel = els.btnFullscreen.closest('.visualizer-panel');
    if (visualizerPanel) {
        els.btnFullscreen.addEventListener('click', () => {
            visualizerPanel.classList.toggle('is-fullscreen');
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && visualizerPanel.classList.contains('is-fullscreen')) {
                visualizerPanel.classList.remove('is-fullscreen');
            }
        });
    }
}

// Mic Formant Method Toggle
if (els.micMethodSelect) {
    els.micMethodSelect.addEventListener('change', (e) => {
        state.micFormantMethod = e.target.value;
    });
}

function updateSpectralTilt() {
    if (spectralTiltNode) {
        // Tie the shelf anchor to just above the fundamental to only tilt the harmonics
        const anchorFreq = state.pitch * 1.5;
        spectralTiltNode.frequency.setTargetAtTime(anchorFreq, audioCtx.currentTime, 0.1);
        spectralTiltNode.gain.setTargetAtTime(state.spectrumSlope, audioCtx.currentTime, 0.1);

        if (visSpectralTiltNode) {
            visSpectralTiltNode.frequency.setTargetAtTime(anchorFreq, audioCtx.currentTime, 0.1);
            visSpectralTiltNode.gain.setTargetAtTime(state.spectrumSlope, audioCtx.currentTime, 0.1);
        }
    }
}

const handleMechChange = (e) => {
    state.mechanism = e.target.value;
    updateSourceParams();
    drawGlottalWaveform();
};
els.mechM1.addEventListener('change', handleMechChange);
els.mechM2.addEventListener('change', handleMechChange);

// Filter Controls
const FORMANT_GAP_HZ = 10; // Minimum spacing between adjacent formants

function reorderFormantBounds() {
    for (let i = 1; i <= 5; i++) {
        const slider = els[`f${i}Slider`];
        if (!slider) continue;
        if (!slider.dataset.origMin) {
            slider.dataset.origMin = slider.min;
            slider.dataset.origMax = slider.max;
        }
        const origMin = parseFloat(slider.dataset.origMin);
        const origMax = parseFloat(slider.dataset.origMax);
        const prevFreq = i > 1 ? state.formants[`f${i - 1}`].freq + FORMANT_GAP_HZ : -Infinity;
        const nextFreq = i < 5 ? state.formants[`f${i + 1}`].freq - FORMANT_GAP_HZ : Infinity;
        slider.min = Math.max(origMin, prevFreq);
        slider.max = Math.min(origMax, nextFreq);
    }
}

const bindFormantParams = (num) => {
    els[`f${num}Slider`].addEventListener('input', (e) => {
        let val = parseFloat(e.target.value);
        const prev = num > 1 ? state.formants[`f${num - 1}`].freq + FORMANT_GAP_HZ : -Infinity;
        const next = num < 5 ? state.formants[`f${num + 1}`].freq - FORMANT_GAP_HZ : Infinity;
        val = Math.max(prev, Math.min(next, val));
        if (parseFloat(e.target.value) !== val) e.target.value = val;
        state.formants[`f${num}`].freq = val;
        els[`f${num}Val`].textContent = val;
        reorderFormantBounds();
        updateFilterParams();
        analyzeAcoustics();
    });

    const qValEl = document.getElementById(`f${num}-q-val`);
    els[`f${num}Q`].addEventListener('input', (e) => {
        const q = parseFloat(e.target.value);
        state.formants[`f${num}`].q = q;
        if (qValEl) qValEl.textContent = q.toFixed(1);
        updateFilterParams();
    });

    els[`f${num}Toggle`].addEventListener('click', (e) => {
        state.formants[`f${num}`].enabled = !state.formants[`f${num}`].enabled;

        if (state.formants[`f${num}`].enabled) {
            e.target.classList.add('active');
            e.target.textContent = 'ON';
        } else {
            e.target.classList.remove('active');
            e.target.textContent = 'OFF';
        }

        updateFilterParams();
    });
};

bindFormantParams(1);
bindFormantParams(2);
bindFormantParams(3);
bindFormantParams(4);
bindFormantParams(5);

// Presets
const presetsData = {
    'a': { f1: 750, f2: 1200, f3: 2600, f4: 3800, f5: 4800 },
    'i': { f1: 300, f2: 2400, f3: 3000, f4: 3800, f5: 4800 },
    'u': { f1: 350, f2: 800, f3: 2500, f4: 3800, f5: 4800 },
    'e': { f1: 500, f2: 1800, f3: 2500, f4: 3800, f5: 4800 },
    'o': { f1: 500, f2: 900, f3: 2500, f4: 3800, f5: 4800 },
    'open': { f1: 500, f2: 1500, f3: 2800, f4: 3800, f5: 4800, pitch: 200 },
    'close': { f1: 500, f2: 1500, f3: 2800, f4: 3800, f5: 4800, pitch: 300 }
};

els.presets.forEach(btn => {
    btn.addEventListener('click', (e) => {
        const p = presetsData[e.target.dataset.preset];
        if (p) {
            isPresetLoading = true;
            // Update state
            state.formants.f1.freq = p.f1;
            state.formants.f2.freq = p.f2;
            state.formants.f3.freq = p.f3;
            state.formants.f4.freq = p.f4;
            state.formants.f5.freq = p.f5;

            // Update UI
            reorderFormantBounds(); // Widen all slider bounds first so the new preset values fit
            els.f1Slider.value = p.f1; els.f1Val.textContent = p.f1;
            els.f2Slider.value = p.f2; els.f2Val.textContent = p.f2;
            els.f3Slider.value = p.f3; els.f3Val.textContent = p.f3;
            els.f4Slider.value = p.f4; els.f4Val.textContent = p.f4;
            els.f5Slider.value = p.f5; els.f5Val.textContent = p.f5;
            reorderFormantBounds(); // Re-tighten bounds based on the new values

            if (p.pitch) {
                state.pitch = p.pitch;
                els.pitchSlider.value = p.pitch;
                els.pitchVal.textContent = p.pitch;
                els.pitchNote.textContent = noteWithCents(p.pitch);
                updateSourceParams();
            }

            updateFilterParams();
            isPresetLoading = false;
        }
    });
});

// Initial Setup
window.addEventListener('resize', () => {
    if (isPlaying) resizeCanvas();
});

// Interactive Spectrum
let isDraggingFormant = false;
let activeFormantKey = null;
let isDraggingSelection = false;
let selectionStartFreq = 0;

function getNearestFormant(freq, y = 0, height = 1000) {
    // If clicking in the bottom 50% of the canvas, don't grab formants.
    if (y > height * 0.5) return null;

    let nearestKey = null;
    let minDiff = Infinity;
    for (let i = 1; i <= 5; i++) {
        const key = `f${i}`;
        if (!state.formants[key].enabled) continue;
        const diff = Math.abs(state.formants[key].freq - freq);
        // Generous grab radius around the peak
        if (diff < minDiff && diff < 300) {
            minDiff = diff;
            nearestKey = key;
        }
    }
    return nearestKey;
}

function handleCanvasInteraction(e) {
    if (!isPlaying) return;

    const rect = els.canvas.getBoundingClientRect();

    // Support both mouse and touch
    let clientX = e.clientX;
    let clientY = e.clientY;
    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else if (e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
    }

    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const width = els.canvas.width || rect.width;
    const height = els.canvas.height || rect.height;

    // Map X to Frequency (log-aware)
    let freq = xToFreq(x, width);
    freq = Math.max(50, Math.min(MAX_FREQ_DISPLAY, freq));

    if (e.type === 'mousedown' || e.type === 'touchstart') {
        activeFormantKey = getNearestFormant(freq, y, height);
        if (activeFormantKey) {
            isDraggingFormant = true;
            els.canvas.classList.add('grabbing');
        } else {
            // Start selection area
            isDraggingSelection = true;
            selectionStartFreq = freq;
            state.selectionMinFreq = freq;
            state.selectionMaxFreq = freq;
            state.selectionActive = true;
            updateSourceParams(); // Ensure audio respects immediately
        }
    }

    if (e.type === 'mousemove' || e.type === 'touchmove') {
        if (isDraggingFormant && activeFormantKey) {
            if (e.type === 'touchmove' && e.cancelable) e.preventDefault(); // Prevent scrolling on mobile
            freq = Math.round(freq);

            // Clamp to ordering constraint (cannot cross adjacent formants)
            const idx = parseInt(activeFormantKey.slice(1), 10); // 'f1' → 1
            const prev = idx > 1 ? state.formants[`f${idx - 1}`].freq + FORMANT_GAP_HZ : -Infinity;
            const next = idx < 5 ? state.formants[`f${idx + 1}`].freq - FORMANT_GAP_HZ : Infinity;
            // Also respect the slider's original absolute range
            const slider = els[`${activeFormantKey}Slider`];
            const origMin = parseFloat(slider.dataset.origMin || slider.min);
            const origMax = parseFloat(slider.dataset.origMax || slider.max);
            freq = Math.max(origMin, prev, Math.min(origMax, next, freq));

            state.formants[activeFormantKey].freq = freq;
            slider.value = freq;
            els[`${activeFormantKey}Val`].textContent = freq;
            reorderFormantBounds();
            updateFilterParams();
        } else if (isDraggingSelection) {
            if (e.type === 'touchmove' && e.cancelable) e.preventDefault(); // Prevent scrolling on mobile
            state.selectionMinFreq = Math.min(selectionStartFreq, freq);
            state.selectionMaxFreq = Math.max(selectionStartFreq, freq);
            updateSourceParams();
        }
    }

    if (e.type === 'mouseup' || e.type === 'mouseleave' || e.type === 'touchend' || e.type === 'touchcancel') {
        if (isDraggingFormant) {
            isDraggingFormant = false;
            activeFormantKey = null;
            els.canvas.classList.remove('grabbing');
        } else if (isDraggingSelection) {
            isDraggingSelection = false;

            // If dragging distance is very small, treat as a click to reset/clear selection
            const freqDiff = Math.abs(state.selectionMaxFreq - state.selectionMinFreq);
            if (freqDiff < (MAX_FREQ_DISPLAY * 0.02)) {
                state.selectionActive = false;
                state.selectionMinFreq = 0;
                state.selectionMaxFreq = 0;
            } else {
                state.selectionMinFreq = Math.round(state.selectionMinFreq);
                state.selectionMaxFreq = Math.round(state.selectionMaxFreq);
            }
            updateSourceParams();
        }
    }
}

els.canvas.addEventListener('mousedown', handleCanvasInteraction);
els.canvas.addEventListener('mousemove', handleCanvasInteraction, { passive: false });
els.canvas.addEventListener('mouseup', handleCanvasInteraction);
els.canvas.addEventListener('mouseleave', handleCanvasInteraction);
els.canvas.addEventListener('touchstart', handleCanvasInteraction, { passive: false });
els.canvas.addEventListener('touchmove', handleCanvasInteraction, { passive: false });
els.canvas.addEventListener('touchend', handleCanvasInteraction);
els.canvas.addEventListener('touchcancel', handleCanvasInteraction);

// Init notes & analysis
els.pitchNote.textContent = noteWithCents(state.pitch);
updatePitchRangeHint();
reorderFormantBounds();
analyzeAcoustics();
drawGlottalWaveform(); // Initial render

// Guide panel toggle
const guideToggle = document.getElementById('lf-guide-toggle');
const guidePanel = document.getElementById('lf-guide-panel');
if (guideToggle && guidePanel) {
    guideToggle.addEventListener('click', () => {
        const isVisible = guidePanel.style.display === 'block';
        guidePanel.style.display = isVisible ? 'none' : 'block';
        guideToggle.classList.toggle('active', !isVisible);
    });
}

// =============================================
// Vocal Tract Coach Integration
// =============================================
{
    let currentTargetKey = 'none';
    let tractAnimId = null;
    let lastTractTime = 0;

    // Initialize vocal tract model
    if (typeof VocalTract !== 'undefined' && els.tractCanvas) {
        VocalTract.init();
        VocalTractUI.init();

        // Initial formant → tract mapping
        FormantToTractMapper.update(
            state.formants.f1.freq,
            state.formants.f2.freq,
            state.formants.f3.freq,
            state.formants.f4.freq,
            state.formants.f5.freq,
            0
        );

        // Populate target selector from VocalTractData
        if (typeof VocalTractData !== 'undefined' && els.targetTimbre) {
            const yellGroup = els.targetTimbre.querySelector('optgroup[label="Yell Targets"]');
            const whoopGroup = els.targetTimbre.querySelector('optgroup[label="Whoop Targets"]');
            const vowelGroup = els.targetTimbre.querySelector('optgroup[label="Vowel Targets"]');

            for (const [key, preset] of Object.entries(VocalTractData.targetPresets)) {
                const opt = document.createElement('option');
                opt.value = key;
                opt.textContent = preset.label ? preset.label.ja : key;
                if (preset.category === 'yell' && yellGroup) yellGroup.appendChild(opt);
                else if (preset.category === 'whoop' && whoopGroup) whoopGroup.appendChild(opt);
                else if (vowelGroup) vowelGroup.appendChild(opt);
            }
        }

        // Target selector change handler
        if (els.targetTimbre) {
            els.targetTimbre.addEventListener('change', (e) => {
                currentTargetKey = e.target.value;

                if (currentTargetKey === 'none') {
                    VocalTractUI.clearGhost();
                    if (els.matchScore) {
                        els.matchScore.textContent = '\u2014';
                        els.matchScore.className = 'match-value';
                        const fill = document.getElementById('match-progress-fill');
                        if (fill) {
                            fill.style.width = '0%';
                            fill.className = 'match-progress-fill';
                        }
                        const container = document.getElementById('match-score-container');
                        if (container) container.classList.remove('perfect-match');
                    }
                    if (els.coachingHints) {
                        els.coachingHints.innerHTML = '<div class="hint-placeholder">Select a Target to see coaching hints</div>';
                    }
                } else {
                    VocalTractUI.setGhostFromPreset(currentTargetKey);
                    updateCoachingDisplay();
                }
            });
        }

        // Tract canvas animation loop
        function drawTractLoop(timestamp) {
            if (!els.tractCanvas) return;

            const dt = lastTractTime ? (timestamp - lastTractTime) / 1000 : 0.016;
            lastTractTime = timestamp;

            // Smooth transition of diameters
            VocalTract.update(Math.min(dt, 0.05));

            // Resize canvas to container
            const container = els.tractCanvas.parentElement;
            if (container) {
                const rect = container.getBoundingClientRect();
                if (els.tractCanvas.width !== Math.floor(rect.width) || els.tractCanvas.height !== Math.floor(rect.height)) {
                    els.tractCanvas.width = Math.floor(rect.width);
                    els.tractCanvas.height = Math.floor(rect.height);
                }
            }

            const ctx = els.tractCanvas.getContext('2d');
            VocalTractUI.draw(ctx, els.tractCanvas.width, els.tractCanvas.height);

            tractAnimId = requestAnimationFrame(drawTractLoop);
        }

        tractAnimId = requestAnimationFrame(drawTractLoop);
    }

    // Coaching display update
    function updateCoachingDisplay() {
        if (currentTargetKey === 'none' || typeof CoachingEngine === 'undefined') return;

        const currentState = {
            f1: state.formants.f1.freq,
            f2: state.formants.f2.freq,
            f3: state.formants.f3.freq,
            f4: state.formants.f4.freq,
            f5: state.formants.f5.freq,
            pitch: state.pitch,
            mechanism: state.mechanism,
            pressure: state.pressure,
            resistance: state.resistance,
        };

        // Match score
        const score = CoachingEngine.getMatchScore(currentState, currentTargetKey);
        if (els.matchScore) {
            els.matchScore.textContent = score + '%';

            let statusClass = 'poor';
            if (score >= 90) statusClass = 'perfect';
            else if (score >= 80) statusClass = 'good';
            else if (score >= 50) statusClass = 'ok';

            els.matchScore.className = 'match-value ' + statusClass;

            const fill = document.getElementById('match-progress-fill');
            if (fill) {
                fill.style.width = score + '%';
                fill.className = 'match-progress-fill ' + statusClass;
            }
            const container = document.getElementById('match-score-container');
            if (container) {
                if (score >= 90) container.classList.add('perfect-match');
                else container.classList.remove('perfect-match');
            }
        }

        // Coaching hints
        const hints = CoachingEngine.evaluate(currentState, currentTargetKey);
        const preset = VocalTractData.targetPresets[currentTargetKey];
        if (els.coachingHints) {
            let html = '';

            // Target description
            const desc = preset && preset.description ? preset.description.ja : '';
            if (desc) html += '<div class="target-description">' + desc + '</div>';

            // Target Harmonic Structure
            if (preset && preset.source && preset.source.pitch && preset.formants) {
                html += '<div class="target-harmonics-display">';
                html += '<div class="th-title">Target Harmonics (f0=' + preset.source.pitch + 'Hz)</div>';
                html += '<div class="target-harmonics-list">';
                const tF0 = preset.source.pitch;
                const maxH = Math.min(10, Math.floor(5000 / tF0));
                const fKeys = ['f1', 'f2', 'f3', 'f4', 'f5'];
                const fLabels = ['fR1', 'fR2', 'fR3', 'fR4', 'fR5'];
                for (let h = 1; h <= maxH; h++) {
                    const hFreq = tF0 * h;
                    let boostLabel = '';
                    for (let fi = 0; fi < fKeys.length; fi++) {
                        const fVal = preset.formants[fKeys[fi]];
                        if (fVal && Math.abs(hFreq - fVal) < tF0 * 0.4) {
                            boostLabel = fLabels[fi];
                            break;
                        }
                    }
                    const cls = boostLabel ? 'target-harmonic-chip boosted' : 'target-harmonic-chip';
                    const label = h + 'fo=' + hFreq + 'Hz' + (boostLabel ? ' →' + boostLabel : '');
                    html += '<span class="' + cls + '">' + label + '</span>';
                }
                html += '</div></div>';
            }

            // Hints or match OK
            if (hints.length === 0) {
                html += '<div class="hint-match-ok">✅ 良好なマッチです！</div>';
            } else {
                const maxHints = 4;
                for (let i = 0; i < Math.min(hints.length, maxHints); i++) {
                    const h = hints[i];
                    html += '<div class="hint-item priority-' + (h.priority || 'medium') + '">'
                        + '<span class="hint-icon">' + (h.icon || '') + '</span>'
                        + h.text
                        + '</div>';
                }
            }

            els.coachingHints.innerHTML = html;
        }
    }

    // Hook into analyzeAcoustics to update coaching  
    const _origAnalyze = analyzeAcoustics;
    // eslint-disable-next-line no-global-assign  
    analyzeAcoustics = function () {
        _origAnalyze();
        if (currentTargetKey !== 'none') {
            updateCoachingDisplay();
        }
    };
}
