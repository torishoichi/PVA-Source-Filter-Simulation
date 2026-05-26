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
let micAnalyser = null;

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
    cachedMicFormants: null, // Per-formant snapshot (preserved during pause and brief live dropouts)
    cachedMicFormantsTime: null, // Per-formant last-update timestamp (ms)
    micGain: 1.0,
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
    btnSlopeLine: document.getElementById('slope-line-toggle'),
    btnLogScale: document.getElementById('log-scale-toggle'),
    btnRoughness: document.getElementById('roughness-toggle'),
    roughnessLegend: document.getElementById('roughness-legend'),
    pitchMirror: document.getElementById('rl-pitch-mirror'),
    btnFullscreen: document.getElementById('spectrum-fullscreen-btn'),
    micMethodSelect: document.getElementById('mic-formant-method'),
    canvas: document.getElementById('spectrum-canvas'),
    masterVolume: document.getElementById('master-volume'),
    micGainSlider: document.getElementById('mic-gain'),
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

// --- Pitch Detection (Autocorrelation) ---

function detectPitchFromMic() {
    if (!micAnalyser || !audioCtx) return -1;

    const bufLen = micAnalyser.fftSize;
    const buf = new Float32Array(bufLen);
    micAnalyser.getFloatTimeDomainData(buf);

    // Check if there's enough signal (RMS threshold)
    let rms = 0;
    for (let i = 0; i < bufLen; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / bufLen);
    if (rms < 0.01) return -1; // Too quiet

    // Autocorrelation
    const sampleRate = audioCtx.sampleRate;
    const minPeriod = Math.floor(sampleRate / 1000); // ~1000 Hz max
    const maxPeriod = Math.floor(sampleRate / 60);   // ~60 Hz min

    let bestCorrelation = 0;
    let bestPeriod = -1;

    for (let period = minPeriod; period <= maxPeriod; period++) {
        let correlation = 0;
        for (let i = 0; i < bufLen - period; i++) {
            correlation += buf[i] * buf[i + period];
        }
        correlation /= (bufLen - period);

        if (correlation > bestCorrelation) {
            bestCorrelation = correlation;
            bestPeriod = period;
        }
    }

    if (bestPeriod <= 0 || bestCorrelation < 0.01) return -1;

    // Parabolic interpolation for sub-sample accuracy
    const y1 = bestPeriod > minPeriod ? autocorr(buf, bestPeriod - 1) : 0;
    const y2 = autocorr(buf, bestPeriod);
    const y3 = bestPeriod < maxPeriod ? autocorr(buf, bestPeriod + 1) : 0;

    const shift = (y3 - y1) / (2 * (2 * y2 - y1 - y3));
    const refinedPeriod = bestPeriod + (isFinite(shift) ? shift : 0);

    return sampleRate / refinedPeriod;
}

function autocorr(buf, period) {
    let sum = 0;
    for (let i = 0; i < buf.length - period; i++) {
        sum += buf[i] * buf[i + period];
    }
    return sum / (buf.length - period);
}

// --- Visualizer ---

function resizeCanvas() {
    els.canvas.width = els.canvas.clientWidth;
    els.canvas.height = els.canvas.clientHeight;
}

