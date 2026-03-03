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

let noiseNode = null;
let noiseFilter = null;
let noiseGain = null;

let micStream = null;
let micSource = null;
let micGainNode = null;
let micAnalyser = null;

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
    micGain: 1.0,
    spectrumSlope: -12, // dB/octave attenuation
    showSlopeLine: false, // Toggle for slope approximation line
    acousticMode: 'Neutral', // 'Neutral', 'Yell', 'Whoop'
    masterVolume: 0.5, // 0.0 to 1.0
    formants: {
        f1: { freq: 500, q: 5, gain: 15, enabled: true },
        f2: { freq: 1500, q: 6, gain: 12, enabled: true },
        f3: { freq: 2800, q: 8, gain: 10, enabled: true },
        f4: { freq: 3800, q: 10, gain: 8, enabled: true },
        f5: { freq: 4800, q: 12, gain: 6, enabled: true }
    }
};

// --- DOM Elements ---
const els = {
    btnPlay: document.getElementById('audio-toggle'),
    btnMic: document.getElementById('mic-toggle'),
    btnSlopeLine: document.getElementById('slope-line-toggle'),
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
    autoRoutingToggle: document.getElementById('auto-routing-toggle'),

    // Glottal Waveform
    glottalCanvas: document.getElementById('glottal-canvas'),
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

    presets: document.querySelectorAll('.preset-btn')
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

// Map frequency to canvas x coordinate using a semi-log or linear scale
// For formants up to ~5kHz, linear is often easier to interpret on a small display overlay
const MAX_FREQ_DISPLAY = 6000;
function freqToX(freq, width) {
    return (freq / MAX_FREQ_DISPLAY) * width;
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

    // Spectral Tilt Filter (Highshelf)
    spectralTiltNode = audioCtx.createBiquadFilter();
    spectralTiltNode.type = 'highshelf';
    // Anchor the shelf slightly above the fundamental so H0 isn't attenuated, but higher harmonics are.
    spectralTiltNode.frequency.value = 400;

    // Connect Filter Chain: Source -> SpectralTilt -> F1 -> F2 -> F3 -> F4 -> F5 -> MasterGain -> Analyser -> Destination
    spectralTiltNode.connect(f1Node);
    f1Node.connect(f2Node);
    f2Node.connect(f3Node);
    f3Node.connect(f4Node);
    f4Node.connect(f5Node);
    f5Node.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);

    updateFilterParams();
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
        const gain = audioCtx.createGain();

        osc.type = 'sine';
        osc.frequency.value = freq;

        // Calculate amplitude based on spectral slope (M1 vs M2) and Phonation Mode
        const dbGain = calcHarmonicGainDb(i, state.mechanism, state.phonationMode, state.airflow);
        // Base scaling so it doesnt clip
        const linearGain = dbToLinear(dbGain) * (1 / Math.sqrt(maxHarmonics));

        gain.gain.value = linearGain;

        osc.connect(gain);
        gain.connect(spectralTiltNode);

        osc.start(time);

        harmonicsOscs.push({ osc, gain, harmonic: i });
    }

    updateSpectralTilt();
}

