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
    canvas: document.getElementById('spectrum-canvas'),
    masterVolume: document.getElementById('master-volume'),
    micGainSlider: document.getElementById('mic-gain'),

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

    // Connect Filter Chain: Source -> F1 -> F2 -> F3 -> F4 -> F5 -> MasterGain -> Analyser -> Destination
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

    els.btnPlay.textContent = 'Stop Audio';
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

    els.btnPlay.textContent = 'Play Audio';
    els.btnPlay.classList.remove('playing');
    isPlaying = false;

    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
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
    noiseGain.connect(f1Node); // Pass noise through the vocal tract filter!

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
        gain.connect(f1Node);

        osc.start(time);

        harmonicsOscs.push({ osc, gain, harmonic: i });
    }
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
            }
        } else if (f0 <= 400 && Math.abs(fR1 - f20) / f20 < yellTolerance) {
            // Trebles can only truly Yell in their lower octaves
            state.acousticMode = 'Yell';
            if (!isPresetLoading && els.autoRoutingToggle.checked) {
                // Auto-adjust Phonation: Pressed & M1
                els.mechM1.checked = true; state.mechanism = 'm1';
                els.resistanceSlider.value = 2.0; state.resistance = 2.0;
                els.pressureSlider.value = 1.0; state.pressure = 1.0;
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
            }
        } else if (Math.abs(fR1 - f0) / f0 < whoopTolerance) {
            // Whoop is strict (requires closer tuning) for non-treble
            state.acousticMode = 'Whoop';
            if (!isPresetLoading && els.autoRoutingToggle.checked) {
                // Auto-adjust Phonation: Flow & M2
                els.mechM2.checked = true; state.mechanism = 'm2';
                els.resistanceSlider.value = 1.0; state.resistance = 1.0;
                els.pressureSlider.value = 1.0; state.pressure = 1.0;
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
        els.btnMic.textContent = 'Mic: OFF';
    } else {
        // Request permissions and start
        try {
            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Generate context if it doesn't exist yet
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
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
            els.btnMic.textContent = 'Mic: ON';

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
    calcAerodynamics();
});

els.micGainSlider.addEventListener('input', (e) => {
    state.micGain = parseFloat(e.target.value);
    if (micGainNode) {
        micGainNode.gain.setTargetAtTime(state.micGain, audioCtx.currentTime, 0.05);
    }
});

els.autoRoutingToggle.addEventListener('change', () => {
    // Re-evaluate current state if toggled back on
    analyzeAcoustics();
});

const handleMechChange = (e) => {
    state.mechanism = e.target.value;
    updateSourceParams();
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