function drawVisualizer() {
    if (!isPlaying && !state.isMicActive) return;

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

    // Tuner-style pitch display from mic input
    if (state.isMicActive && micAnalyser) {
        let detectedPitch = -1;

        if (state.isMicPaused) {
            detectedPitch = state.cachedMicPitch;
        } else {
            detectedPitch = detectPitchFromMic();
            state.cachedMicPitch = detectedPitch;
        }

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

        // Snapshot LPC coefficients for the envelope overlay
        lpcCoreState.lastCoefs = a;
        lpcCoreState.lastP = p;
        lpcCoreState.lastDecSr = decSr;
        lpcCoreState.lastUpdate = performance.now();

        return { voiced: true, raw };
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

        if (!state.isMicPaused) {
            micAnalyser.getFloatFrequencyData(state.cachedMicData);
        }

        drawSpectrum(micAnalyser, 'rgba(79, 150, 80, 0.95)', null, 1.2, state.cachedMicData);

        // --- Mic harmonic cent overlay ---
        // For each detected harmonic peak n·f₀ (f₀ from pitch detector), show
        // its cent deviation from the nearest equal-tempered semitone.
        const micF0 = state.cachedMicPitch;
        if (micF0 > 0 && state.cachedMicData) {
            const micBufLen = state.cachedMicData.length;
            const micNyq = audioCtx.sampleRate / 2;
            const micMaxDb = micAnalyser.maxDecibels;
            const micMinDb = micAnalyser.minDecibels;
            const micDbRange = micMaxDb - micMinDb;
            const micSearchHz = micF0 * 0.15;
            const micMaxH = Math.min(MAX_HARMONICS_ON_SPECTRUM, Math.floor(MAX_FREQ_DISPLAY / micF0));

            canvasCtx.save();
            canvasCtx.textAlign = 'center';
            canvasCtx.font = '9px monospace';
            for (let h = 1; h <= micMaxH; h++) {
                const expF = micF0 * h;
                const minF = expF - micSearchHz;
                const maxF = expF + micSearchHz;
                let peakVal = -Infinity;
                let peakFreq = expF;
                for (let i = 0; i < micBufLen; i++) {
                    const f = (i * micNyq) / micBufLen;
                    if (f < minF) continue;
                    if (f > maxF) break;
                    if (state.cachedMicData[i] > peakVal) {
                        peakVal = state.cachedMicData[i];
                        peakFreq = f;
                    }
                }
                if (peakVal <= micMinDb + (micDbRange * 0.15)) continue;

                const normVal = Math.max(0, (peakVal - micMinDb) / micDbRange);
                const displayVal = Math.pow(normVal, 1.5);
                const y = height - (displayVal * height * 0.9);
                const x = freqToX(peakFreq, width);

                const hzTxt = `${Math.round(peakFreq)}Hz`;

                // White-backed pill for legibility over green mic spectrum
                const txtW = canvasCtx.measureText(hzTxt).width;
                canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                canvasCtx.fillRect(x - txtW / 2 - 3, y - 22, txtW + 6, 12);
                canvasCtx.fillStyle = 'rgba(40, 100, 40, 0.95)';
                canvasCtx.fillText(hzTxt, x, y - 13);
            }
            canvasCtx.restore();
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
            estFormants =
                state.micFormantMethod === 'lpc-v3' ? estimateLpcV3Formants(micAnalyser, minDb, dbRange) :
                state.micFormantMethod === 'lpc-v2' ? estimateLpcV2Formants(micAnalyser, minDb, dbRange) :
                state.micFormantMethod === 'lpc'    ? estimateLpcFormants(micAnalyser, minDb, dbRange, nyq) :
                                                      estimatePeakFormants(state.cachedMicData, minDb, dbRange, nyq, state.cachedMicPitch);
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

        // LPC envelope overlay (v2/v3 only): translucent curve showing the modeled vocal-tract response.
        // Freshness check is skipped while paused so the envelope stays frozen with the formants.
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
                dbs[s] = db;
                freqs[s] = freq;
                if (db < envMin) envMin = db;
                if (db > envMax) envMax = db;
            }
            const span = Math.max(1e-3, envMax - envMin);
            canvasCtx.save();
            canvasCtx.beginPath();
            canvasCtx.strokeStyle = 'rgba(140, 90, 200, 0.65)';
            canvasCtx.lineWidth = 1.8;
            canvasCtx.setLineDash([6, 3]);
            for (let s = 0; s < samples; s++) {
                const x = freqToX(freqs[s], width);
                const norm = (dbs[s] - envMin) / span;
                const y = height - norm * height * 0.78 - height * 0.10;
                if (s === 0) canvasCtx.moveTo(x, y);
                else canvasCtx.lineTo(x, y);
            }
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
        state.isMicActive = false;
        state.isMicPaused = false;
        state.cachedMicFormants = null;
        state.cachedMicFormantsTime = null;
        els.btnMic.classList.remove('mic-active');
        if (els.btnMicPause) {
            els.btnMicPause.style.display = 'none';
            els.btnMicPause.classList.remove('mic-paused');
            const svgPause = '<svg viewBox="0 0 24 24" width="' + (isMobilePage ? 20 : 12) + '" height="' + (isMobilePage ? 20 : 12) + '" fill="currentColor" style="vertical-align: ' + (isMobilePage ? 'top' : '-1px') + '; ' + (isMobilePage ? '' : 'margin-right: 4px;') + '"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
            els.btnMicPause.innerHTML = isMobilePage ? svgPause : `${svgPause}Pause`;
        }
    } else {
        // Request permissions and start
        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });

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

            // Connect mic source -> gain -> analyzer entirely locally (NO route to audioCtx.destination)
            micSource.connect(micGainNode);
            micGainNode.connect(micAnalyser);

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
    });
}
if (els.vibratoExtent) {
    els.vibratoExtent.addEventListener('input', (e) => {
        state.vibrato.extent = parseFloat(e.target.value);
        els.vibratoExtentVal.textContent = state.vibrato.extent;
        applyVibratoLive();
    });
}
if (els.vibratoDelay) {
    els.vibratoDelay.addEventListener('input', (e) => {
        state.vibrato.onsetDelay = parseFloat(e.target.value);
        els.vibratoDelayVal.textContent = state.vibrato.onsetDelay;
    });
}
if (els.vibratoRamp) {
    els.vibratoRamp.addEventListener('input', (e) => {
        state.vibrato.onsetRamp = parseFloat(e.target.value);
        els.vibratoRampVal.textContent = state.vibrato.onsetRamp;
    });
}
if (els.vibratoAm) {
    els.vibratoAm.addEventListener('input', (e) => {
        state.vibrato.amDepth = parseFloat(e.target.value);
        els.vibratoAmVal.textContent = state.vibrato.amDepth;
        applyVibratoLive();
    });
}
if (els.vibratoWave) {
    els.vibratoWave.addEventListener('change', (e) => {
        state.vibrato.waveform = e.target.value;
        if (vibratoLFO) vibratoLFO.type = state.vibrato.waveform;
    });
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