function destroySource() {
    const time = audioCtx ? audioCtx.currentTime : 0;
    harmonicsOscs.forEach(h => {
        h.gain.gain.linearRampToValueAtTime(0, time + 0.1);
        setTimeout(() => {
            try { h.osc.stop(); h.osc.disconnect(); h.gain.disconnect(); } catch (e) { }
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

    // Update UI
    els.airflowVal.textContent = state.airflow.toFixed(2);
    els.modeStatus.textContent = state.phonationMode.charAt(0).toUpperCase() + state.phonationMode.slice(1);
    els.modeStatus.className = `status-badge ${state.phonationMode}`;

    // Update intensity
    if (isPlaying && masterGain && audioCtx) {
        const targetIntensity = Math.min(1.0, state.pressure * 0.8) * state.masterVolume;
        masterGain.gain.setTargetAtTime(targetIntensity, audioCtx.currentTime, 0.05);
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

    // Detect "Turning Over" Event (Open -> Close transition from pitch rising)
    if (prevTimbre === 'Open' && state.timbreState === 'Close') {
        triggerTurningOver();
    }

    els.timbreState.textContent = state.timbreState;

    // 2. Acoustic Mode Logic (Yell vs Whoop)
    // Dynamic tolerances based on voice type
    const yellTolerance = state.voiceType === 'nontreble' ? 0.20 : 0.10; // Non-Treble easily Yells
    const whoopTolerance = state.voiceType === 'treble' ? 0.20 : 0.08; // Treble easily Whoops

    if (state.voiceType === 'treble') {
        // Treble Voice: Prioritizes Whoop (fR1 tracks 1fo).
        if (Math.abs(fR1 - f0) / f0 < whoopTolerance) {
            state.acousticMode = 'Whoop';
            if (!isPresetLoading && els.autoRoutingToggle.checked) {
                // Auto-adjust Phonation: Flow & M2
                els.mechM2.checked = true; state.mechanism = 'm2';
                els.resistanceSlider.value = 1.0; state.resistance = 1.0;
                els.pressureSlider.value = 1.0; state.pressure = 1.0;
                els.resistanceVal.textContent = state.resistance.toFixed(1);
                els.pressureVal.textContent = state.pressure.toFixed(1);
            }
        } else if (f0 <= 400 && Math.abs(fR1 - f20) / f20 < yellTolerance) {
            // Trebles can only truly Yell in their lower octaves
            state.acousticMode = 'Yell';
            if (!isPresetLoading && els.autoRoutingToggle.checked) {
                // Auto-adjust Phonation: Pressed & M1
                els.mechM1.checked = true; state.mechanism = 'm1';
                els.resistanceSlider.value = 2.0; state.resistance = 2.0;
                els.pressureSlider.value = 1.0; state.pressure = 1.0;
                els.resistanceVal.textContent = state.resistance.toFixed(1);
                els.pressureVal.textContent = state.pressure.toFixed(1);
            }
        } else {
            state.acousticMode = 'Neutral';
        }
    } else {
        // Non-Treble Voice: Prioritizes Yell (Turnover handling)
        if (Math.abs(fR1 - f20) / f20 < yellTolerance) {
            state.acousticMode = 'Yell';
            if (!isPresetLoading && els.autoRoutingToggle.checked) {
                // Auto-adjust Phonation: Pressed & M1
                els.mechM1.checked = true; state.mechanism = 'm1';
                els.resistanceSlider.value = 2.0; state.resistance = 2.0;
                els.pressureSlider.value = 1.0; state.pressure = 1.0;
                els.resistanceVal.textContent = state.resistance.toFixed(1);
                els.pressureVal.textContent = state.pressure.toFixed(1);
            }
        } else if (Math.abs(fR1 - f0) / f0 < whoopTolerance) {
            // Whoop is strict (requires closer tuning) for non-treble
            state.acousticMode = 'Whoop';
            if (!isPresetLoading && els.autoRoutingToggle.checked) {
                // Auto-adjust Phonation: Flow & M2
                els.mechM2.checked = true; state.mechanism = 'm2';
                els.resistanceSlider.value = 1.0; state.resistance = 1.0;
                els.pressureSlider.value = 1.0; state.pressure = 1.0;
                els.resistanceVal.textContent = state.resistance.toFixed(1);
                els.pressureVal.textContent = state.pressure.toFixed(1);
            }
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
            const linearGain = dbToLinear(dbGain) * (1 / Math.sqrt(maxHarmonics));

            h.gain.gain.setTargetAtTime(linearGain, time, 0.05);
        });
    }

    updateSpectralTilt();
}

function updateFilterParams() {
    if (!audioCtx) return;

    const time = audioCtx.currentTime;

    const updateNode = (node, key) => {
        node.frequency.setTargetAtTime(state.formants[key].freq, time, 0.05);
        node.Q.setTargetAtTime(state.formants[key].q, time, 0.05);
        // Toggle bypass by setting gain to 0
        node.gain.setTargetAtTime(state.formants[key].enabled ? state.formants[key].gain : 0, time, 0.05);
    };

    updateNode(f1Node, 'f1');
    updateNode(f2Node, 'f2');
    updateNode(f3Node, 'f3');
    updateNode(f4Node, 'f4');
    updateNode(f5Node, 'f5');

    analyzeAcoustics();
}

// --- LF Glottal Waveform Model ---

/**
 * Compute LF model parameters from the app's phonation state.
 * Maps Mechanism (M1/M2), Phonation Mode, and P/R to the Rd parameter,
 * which then determines Open Quotient (OQ), Speed Quotient (SQ),
 * and the LF waveform shape.
 *
 * Rd is the "declination parameter" (Fant 1995) that unifies
 * the LF model into a single control dimension:
 *   Rd ≈ 0.3 : very pressed (strong, buzzy)
 *   Rd ≈ 1.0 : modal/flow (balanced)
 *   Rd ≈ 2.7 : very breathy/soft
 */
function computeLFParams() {
    // Base Rd from mechanism
    let Rd = state.mechanism === 'm1' ? 0.8 : 1.5;

    // Modify by phonation mode
    if (state.phonationMode === 'pressed') {
        Rd -= 0.4; // Tighter closure → lower Rd
    } else if (state.phonationMode === 'breathy') {
        Rd += 0.8; // Incomplete closure → higher Rd
    }

    // Influence from Pressure/Resistance balance
    const prRatio = state.pressure / state.resistance;
    Rd += (prRatio - 1.0) * 0.3; // Higher airflow → breathier

    // Clamp Rd to valid range
    Rd = Math.max(0.3, Math.min(2.7, Rd));

    // Derive OQ and SQ from Rd (Fant 1995 regressions)
    const OQ = Math.min(0.95, 0.1 + 0.5 * Rd);      // Open Quotient: ~0.25 pressed, ~0.6 flow, ~0.95 breathy
    const SQ = Math.max(1.0, 4.0 - 1.1 * Rd);         // Speed Quotient: ~3.7 pressed (fast open), ~1.5 breathy

    return { Rd, OQ, SQ };
}

/**
 * Generate one period of the LF glottal flow waveform.
 * Returns an array of normalized amplitude values [0..1].
 *
 * The LF model divides one glottal cycle into:
 *   1. Opening phase (0 → Tp): flow rises, ∝ e^(αt) * sin(ωg*t)
 *   2. Closing phase (Tp → Te): flow falls to maximum excitation
 *   3. Return phase (Te → Tc): exponential recovery to zero
 *   4. Closed phase (Tc → T0): vocal folds are closed, flow = 0
 */
function generateLFWaveform(numPoints) {
    const { Rd, OQ, SQ } = computeLFParams();

    // Update UI readouts
    if (els.lfOq) els.lfOq.textContent = OQ.toFixed(2);
    if (els.lfSq) els.lfSq.textContent = SQ.toFixed(2);
    if (els.lfRd) els.lfRd.textContent = Rd.toFixed(2);

    const T0 = 1.0; // Normalized period

    // Timing parameters from OQ and SQ
    const Te = OQ * T0;                    // End of open phase
    const Tp = Te / (1.0 + SQ);            // Time of peak flow (opening phase)
    const Ta = (0.01 + 0.2 * (Rd - 0.3) / 2.4) * T0; // Return phase duration
    const Tc = Te + Math.min(Ta * 3, (T0 - Te) * 0.5); // End of return phase

    // Angular frequency for open phase sinusoid
    const wg = Math.PI / Tp;

    // Growth parameter α (controls asymmetry of the pulse)
    // Higher α = faster rising, more pressed sound
    const alpha = Math.max(0, (SQ - 1.0) * 2.0);

    // Return phase decay rate
    const epsilon = 1.0 / Math.max(0.001, Ta);

    const waveform = new Float32Array(numPoints);

    for (let i = 0; i < numPoints; i++) {
        const t = (i / numPoints) * T0;
        let val = 0;

        if (t <= Te) {
            // Open phase: rising sinusoid with exponential growth
            const sinPart = Math.sin(wg * t);
            const expPart = Math.exp(alpha * (t - Tp));
            val = sinPart * Math.min(expPart, 5.0); // clamp exp growth
        } else if (t <= Tc) {
            // Return phase: exponential decay from Te to baseline
            const decay = Math.exp(-epsilon * (t - Te));
            const baseline = Math.exp(-epsilon * (Tc - Te));
            val = -(decay - baseline) * 0.3; // Small negative excursion
        }
        // Closed phase (t > Tc): val = 0

        waveform[i] = val;
    }

    // Normalize to [0, 1] range
    let maxVal = 0;
    let minVal = 0;
    for (let i = 0; i < numPoints; i++) {
        if (waveform[i] > maxVal) maxVal = waveform[i];
        if (waveform[i] < minVal) minVal = waveform[i];
    }
    const range = maxVal - minVal || 1;
    for (let i = 0; i < numPoints; i++) {
        waveform[i] = (waveform[i] - minVal) / range;
    }

    return { waveform, Te, Tp, Tc, T0, OQ, Rd };
}

/**
 * Draw the glottal waveform on its dedicated canvas.
 * OQ, SQ, Rd are rendered inside the canvas. Phases are color-coded.
 */
let glottalNeedsRedraw = false;

function drawGlottalWaveform() {
    const canvas = els.glottalCanvas;
    if (!canvas) return;

    // Skip drawing if canvas is not visible (e.g. in a hidden tab on mobile)
    if (canvas.clientWidth === 0 || canvas.clientHeight === 0) {
        glottalNeedsRedraw = true;
        return;
    }

    const ctx = canvas.getContext('2d');
    canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1);
    canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1);
    ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    // Background
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, w, h);

    const numPoints = 500;
    const { waveform, Te, Tp, Tc, T0, OQ, Rd } = generateLFWaveform(numPoints);
    const { SQ } = computeLFParams();

    // Draw phase regions with slightly stronger tinting
    const teX = (Te / T0) * w;
    const tpX = (Tp / T0) * w;
    const tcX = (Tc / T0) * w;

    ctx.fillStyle = 'rgba(46, 160, 67, 0.08)';
    ctx.fillRect(0, 0, teX, h);

    ctx.fillStyle = 'rgba(255, 123, 114, 0.08)';
    ctx.fillRect(teX, 0, tcX - teX, h);

    ctx.fillStyle = 'rgba(88, 166, 255, 0.05)';
    ctx.fillRect(tcX, 0, w - tcX, h);

    // Phase boundary lines
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;

    // Te line
    ctx.strokeStyle = 'rgba(255, 123, 114, 0.35)';
    ctx.beginPath();
    ctx.moveTo(teX, 0); ctx.lineTo(teX, h);
    ctx.stroke();

    // Tc line
    ctx.strokeStyle = 'rgba(88, 166, 255, 0.25)';
    ctx.beginPath();
    ctx.moveTo(tcX, 0); ctx.lineTo(tcX, h);
    ctx.stroke();

    ctx.setLineDash([]);

    // Draw waveform with gradient fill
    const padding = 22;
    const paddingBottom = 14;
    const plotH = h - padding - paddingBottom;

    // Filled area under curve
    ctx.beginPath();
    ctx.moveTo(0, padding + plotH);
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const y = padding + plotH * (1.0 - waveform[i]);
        ctx.lineTo(x, y);
    }
    ctx.lineTo(w, padding + plotH);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, padding, 0, padding + plotH);
    gradient.addColorStop(0, 'rgba(88, 166, 255, 0.15)');
    gradient.addColorStop(1, 'rgba(88, 166, 255, 0.0)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // Waveform line
    ctx.beginPath();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(88, 166, 255, 0.4)';
    ctx.shadowBlur = 4;

    let peakX = 0, peakY = h;
    for (let i = 0; i < numPoints; i++) {
        const x = (i / numPoints) * w;
        const y = padding + plotH * (1.0 - waveform[i]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        if (y < peakY) { peakY = y; peakX = x; }
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Peak dot at Tp
    ctx.beginPath();
    ctx.arc(peakX, peakY, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd700';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 215, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Responsive font scaling for mobile
    const isMobile = w < 400;
    const fontSm = isMobile ? 7 : 9;
    const fontMd = isMobile ? 8 : 10;
    const fontLg = isMobile ? 9 : 11;

    // Tp label — 流量ピーク (Peak Flow)
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255, 215, 0, 0.8)';
    ctx.fillText('Tp 流量ピーク', peakX, peakY - 8);

    // Te label — 閉鎖点 (Closure Point)
    ctx.fillStyle = 'rgba(255, 123, 114, 0.7)';
    ctx.fillText('Te 閉鎖点', teX + (isMobile ? 18 : 28), padding + 4);

    // --- In-canvas parameter badges ---
    const badgeY = h - 4;
    ctx.font = `600 ${fontSm}px Inter, sans-serif`;
    ctx.textBaseline = 'bottom';

    // OQ badge — 開放率 (Open Quotient): green, in Open phase area
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(46, 160, 67, 0.8)';
    ctx.fillText(`開放率(OQ) ${OQ.toFixed(2)}`, teX / 2, badgeY);

    // SQ badge — 速度比 (Speed Quotient): gold, bottom of Return area
    ctx.fillStyle = 'rgba(255, 215, 0, 0.6)';
    if (tcX - teX > 50) {
        ctx.fillText(`速度比(SQ) ${SQ.toFixed(1)}`, (teX + tcX) / 2, badgeY);
    }

    // Rd badge — 波形タイプ (top-left corner with scale indicator)
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = `700 ${fontLg}px Inter, sans-serif`;
    ctx.fillText(`Rd ${Rd.toFixed(2)}`, 6, 3);
    // Sub-descriptor: show where this falls on the pressed–breathy scale
    ctx.font = `400 ${isMobile ? 6 : 8}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
    let rdDesc = '(Modal)';
    if (Rd < 0.5) rdDesc = '(Pressed寄り — 倍音↑)';
    else if (Rd < 0.9) rdDesc = '(やや Pressed — 倍音やや↑)';
    else if (Rd < 1.3) rdDesc = '(Modal — バランス型)';
    else if (Rd < 2.0) rdDesc = '(やや Breathy — 倍音↓)';
    else rdDesc = '(Breathy寄り — 倍音↓↓)';
    ctx.fillText(rdDesc, 6, 16);

    // Phonation mode badge (top-right) with English
    const modeLabels = {
        flow: 'Flow',
        pressed: 'Pressed',
        breathy: 'Breathy'
    };
    const modeColors = {
        flow: 'rgba(46, 160, 67, 0.8)',
        pressed: 'rgba(255, 123, 114, 0.8)',
        breathy: 'rgba(88, 166, 255, 0.8)'
    };
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = modeColors[state.phonationMode] || 'rgba(255,255,255,0.5)';
    ctx.font = `600 ${fontMd}px Inter, sans-serif`;
    ctx.fillText(modeLabels[state.phonationMode] || state.phonationMode, w - 6, 4);

    // Update hidden DOM elements for potential external use
    if (els.lfOq) els.lfOq.textContent = OQ.toFixed(2);
    if (els.lfSq) els.lfSq.textContent = SQ.toFixed(2);
    if (els.lfRd) els.lfRd.textContent = Rd.toFixed(2);
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
    canvasCtx.fillStyle = '#0d1117';
    canvasCtx.fillRect(0, 0, width, height);

    // Tuner-style pitch display from mic input
    if (state.isMicActive && micAnalyser) {
        const detectedPitch = detectPitchFromMic();
        if (detectedPitch > 0) {
            const noteName = freqToNote(detectedPitch);
            canvasCtx.save();

            // Large note name (like a tuner)
            canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.15)';
            canvasCtx.font = '700 48px Inter, sans-serif';
            canvasCtx.textAlign = 'center';
            canvasCtx.textBaseline = 'middle';
            canvasCtx.fillText(noteName, width / 2, height / 2 - 10);

            // Frequency below
            canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.10)';
            canvasCtx.font = '400 18px Inter, sans-serif';
            canvasCtx.fillText(`${Math.round(detectedPitch)} Hz`, width / 2, height / 2 + 28);

            canvasCtx.restore();
        }
    }

    // Draw Grid lines
    canvasCtx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    canvasCtx.lineWidth = 1;
    canvasCtx.beginPath();
    for (let i = 1; i <= 5; i++) {
        const x = freqToX(i * 1000, width);
        canvasCtx.moveTo(x, 0);
        canvasCtx.lineTo(x, height);
    }
    canvasCtx.stroke();

    const nyquist = audioCtx ? audioCtx.sampleRate / 2 : 24000;

    // Helper to draw a single frequency spectrum
    const drawSpectrum = (analyzerNode, strokeColor, fillColor, boost) => {
        if (!analyzerNode) return;
        const bufferLength = analyzerNode.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        analyzerNode.getFloatFrequencyData(dataArray);

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

    // 1. Draw Simulated Spectrum (Blue, filled)
    if (isPlaying && analyser) {
        const gradient = canvasCtx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, 'rgba(88, 166, 255, 0.5)');
        gradient.addColorStop(1, 'rgba(88, 166, 255, 0.0)');
        drawSpectrum(analyser, 'rgba(88, 166, 255, 0.8)', gradient, 1.5);

        // --- Draw Harmonic Peak Labels (1fo, 2fo, 3fo...) ---
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);
        analyser.getFloatFrequencyData(dataArray);

        const maxDb = analyser.maxDecibels;
        const minDb = analyser.minDecibels;
        const dbRange = maxDb - minDb;

        canvasCtx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        canvasCtx.font = '10px monospace';
        canvasCtx.textAlign = 'center';

        const f0 = state.pitch;
        const searchRangeHz = f0 * 0.1; // Search +/- 10% around expected harmonic freq for the exact FFT bin peak

        for (let h = 1; (f0 * h) <= MAX_FREQ_DISPLAY; h++) {
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

                canvasCtx.fillText(`${h}fo`, x, y - 8);
            }
        }
    }

    // 2. Draw Live Microphone Spectrum (Green, outline only)
    if (state.isMicActive && micAnalyser) {
        drawSpectrum(micAnalyser, 'rgba(46, 160, 67, 0.9)', null, 1.2);
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

            // Label
            canvasCtx.fillStyle = color;
            canvasCtx.font = '12px monospace';
            canvasCtx.fillText(label, cx - 10, 20);
        };

        drawFormantEnvelope(state.formants.f1.freq, state.formants.f1.q, 'F1', '#ff7b72', state.formants.f1.enabled); // Red
        drawFormantEnvelope(state.formants.f2.freq, state.formants.f2.q, 'F2', '#79c0ff', state.formants.f2.enabled); // Blue
        drawFormantEnvelope(state.formants.f3.freq, state.formants.f3.q, 'F3', '#a371f7', state.formants.f3.enabled); // Purple
        drawFormantEnvelope(state.formants.f4.freq, state.formants.f4.q, 'F4', '#f0883e', state.formants.f4.enabled); // Orange
        drawFormantEnvelope(state.formants.f5.freq, state.formants.f5.q, 'F5', '#d2a8ff', state.formants.f5.enabled); // Pink
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
        canvasCtx.strokeStyle = 'rgba(255, 215, 0, 0.7)'; // Gold/Yellow
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
        canvasCtx.fillStyle = 'rgba(255, 215, 0, 0.8)';
        canvasCtx.font = '11px monospace';
        canvasCtx.textAlign = 'left';
        canvasCtx.fillText(`Slope: ${slopeDbPerOctave}dB/oct`, freqToX(f0, width) + 5, 40);
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
        els.btnMic.classList.remove('mic-active');
        if (!isMobilePage) els.btnMic.textContent = 'Mic: OFF';
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
            micAnalyser.fftSize = 2048;
            micAnalyser.smoothingTimeConstant = 0.8;

            // Connect mic source -> gain -> analyzer entirely locally (NO route to audioCtx.destination)
            micSource.connect(micGainNode);
            micGainNode.connect(micAnalyser);

            state.isMicActive = true;
            els.btnMic.classList.add('mic-active');
            if (!isMobilePage) els.btnMic.textContent = 'Mic: ON';

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

// Source Controls
els.voiceTypeSelect.addEventListener('change', (e) => {
    state.voiceType = e.target.value;
    isPresetLoading = true; // Prevent acoustic triggers from overriding our intentional reset

    if (state.voiceType === 'treble') {
        // Treble Voice Model Defaults
        els.pitchSlider.min = 260; // ~C4
        els.pitchSlider.max = 1000; // ~C6

        // Prototypical Treble State: High pitch (A4), naturally tuned to Whoop/M2
        state.pitch = 440;
        els.pitchSlider.value = 440;

        // Reset F1 to a neutral 500Hz
        state.formants.f1.freq = 500;
        els.f1Slider.value = 500;

        // Inherently forced to M2 at this pitch for Treble
        els.mechM2.checked = true; state.mechanism = 'm2';
        state.phonationMode = 'flow';
        els.resistanceSlider.value = 1.0; state.resistance = 1.0;
        els.pressureSlider.value = 1.0; state.pressure = 1.0;

    } else {
        // Non-Treble Voice Model Defaults
        els.pitchSlider.min = 80; // ~E2
        els.pitchSlider.max = 500; // ~B4

        // Prototypical Non-Treble State: Low pitch (A3), preparing for Yell/M1
        state.pitch = 220;
        els.pitchSlider.value = 220;

        // Reset F1 to a neutral 500Hz
        state.formants.f1.freq = 500;
        els.f1Slider.value = 500;

        // Inherently comfortable in M1
        els.mechM1.checked = true; state.mechanism = 'm1';
        state.phonationMode = 'flow';
        els.resistanceSlider.value = 1.0; state.resistance = 1.0;
        els.pressureSlider.value = 1.0; state.pressure = 1.0;
    }

    // UI Updates
    els.pitchVal.textContent = state.pitch;
    els.pitchNote.textContent = freqToNote(state.pitch);
    els.f1Val.textContent = state.formants.f1.freq;
    els.resistanceVal.textContent = state.resistance.toFixed(1);
    els.pressureVal.textContent = state.pressure.toFixed(1);

    updateSourceParams();
    updateFilterParams();

    isPresetLoading = false;
    analyzeAcoustics(); // Trigger acoustics with new prototypical baseline
});

els.pitchSlider.addEventListener('input', (e) => {
    state.pitch = parseFloat(e.target.value);
    els.pitchVal.textContent = state.pitch;
    els.pitchNote.textContent = freqToNote(state.pitch);
    updateSourceParams();
    analyzeAcoustics();
});

els.pressureSlider.addEventListener('input', (e) => {
    state.pressure = parseFloat(e.target.value);
    els.pressureVal.textContent = state.pressure.toFixed(1);
    calcAerodynamics();
});

els.resistanceSlider.addEventListener('input', (e) => {
    state.resistance = parseFloat(e.target.value);
    els.resistanceVal.textContent = state.resistance.toFixed(1);
    calcAerodynamics();
});

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
    els.slopeVal.textContent = state.spectrumSlope + 'dB';
    updateSpectralTilt();
});

// Slope Line Toggle
els.btnSlopeLine.addEventListener('click', () => {
    state.showSlopeLine = !state.showSlopeLine;
    els.btnSlopeLine.classList.toggle('slope-line-active', state.showSlopeLine);
});

function updateSpectralTilt() {
    if (spectralTiltNode) {
        // Tie the shelf anchor to just above the fundamental to only tilt the harmonics
        const anchorFreq = state.pitch * 1.5;
        spectralTiltNode.frequency.setTargetAtTime(anchorFreq, audioCtx.currentTime, 0.1);
        spectralTiltNode.gain.setTargetAtTime(state.spectrumSlope, audioCtx.currentTime, 0.1);
    }
}

els.autoRoutingToggle.addEventListener('change', () => {
    // Re-evaluate current state if toggled back on
    analyzeAcoustics();
});

const handleMechChange = (e) => {
    state.mechanism = e.target.value;
    updateSourceParams();
    drawGlottalWaveform();
};
els.mechM1.addEventListener('change', handleMechChange);
els.mechM2.addEventListener('change', handleMechChange);

// Filter Controls
const bindFormantParams = (num) => {
    els[`f${num}Slider`].addEventListener('input', (e) => {
        state.formants[`f${num}`].freq = parseFloat(e.target.value);
        els[`f${num}Val`].textContent = state.formants[`f${num}`].freq;
        updateFilterParams();
        analyzeAcoustics(); // Trigger acoustics analysis when formants move
    });

    els[`f${num}Q`].addEventListener('input', (e) => {
        state.formants[`f${num}`].q = parseFloat(e.target.value);
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
            els.f1Slider.value = p.f1; els.f1Val.textContent = p.f1;
            els.f2Slider.value = p.f2; els.f2Val.textContent = p.f2;
            els.f3Slider.value = p.f3; els.f3Val.textContent = p.f3;
            els.f4Slider.value = p.f4; els.f4Val.textContent = p.f4;
            els.f5Slider.value = p.f5; els.f5Val.textContent = p.f5;

            if (p.pitch) {
                state.pitch = p.pitch;
                els.pitchSlider.value = p.pitch;
                els.pitchVal.textContent = p.pitch;
                els.pitchNote.textContent = freqToNote(p.pitch);
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

function getNearestFormant(freq) {
    let nearestKey = null;
    let minDiff = Infinity;
    for (let i = 1; i <= 5; i++) {
        const key = `f${i}`;
        if (!state.formants[key].enabled) continue;
        const diff = Math.abs(state.formants[key].freq - freq);
        // Generous grab radius around the peak
        if (diff < minDiff && diff < 800) {
            minDiff = diff;
            nearestKey = key;
        }
    }
    return nearestKey;
}

function handleCanvasInteraction(e) {
    if (!isPlaying) return;

    const rect = els.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = els.canvas.width || rect.width;

    // Map X to Frequency
    let freq = (x / width) * MAX_FREQ_DISPLAY;
    freq = Math.max(50, Math.min(MAX_FREQ_DISPLAY, freq));

    if (e.type === 'mousedown') {
        activeFormantKey = getNearestFormant(freq);
        if (activeFormantKey) {
            isDraggingFormant = true;
            els.canvas.classList.add('grabbing');
        }
    }

    if (isDraggingFormant && activeFormantKey) {
        freq = Math.round(freq);
        state.formants[activeFormantKey].freq = freq;

        // Update corresponding UI slider
        els[`${activeFormantKey}Slider`].value = freq;
        els[`${activeFormantKey}Val`].textContent = freq;

        updateFilterParams();
    }

    if (e.type === 'mouseup' || e.type === 'mouseleave') {
        isDraggingFormant = false;
        activeFormantKey = null;
        els.canvas.classList.remove('grabbing');
    }
}

els.canvas.addEventListener('mousedown', handleCanvasInteraction);
els.canvas.addEventListener('mousemove', handleCanvasInteraction);
els.canvas.addEventListener('mouseup', handleCanvasInteraction);
els.canvas.addEventListener('mouseleave', handleCanvasInteraction);

// Init notes & analysis
els.pitchNote.textContent = freqToNote(state.pitch);
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
