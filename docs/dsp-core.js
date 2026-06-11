/*
 * dsp-core.js — environment-agnostic DSP for the Source-Filter app.
 *
 * Loaded as a classic <script> BEFORE main.js (functions become globals), and
 * also require()-able from Node for the offline validation harness
 * (dev/validate.mjs). NO DOM, NO Web Audio, NO module-level mutable singletons
 * that assume a single caller — every routine is reentrant given its own args.
 *
 * Two groups of routines live here:
 *   1. NEW accuracy features authored here as the canonical implementation and
 *      called from main.js: cpps(), h1h2(), iaifGlottal(), vibratoProbeFormants().
 *   2. Reference mirrors of main.js's existing pure DSP (Burg LPC, Durand-Kerner,
 *      windowed-sinc decimation, YIN, pYIN-lite + Viterbi, offline formants) so the
 *      validation harness can measure accuracy and guard against regressions.
 */
(function (root) {
  'use strict';

  // ----------------------------------------------------------------------------
  // FFT (radix-2, in place). re/im are Float64Array of equal power-of-two length.
  // ----------------------------------------------------------------------------
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

  function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  function hann(N) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    return w;
  }

  // ----------------------------------------------------------------------------
  // Burg LPC → prediction coefficients a[0..p], with A(z) = 1 - Σ a[i] z^-i.
  // Reentrant (allocates its own scratch). Mirrors main.js burgLpc + reflections.
  // ----------------------------------------------------------------------------
  function burgLPC(x, p) {
    const N = x.length;
    const f = new Float64Array(N);
    const b = new Float64Array(N);
    for (let i = 0; i < N; i++) { f[i] = x[i]; b[i] = x[i]; }
    const k = new Float64Array(p + 1);
    for (let m = 1; m <= p; m++) {
      let num = 0, denom = 0;
      for (let n = m; n < N; n++) {
        num += f[n] * b[n - 1];
        denom += f[n] * f[n] + b[n - 1] * b[n - 1];
      }
      if (denom < 1e-18) { if (m === 1) return null; for (let j = m; j <= p; j++) k[j] = 0; break; }
      const km = 2 * num / denom;
      if (Math.abs(km) >= 0.999 || !isFinite(km)) { if (m === 1) return null; for (let j = m; j <= p; j++) k[j] = 0; break; }
      k[m] = km;
      for (let n = N - 1; n >= m; n--) {
        const fn = f[n], bn1 = b[n - 1];
        f[n] = fn - km * bn1;
        b[n] = bn1 - km * fn;
      }
    }
    // reflections → predictions
    const a = new Float64Array(p + 1);
    a[0] = 1;
    for (let m = 1; m <= p; m++) {
      const km = k[m];
      if (km === 0) continue;
      const aPrev = a.slice(0, m);
      a[m] = km;
      for (let i = 1; i < m; i++) a[i] = aPrev[i] - km * aPrev[m - i];
    }
    return a;
  }

  // Durand-Kerner roots of poly[0] z^n + ... + poly[n]. Returns Float64Array(2n) re/im pairs.
  function durandKerner(poly, n) {
    if (poly[0] === 0) return null;
    const c = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) c[i] = poly[i] / poly[0];
    const r = new Float64Array(2 * n);
    for (let kk = 0; kk < n; kk++) {
      const th = 2 * Math.PI * kk / n + 0.123;
      r[2 * kk] = 0.9 * Math.cos(th); r[2 * kk + 1] = 0.9 * Math.sin(th);
    }
    for (let iter = 0; iter < 80; iter++) {
      let maxD = 0;
      for (let kk = 0; kk < n; kk++) {
        const xr = r[2 * kk], xi = r[2 * kk + 1];
        let pr = 1, pi = 0;
        for (let i = 1; i <= n; i++) {
          const nr = pr * xr - pi * xi + c[i];
          const ni = pr * xi + pi * xr;
          pr = nr; pi = ni;
        }
        let dr = 1, di = 0;
        for (let j = 0; j < n; j++) {
          if (j === kk) continue;
          const er = xr - r[2 * j], ei = xi - r[2 * j + 1];
          const tr = dr * er - di * ei, ti = dr * ei + di * er;
          dr = tr; di = ti;
        }
        const den = dr * dr + di * di;
        if (den < 1e-30) continue;
        const qr = (pr * dr + pi * di) / den, qi = (pi * dr - pr * di) / den;
        r[2 * kk] = xr - qr; r[2 * kk + 1] = xi - qi;
        const d = Math.hypot(qr, qi);
        if (d > maxD) maxD = d;
      }
      if (maxD < 1e-11) break;
    }
    return r;
  }

  // From prediction coeffs → formant candidates {freq, bw} sorted by frequency.
  function lpcFormants(a, p, sr, opts) {
    opts = opts || {};
    const fMin = opts.fMin != null ? opts.fMin : 90;
    const fMax = opts.fMax != null ? opts.fMax : Math.min(5500, sr / 2 - 100);
    const bwMax = opts.bwMax != null ? opts.bwMax : 700;
    const poly = new Float64Array(p + 1);
    poly[0] = 1;
    for (let i = 1; i <= p; i++) poly[i] = -a[i];
    const roots = durandKerner(poly, p);
    if (!roots) return [];
    const out = [];
    for (let i = 0; i < p; i++) {
      const re = roots[2 * i], im = roots[2 * i + 1];
      if (im <= 0) continue;
      const mag = Math.hypot(re, im);
      if (mag <= 0 || mag >= 1) continue;
      const freq = Math.atan2(im, re) * sr / (2 * Math.PI);
      const bw = -Math.log(mag) * sr / Math.PI;
      if (freq < fMin || freq > fMax || bw > bwMax) continue;
      out.push({ freq, bw });
    }
    out.sort((u, v) => u.freq - v.freq);
    return out;
  }

  // Windowed-sinc anti-alias decimation. Mirrors main.js _offlineDecimate.
  function decimate(mono, srOrig, targetSr) {
    const factor = Math.max(1, Math.round(srOrig / targetSr));
    if (factor === 1) return { data: mono, sr: srOrig };
    const fc = 0.45 / factor;
    const M = 8 * factor + 1, c = (M - 1) / 2;
    const sinc = (x) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
    const ker = new Float64Array(M);
    let ksum = 0;
    for (let n = 0; n < M; n++) {
      const ham = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (M - 1));
      ker[n] = sinc(2 * fc * (n - c)) * ham;
      ksum += ker[n];
    }
    for (let n = 0; n < M; n++) ker[n] /= ksum;
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

  // ----------------------------------------------------------------------------
  // YIN pitch detector. Reentrant. Returns {hz, clarity}; hz=-1 when unvoiced.
  // Mirrors main.js detectPitchYIN (DC-removal variant — NO pre-emphasis — which
  // the playback contour validated as far more accurate at low f0).
  // ----------------------------------------------------------------------------
  function yin(rawBuf, sr, opts) {
    opts = opts || {};
    const threshold = opts.threshold != null ? opts.threshold : 0.10;
    const unvoiced = opts.unvoiced != null ? opts.unvoiced : 0.35;
    const fMin = opts.fMin != null ? opts.fMin : 60;
    const fMax = opts.fMax != null ? opts.fMax : 1000;
    const preemph = opts.preemph != null ? opts.preemph : 0; // 0 = DC-removal only
    const N = rawBuf.length;
    const buf = new Float64Array(N);
    if (preemph > 0) {
      buf[0] = rawBuf[0];
      for (let i = 1; i < N; i++) buf[i] = rawBuf[i] - preemph * rawBuf[i - 1];
    } else {
      let mean = 0;
      for (let i = 0; i < N; i++) mean += rawBuf[i];
      mean /= N;
      for (let i = 0; i < N; i++) buf[i] = rawBuf[i] - mean;
    }
    let rms = 0;
    for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < 0.004) return { hz: -1, clarity: 0 };
    const minP = Math.max(2, Math.floor(sr / fMax));
    const maxP = Math.min(Math.floor(sr / fMin), N >> 1);
    if (maxP <= minP) return { hz: -1, clarity: 0 };
    const dp = new Float64Array(maxP + 1);
    dp[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxP; tau++) {
      let ds = 0; const W = N - tau;
      for (let j = 0; j < W; j++) { const d = buf[j] - buf[j + tau]; ds += d * d; }
      run += ds;
      dp[tau] = run > 0 ? (ds * tau) / run : 1;
    }
    let bestTau = -1;
    for (let tau = minP; tau <= maxP - 1; tau++) {
      if (dp[tau] < threshold) {
        while (tau + 1 <= maxP && dp[tau + 1] < dp[tau]) tau++;
        bestTau = tau; break;
      }
    }
    if (bestTau < 0) {
      let mv = Infinity;
      for (let tau = minP; tau <= maxP; tau++) if (dp[tau] < mv) { mv = dp[tau]; bestTau = tau; }
    }
    if (bestTau < 0 || dp[bestTau] > unvoiced) return { hz: -1, clarity: 0 };
    // NOTE: single-frame octave correction is intentionally NOT done here — a signal
    // periodic at T is also periodic at 2T, so any local guard either breaks clean
    // tones or misses the formant-on-H2 trap. Octave robustness is handled where it
    // can be done safely: the offline contour (multi-candidate + Viterbi, see
    // yinCandidates/viterbiPitchPath) and live temporal continuity in main.js.
    const clarity = Math.max(0, Math.min(1, 1 - dp[bestTau]));
    let refined = bestTau;
    if (bestTau > minP && bestTau < maxP) {
      const y0 = dp[bestTau - 1], y1 = dp[bestTau], y2 = dp[bestTau + 1];
      const den = y0 - 2 * y1 + y2;
      if (Math.abs(den) > 1e-12) { const dl = 0.5 * (y0 - y2) / den; if (dl > -1 && dl < 1) refined = bestTau + dl; }
    }
    return { hz: sr / refined, clarity };
  }

  // ----------------------------------------------------------------------------
  // CPPS — Cepstral Peak Prominence (Smoothed). Robust, validated correlate of
  // dysphonia / breathiness / phonation efficiency. Higher = clearer/periodic.
  //
  // Method (Hillenbrand-style, simplified for real-time): log-power spectrum →
  // real cepstrum → search the quefrency band for f0 (sr/fMax .. sr/fMin) for the
  // peak → fit a regression line across the whole cepstrum → prominence = peak dB
  // above the regression line at the peak's quefrency. We compute it on a single
  // window; main.js averages over time ("smoothed").
  // Returns { cpp: dB, f0: Hz|null }.
  // ----------------------------------------------------------------------------
  function cpps(frame, sr, opts) {
    opts = opts || {};
    const fMin = opts.fMin != null ? opts.fMin : 60;
    const fMax = opts.fMax != null ? opts.fMax : 500;
    const N = nextPow2(frame.length);
    const re = new Float64Array(N), im = new Float64Array(N);
    const w = hann(frame.length);
    for (let i = 0; i < frame.length; i++) re[i] = frame[i] * w[i];
    fftRadix2(re, im);
    // log power spectrum
    const logmag = new Float64Array(N);
    for (let i = 0; i < N; i++) logmag[i] = Math.log(re[i] * re[i] + im[i] * im[i] + 1e-12);
    // real cepstrum = IFFT(logmag). logmag is real & symmetric → use FFT then /N, take real.
    const cre = new Float64Array(N), cim = new Float64Array(N);
    for (let i = 0; i < N; i++) { cre[i] = logmag[i]; cim[i] = 0; }
    fftRadix2(cre, cim);              // forward FFT of a real symmetric seq ≈ real cepstrum*N
    const ceps = new Float64Array(N >> 1);
    for (let i = 0; i < (N >> 1); i++) ceps[i] = cre[i] / N; // real part / N
    // quefrency band for f0
    const qMin = Math.max(2, Math.floor(sr / fMax));
    const qMax = Math.min((N >> 1) - 2, Math.floor(sr / fMin));
    if (qMax <= qMin) return { cpp: 0, f0: null };
    let pk = qMin, pkV = -Infinity;
    for (let q = qMin; q <= qMax; q++) { const v = ceps[q]; if (v > pkV) { pkV = v; pk = q; } }
    // linear regression of cepstrum (dB) vs quefrency over the search band as baseline
    let sx = 0, sy = 0, sxx = 0, sxy = 0, cnt = 0;
    for (let q = qMin; q <= qMax; q++) {
      const y = ceps[q];
      sx += q; sy += y; sxx += q * q; sxy += q * y; cnt++;
    }
    const denom = cnt * sxx - sx * sx;
    const slope = Math.abs(denom) > 1e-12 ? (cnt * sxy - sx * sy) / denom : 0;
    const intercept = (sy - slope * sx) / cnt;
    const baseline = slope * pk + intercept;
    // prominence in dB (cepstrum here is in nepers; ×(20/ln10)/2 ≈ amplitude dB). The
    // absolute scale is conventional; we report a positive dB-like prominence.
    const cpp = Math.max(0, (pkV - baseline)) * (20 / Math.LN10) / 2;
    return { cpp, f0: sr / pk };
  }

  // ----------------------------------------------------------------------------
  // H1–H2 — amplitude difference (dB) between the 1st and 2nd voice harmonics.
  // Classic open-quotient / breathiness correlate: breathy/abducted (high OQ) →
  // large positive H1–H2; pressed/adducted (low OQ) → small or negative.
  // Searches a small neighbourhood around k*f0 for the true harmonic peak.
  // Returns { h1h2: dB, h1: dB, h2: dB } or null when f0 invalid.
  // ----------------------------------------------------------------------------
  function h1h2(frame, sr, f0, opts) {
    if (!f0 || f0 <= 0) return null;
    opts = opts || {};
    const N = nextPow2(frame.length);
    const re = new Float64Array(N), im = new Float64Array(N);
    const w = hann(frame.length);
    for (let i = 0; i < frame.length; i++) re[i] = frame[i] * w[i];
    fftRadix2(re, im);
    const binHz = sr / N;
    const search = Math.max(1, Math.round((f0 * 0.12) / binHz)); // ±12% window
    const peakDbNear = (targetHz) => {
      const c = Math.round(targetHz / binHz);
      let best = -Infinity;
      for (let k = c - search; k <= c + search; k++) {
        if (k < 1 || k >= (N >> 1)) continue;
        const mag = Math.hypot(re[k], im[k]);
        const db = 20 * Math.log10(mag + 1e-12);
        if (db > best) best = db;
      }
      return best;
    };
    const h1 = peakDbNear(f0);
    const h2 = peakDbNear(2 * f0);
    if (!isFinite(h1) || !isFinite(h2)) return null;
    return { h1h2: h1 - h2, h1, h2 };
  }

  // ----------------------------------------------------------------------------
  // IAIF — Iterative Adaptive Inverse Filtering (Alku 1992), single frame.
  // Estimates the glottal flow by canceling the vocal-tract and lip-radiation
  // contributions, then derives source quotients (NAQ etc.). Operates on a
  // pre-windowed, ideally pitch-synchronous-ish frame at sample rate sr.
  //
  // Returns { flow: Float64Array, naq, oq, qoq, rdEst, f0 } or null.
  //   NAQ  = AC flow amplitude / (peak negative flow-derivative · T0)  [Alku 2002]
  //   Rd   ≈ NAQ / 0.11  (rough Fant-frame mapping; LABELLED APPROXIMATE)
  // ----------------------------------------------------------------------------
  function iaifGlottal(frame, sr, opts) {
    opts = opts || {};
    const pVT = opts.vtOrder != null ? opts.vtOrder : Math.min(20, Math.round(sr / 1000) + 4);
    const pG = opts.gOrder != null ? opts.gOrder : 4;
    const lipR = opts.lipRadius != null ? opts.lipRadius : 0.99; // integrator pole for lip-radiation cancel
    const N = frame.length;
    if (N < pVT + 4) return null;

    const win = hann(N);
    const xw = new Float64Array(N);
    for (let i = 0; i < N; i++) xw[i] = frame[i] * win[i];

    // inverse filter y = A(z) x  (FIR with a[0..p], a[0]=1, coeffs as -a model)
    const inverseFilter = (sig, a, p) => {
      const out = new Float64Array(sig.length);
      for (let n = 0; n < sig.length; n++) {
        let acc = sig[n];                       // a[0]=1
        for (let i = 1; i <= p; i++) if (n - i >= 0) acc -= a[i] * sig[n - i];
        out[n] = acc;
      }
      return out;
    };
    // leaky integrator 1/(1 - lipR z^-1) — cancels the +6 dB/oct lip radiation
    const integrate = (sig) => {
      const out = new Float64Array(sig.length);
      let prev = 0;
      for (let n = 0; n < sig.length; n++) { out[n] = sig[n] + lipR * prev; prev = out[n]; }
      // remove DC drift
      let mean = 0; for (let n = 0; n < out.length; n++) mean += out[n]; mean /= out.length;
      for (let n = 0; n < out.length; n++) out[n] -= mean;
      return out;
    };

    // Step 1: first glottal estimate via order-1 LPC, inverse-filter to flatten tilt
    const g1 = burgLPC(xw, 1);
    if (!g1) return null;
    let s1 = inverseFilter(xw, g1, 1);
    // Step 2: first vocal-tract estimate
    let vt1 = burgLPC(s1, pVT);
    if (!vt1) return null;
    // Step 3: cancel VT from the ORIGINAL, integrate → glottal flow estimate 1
    let gflow1 = integrate(inverseFilter(xw, vt1, pVT));
    // Step 4: model glottal contribution (order pG) from flow1
    let g2 = burgLPC(gflow1, pG);
    if (!g2) g2 = g1;
    // Step 5: remove glottal contribution from original, re-estimate VT
    let s2 = inverseFilter(xw, g2, pG);
    let vt2 = burgLPC(s2, pVT);
    if (!vt2) vt2 = vt1;
    // Step 6: final glottal flow = integrate( original with VT2 removed )
    const flow = integrate(inverseFilter(xw, vt2, pVT));

    // f0 (for T0) from autocorrelation of the frame
    const f0 = autocorrF0(frame, sr, 60, 500);
    if (!f0) return { flow, naq: null, oq: null, qoq: null, rdEst: null, f0: null };
    const T0samp = sr / f0;

    // Flow derivative
    const dflow = new Float64Array(N);
    for (let n = 1; n < N; n++) dflow[n] = flow[n] - flow[n - 1];
    dflow[0] = dflow[1];

    // AC flow amplitude (peak-to-peak of flow), and peak negative derivative (d_min)
    let fmax = -Infinity, fmin = Infinity, dmin = Infinity;
    for (let n = 0; n < N; n++) {
      if (flow[n] > fmax) fmax = flow[n];
      if (flow[n] < fmin) fmin = flow[n];
      if (dflow[n] < dmin) dmin = dflow[n];
    }
    const fAC = fmax - fmin;
    const dPeak = -dmin;
    let naq = null, rdEst = null;
    if (dPeak > 1e-9 && T0samp > 0) {
      naq = fAC / (dPeak * T0samp);
      rdEst = naq / 0.11; // APPROXIMATE Fant-frame mapping
    }

    // Crude OQ / QOQ from one period around the global flow maximum
    const { oq, qoq } = estimateOpenQuotient(flow, T0samp);
    return { flow, naq, oq, qoq, rdEst, f0 };
  }

  // Normalized-autocorrelation f0 on a frame. Returns Hz or null.
  function autocorrF0(sig, sr, fMin, fMax) {
    const N = sig.length;
    let mean = 0; for (let i = 0; i < N; i++) mean += sig[i]; mean /= N;
    let r0 = 0; for (let i = 0; i < N; i++) { const v = sig[i] - mean; r0 += v * v; }
    if (r0 < 1e-9) return null;
    const minLag = Math.max(2, Math.floor(sr / fMax));
    const maxLag = Math.min(N - 1, Math.floor(sr / fMin));
    let bestLag = -1, bestVal = 0.3;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      for (let i = 0; i + lag < N; i++) acc += (sig[i] - mean) * (sig[i + lag] - mean);
      const norm = acc / r0;
      if (norm > bestVal) { bestVal = norm; bestLag = lag; }
    }
    return bestLag > 0 ? sr / bestLag : null;
  }

  // Open-quotient estimate from a glottal-flow frame: threshold the flow at a
  // fraction of its peak (above its min) per period. Returns mean OQ and QOQ.
  function estimateOpenQuotient(flow, T0samp) {
    const N = flow.length;
    if (T0samp < 4 || T0samp > N) return { oq: null, qoq: null };
    // global range
    let lo = Infinity, hi = -Infinity;
    for (let n = 0; n < N; n++) { if (flow[n] < lo) lo = flow[n]; if (flow[n] > hi) hi = flow[n]; }
    const range = hi - lo;
    if (range < 1e-9) return { oq: null, qoq: null };
    const thrOQ = lo + 0.5 * range;   // 50% level → OQ
    const thrQ = lo + 0.5 * range;    // QOQ defined at 50% of cycle peak (per-period below)
    let openOQ = 0, openQOQ = 0, periods = 0;
    const step = Math.round(T0samp);
    for (let c = 0; c + step <= N; c += step) {
      let pkLo = Infinity, pkHi = -Infinity;
      for (let n = c; n < c + step; n++) { if (flow[n] < pkLo) pkLo = flow[n]; if (flow[n] > pkHi) pkHi = flow[n]; }
      const pr = pkHi - pkLo;
      if (pr < 1e-9) continue;
      const lvlQ = pkLo + 0.5 * pr;
      let oOQ = 0, oQOQ = 0;
      for (let n = c; n < c + step; n++) { if (flow[n] > thrOQ) oOQ++; if (flow[n] > lvlQ) oQOQ++; }
      openOQ += oOQ / step; openQOQ += oQOQ / step; periods++;
    }
    if (!periods) return { oq: null, qoq: null };
    return { oq: openOQ / periods, qoq: openQOQ / periods };
  }

  // ----------------------------------------------------------------------------
  // pYIN-lite offline pitch contour (mirrors main.js yinCandidates + Viterbi +
  // post-processing). Synchronous variant for the validation harness and Node;
  // main.js keeps its chunked async version for UI responsiveness.
  // ----------------------------------------------------------------------------
  const PB_CAND_THRESH = 0.5;
  const PB_PRIOR_T = [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50];
  const PB_PRIOR_W = [0.10, 0.30, 0.24, 0.14, 0.12, 0.06, 0.04];
  const C0 = 440 * Math.pow(2, -4.75);

  function yinCandidates(buf0, sr) {
    const N = buf0.length;
    const buf = new Float64Array(N);
    let mean = 0;
    for (let i = 0; i < N; i++) mean += buf0[i];
    mean /= N;
    for (let i = 0; i < N; i++) buf[i] = buf0[i] - mean;
    let rms = 0;
    for (let i = 0; i < N; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / N);
    if (rms < 0.004) return { voiced: false, voicedProb: 0, cands: [] };
    const minP = Math.max(2, Math.floor(sr / 1000));
    const maxP = Math.min(Math.floor(sr / 60), N >> 1);
    if (maxP <= minP) return { voiced: false, voicedProb: 0, cands: [] };
    const dp = new Float64Array(maxP + 1);
    dp[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= maxP; tau++) {
      let ds = 0; const W = N - tau;
      for (let j = 0; j < W; j++) { const d = buf[j] - buf[j + tau]; ds += d * d; }
      run += ds;
      dp[tau] = run > 0 ? (ds * tau) / run : 1;
    }
    const minima = [];
    for (let tau = minP + 1; tau < maxP; tau++) {
      if (dp[tau] < PB_CAND_THRESH && dp[tau] < dp[tau - 1] && dp[tau] <= dp[tau + 1]) {
        let refined = tau;
        const y0 = dp[tau - 1], y1 = dp[tau], y2 = dp[tau + 1], den = y0 - 2 * y1 + y2;
        if (Math.abs(den) > 1e-12) { const dl = 0.5 * (y0 - y2) / den; if (dl > -1 && dl < 1) refined = tau + dl; }
        minima.push({ tau: refined, d: dp[tau] });
      }
    }
    if (!minima.length) return { voiced: false, voicedProb: 0, cands: [] };
    const prob = new Float64Array(minima.length);
    let vMass = 0;
    for (let k = 0; k < PB_PRIOR_T.length; k++) {
      let chosen = -1;
      for (let m = 0; m < minima.length; m++) { if (minima[m].d < PB_PRIOR_T[k]) { chosen = m; break; } }
      if (chosen >= 0) { prob[chosen] += PB_PRIOR_W[k]; vMass += PB_PRIOR_W[k]; }
    }
    // Octave-up correction: when a formant sits on an even harmonic the signal looks
    // periodic at half the true period, so the shortest dip (highest f0) can win the
    // threshold prior. The tell-tale of such an artifact is that its difference value
    // is NON-trivial (the half-period is only ~90% periodic, d≈0.1), whereas the TRUE
    // period at ~2× the lag is a much cleaner dip (d≈0). So move probability mass DOWN
    // to the 2× sibling ONLY when:
    //   (a) the source minimum is itself imperfect (d > 0.03) — a true clean
    //       fundamental has d≈0 and is left alone (no octave-DOWN over-collapse), and
    //   (b) the longer-period dip is clearly deeper (d ≤ 0.5× the source).
    // The d>0.03 gate also makes this single-step (a just-corrected true fundamental
    // has d≈0, so it never becomes a source for a further collapse to its subharmonic).
    const OCT_SRC_FLOOR = 0.03, OCT_DEPTH = 0.5;
    for (let m = 0; m < minima.length; m++) {
      if (prob[m] <= 0 || minima[m].d <= OCT_SRC_FLOOR) continue;
      const want = minima[m].tau * 2;
      let lo = -1;
      for (let q = 0; q < minima.length; q++) {
        if (Math.abs(minima[q].tau - want) <= want * 0.04) { lo = q; break; }
      }
      if (lo >= 0 && minima[lo].d <= minima[m].d * OCT_DEPTH) {
        const moved = prob[m] * 0.8;
        prob[lo] += moved; prob[m] -= moved;
      }
    }
    let cands = [];
    for (let m = 0; m < minima.length; m++) if (prob[m] > 0)
      cands.push({ f0: sr / minima[m].tau, prob: prob[m], clar: Math.max(0, 1 - minima[m].d) });
    if (!cands.length) {
      let bm = 0;
      for (let m = 1; m < minima.length; m++) if (minima[m].d < minima[bm].d) bm = m;
      cands = [{ f0: sr / minima[bm].tau, prob: 0.5, clar: Math.max(0, 1 - minima[bm].d) }];
      vMass = 0.5;
    }
    cands.sort((a, b) => b.prob - a.prob);
    if (cands.length > 8) cands = cands.slice(0, 8);
    return { voiced: true, voicedProb: Math.min(1, vMass), cands };
  }

  function viterbiPitchPath(frames) {
    const LAMBDA = 0.012, CAP = 24, SWITCH = 4, EPS = 1e-6;
    const n = frames.length;
    const backAll = new Array(n), f0All = new Array(n), clarAll = new Array(n);
    let prevCost = null, prevCents = null;
    for (let i = 0; i < n; i++) {
      const fr = frames[i];
      const ce = [], f0 = [], cl = [], emit = [];
      if (fr.voiced) for (const cnd of fr.cands) {
        ce.push(1200 * Math.log2(cnd.f0 / C0)); f0.push(cnd.f0); cl.push(cnd.clar);
        emit.push(-Math.log(cnd.prob + EPS));
      }
      ce.push(null); f0.push(null); cl.push(0);
      emit.push(-Math.log(fr.voiced ? Math.max(EPS, 1 - (fr.voicedProb || 0)) : 1));
      const cost = new Float64Array(ce.length), back = new Int16Array(ce.length);
      if (prevCost == null) {
        for (let s = 0; s < ce.length; s++) { cost[s] = emit[s]; back[s] = -1; }
      } else {
        for (let s = 0; s < ce.length; s++) {
          let best = Infinity, bi = 0;
          for (let p = 0; p < prevCents.length; p++) {
            const a = prevCents[p], b = ce[s];
            let tr;
            if (a == null && b == null) tr = 0;
            else if (a == null || b == null) tr = SWITCH;
            else tr = Math.min(CAP, LAMBDA * Math.abs(a - b));
            const cc = prevCost[p] + tr;
            if (cc < best) { best = cc; bi = p; }
          }
          cost[s] = best + emit[s]; back[s] = bi;
        }
      }
      backAll[i] = back; f0All[i] = f0; clarAll[i] = cl;
      prevCost = cost; prevCents = ce;
    }
    const out = new Array(n);
    let s = 0, bc = Infinity;
    for (let k = 0; k < prevCost.length; k++) if (prevCost[k] < bc) { bc = prevCost[k]; s = k; }
    for (let i = n - 1; i >= 0; i--) {
      out[i] = { hz: f0All[i][s], clar: clarAll[i][s] };
      const b = backAll[i][s];
      s = b < 0 ? 0 : b;
    }
    return out;
  }

  // Synchronous offline pitch contour. Returns [{t, hz|null, clarity}].
  function pitchContour(mono, srOrig, opts) {
    opts = opts || {};
    const targetSr = opts.targetSr || 11025;
    const { data: ds, sr } = decimate(mono, srOrig, targetSr);
    const N = opts.N || 512;
    const hop = Math.max(1, Math.round(sr * (opts.hopMs || 5) / 1000));
    const total = ds.length;
    const win = new Float32Array(N);
    const frames = [], tArr = [];
    for (let center = 0; center < total; center += hop) {
      const start = center - (N >> 1);
      for (let i = 0; i < N; i++) { const idx = start + i; win[i] = (idx >= 0 && idx < total) ? ds[idx] : 0; }
      frames.push(yinCandidates(win, sr));
      tArr.push(center / sr);
    }
    const path = viterbiPitchPath(frames);
    const raw = new Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      const p = path[i];
      raw[i] = (p && p.hz) ? { t: tArr[i], hz: p.hz, clarity: Math.max(0.62, p.clar || 0) } : { t: tArr[i], hz: null, clarity: 0 };
    }
    return raw;
  }

  // Live octave-continuity snap: given a fresh detection hz and the running median
  // of recent voiced f0, return hz corrected for a transient octave slip. Only acts
  // on a LARGE jump (>550¢) when an octave-shifted version sits much closer (<300¢)
  // to the median — so vibrato (±200¢) and real legato leaps pass through untouched.
  function octaveSnap(hz, medianHz, opts) {
    if (hz <= 0 || !medianHz || medianHz <= 0) return hz;
    opts = opts || {};
    const jumpGate = opts.jumpGate != null ? opts.jumpGate : 550;
    const accept = opts.accept != null ? opts.accept : 300;
    const fMin = opts.fMin != null ? opts.fMin : 60;
    const fMax = opts.fMax != null ? opts.fMax : 1000;
    const cMed = 1200 * Math.log2(medianHz / C0);
    const base = 1200 * Math.log2(hz / C0);
    if (Math.abs(base - cMed) <= jumpGate) return hz;
    let bestHz = hz, bestDev = Math.abs(base - cMed);
    for (const mul of [0.5, 2, 1 / 3, 3]) {
      const cand = hz * mul;
      if (cand < fMin || cand > fMax) continue;
      const dev = Math.abs(1200 * Math.log2(cand / C0) - cMed);
      if (dev < bestDev) { bestDev = dev; bestHz = cand; }
    }
    return (bestHz !== hz && bestDev < accept) ? bestHz : hz;
  }

  // ----------------------------------------------------------------------------
  // Offline formant track (mirrors main.js analyzeRecordingFormantsOffline +
  // _trackAndSmooth) — used by the validation harness and by main.js's vibrato
  // probe. Input is a full mono signal at srOrig; decimates to ~11 kHz internally.
  // Returns { hop, frames:[{f1..f5}|null] }.
  // ----------------------------------------------------------------------------
  function offlineFormants(mono, srOrig, opts) {
    opts = opts || {};
    const { data: sig, sr } = decimate(mono, srOrig, opts.targetSr || 11025);
    const hopSec = opts.hopSec || 0.01;
    const hop = Math.max(1, Math.round(hopSec * sr));
    const p = Math.min(16, Math.max(10, Math.round(sr / 1000) + 2));
    const minLag = Math.floor(sr / 500), maxLag = Math.floor(sr / 70);
    const w40 = Math.floor(0.04 * sr);
    const minWin = Math.floor(0.02 * sr), maxWin = Math.floor(0.05 * sr);
    const frames = [];
    const preAlpha = 0.97;
    for (let center = 0; center < sig.length; center += hop) {
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
      const a = burgLPC(x, p);
      if (!a) { frames.push(null); continue; }
      const cands = lpcFormants(a, p, sr, { fMin: 90, fMax: 5500, bwMax: 700 });
      frames.push(cands.length ? cands : null);
    }
    return trackAndSmooth(frames, hopSec);
  }

  // Per-slot search bands (Hz) — wide enough for extreme vowels (front /i/ F2≈2300,
  // back /u/ F2≈870). Tie-break toward the per-slot prior, but never reject an
  // in-band candidate just because it is far from a generic prior (the old tight
  // tolerances dropped /i/,/u/ F2 entirely). Order + min-gap is enforced.
  const FORMANT_BANDS = [[180, 1100], [550, 3000], [1400, 3500], [2600, 4600], [3200, 5600]];
  const FORMANT_PRIORS = [500, 1500, 2500, 3500, 4500];
  const FORMANT_MINGAP = 150;

  function trackAndSmooth(frames, hopSec) {
    const SLOTS = 5;
    const assignedAll = new Array(frames.length);
    const blend = (prior, anchor) => (anchor != null ? 0.5 * prior + 0.5 * anchor : prior);
    let prevAssigned = [null, null, null, null, null];
    for (let fi = 0; fi < frames.length; fi++) {
      const cands = frames[fi];
      const assigned = [null, null, null, null, null];
      if (cands && cands.length) {
        const used = new Array(cands.length).fill(false);
        for (let s = 0; s < SLOTS; s++) {
          const [lo, hi] = FORMANT_BANDS[s];
          const target = blend(FORMANT_PRIORS[s], prevAssigned[s]); // continuity pull
          const floor = (s > 0 && assigned[s - 1] != null) ? assigned[s - 1] + FORMANT_MINGAP : lo;
          let best = -1, bd = Infinity;
          for (let j = 0; j < cands.length; j++) {
            if (used[j]) continue;
            const f = cands[j].freq;
            if (f < lo || f > hi || f < floor) continue;
            const d = Math.abs(f - target);
            if (d < bd) { bd = d; best = j; }
          }
          if (best >= 0) { assigned[s] = cands[best].freq; used[best] = true; }
        }
      }
      assignedAll[fi] = assigned;
      prevAssigned = assigned.map((v, s) => (v != null ? v : prevAssigned[s]));
    }
    const W = 2;
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

  // ----------------------------------------------------------------------------
  // Vibrato-probe formant refinement.
  //
  // During vibrato, the harmonics sweep across frequency, so over one vibrato
  // period the set of (harmonic_freq, harmonic_amplitude) points densely samples
  // the vocal-tract envelope — defeating the harmonic-locking that wrecks plain
  // LPC at high f0. We accumulate those points across a window and fit a smooth
  // envelope, then read F1/F2 as its low-frequency peaks.
  //
  // Inputs:
  //   getFrame(i): Float64Array window for frame i (already extracted by caller)
  //   f0s[i]:      detected f0 (Hz) for frame i (from the pitch contour), or null
  //   sr:          sample rate of those frames
  //   nFrames:     number of frames
  //
  // Returns { f1, f2, coverage:boolean, maxGapHz, points, envelope }.
  // coverage=false means harmonics are too sparse (e.g. very high f0 with little
  // vibrato) to resolve F1/F2 between them — the caller MUST then keep its LPC
  // estimate. This makes the probe a strict refinement: never worse than LPC.
  // ----------------------------------------------------------------------------
  function vibratoProbeFormants(getFrame, f0s, sr, nFrames, opts) {
    opts = opts || {};
    const maxHarm = opts.maxHarm != null ? opts.maxHarm : 12;
    const fCeil = opts.fCeil != null ? opts.fCeil : 3500;
    // The widest harmonic gap (Hz) we tolerate below the F2 region. A formant
    // narrower than this could hide between samples → declare poor coverage.
    const maxGapTol = opts.maxGapTol != null ? opts.maxGapTol : 350;

    // Coverage is set by harmonic spacing (= f0), NOT by the scatter of collected
    // points: vibrato gives sub-bin precision on each harmonic but does not fill the
    // gaps BETWEEN harmonics. If the median f0 exceeds the tolerance, a formant can
    // hide between harmonics → bail out so the caller keeps its LPC estimate.
    const validF0 = f0s.filter(v => v && v > 0).sort((a, b) => a - b);
    if (validF0.length < 8) return { f1: null, f2: null, coverage: false, maxGapHz: Infinity, points: [], envelope: [] };
    const medF0 = validF0[validF0.length >> 1];
    const maxGapHz = medF0;
    if (medF0 > maxGapTol) return { f1: null, f2: null, coverage: false, maxGapHz, points: [], envelope: [] };

    // Collect (harmonic_freq, amplitude_dB) points, but only from frames whose f0 is
    // near the median (rejects octave/garbage f0 estimates that would seed phantom
    // points at the wrong frequencies).
    const pts = []; // {hz, db}
    for (let fi = 0; fi < nFrames; fi++) {
      const f0 = f0s[fi];
      if (!f0 || f0 <= 0 || Math.abs(f0 - medF0) > 0.25 * medF0) continue;
      const frame = getFrame(fi);
      if (!frame || frame.length < 64) continue;
      const N = nextPow2(frame.length);
      const re = new Float64Array(N), im = new Float64Array(N);
      const w = hann(frame.length);
      for (let i = 0; i < frame.length; i++) re[i] = frame[i] * w[i];
      fftRadix2(re, im);
      const binHz = sr / N;
      const search = Math.max(1, Math.round((f0 * 0.10) / binHz));
      for (let k = 1; k <= maxHarm; k++) {
        const target = k * f0;
        if (target > fCeil) break;
        const c = Math.round(target / binHz);
        let best = -Infinity, bestBin = c;
        for (let b = c - search; b <= c + search; b++) {
          if (b < 1 || b >= (N >> 1)) continue;
          const mag = re[b] * re[b] + im[b] * im[b];
          if (mag > best) { best = mag; bestBin = b; }
        }
        if (best > 0) pts.push({ hz: bestBin * binHz, db: 10 * Math.log10(best + 1e-12) });
      }
    }
    if (pts.length < 8) return { f1: null, f2: null, coverage: false, maxGapHz, points: pts, envelope: [] };
    pts.sort((a, b) => a.hz - b.hz);

    // Remove the glottal source spectral tilt: regress dB against log2(Hz) and
    // subtract. Without this the lowest harmonics (always the loudest, ~-12dB/oct
    // source slope) masquerade as an "F1 peak". The tilt-removed residual exposes
    // the vocal-tract resonances as genuine local maxima.
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const p of pts) { const lx = Math.log2(p.hz); sx += lx; sy += p.db; sxx += lx * lx; sxy += lx * p.db; }
    const np = pts.length, den = np * sxx - sx * sx;
    const slope = Math.abs(den) > 1e-9 ? (np * sxy - sx * sy) / den : 0;
    const icpt = (sy - slope * sx) / np;
    for (const p of pts) p.res = p.db - (slope * Math.log2(p.hz) + icpt);

    // Bin the residual onto a coarse grid (per-bin max), fill gaps, light smoothing.
    const GRID = 60; // Hz
    const nBins = Math.ceil(fCeil / GRID) + 1;
    const gridMax = new Float64Array(nBins).fill(-Infinity);
    for (const p of pts) { const gi = Math.round(p.hz / GRID); if (gi >= 0 && gi < nBins && p.res > gridMax[gi]) gridMax[gi] = p.res; }
    let last = 0;
    for (let i = 0; i < nBins; i++) { if (gridMax[i] === -Infinity) gridMax[i] = last; else last = gridMax[i]; }
    last = gridMax[nBins - 1];
    for (let i = nBins - 1; i >= 0; i--) { if (gridMax[i] === -Infinity) gridMax[i] = last; else last = gridMax[i]; }
    const env = new Float64Array(nBins);
    for (let i = 0; i < nBins; i++) {
      let s = 0, c = 0;
      for (let d = -1; d <= 1; d++) { const j = i + d; if (j >= 0 && j < nBins) { s += gridMax[j]; c++; } }
      env[i] = c ? s / c : gridMax[i];
    }
    const peaks = [];
    for (let i = 1; i < nBins - 1; i++) {
      if (env[i] >= env[i - 1] && env[i] > env[i + 1]) peaks.push({ hz: i * GRID, db: env[i] });
    }
    const envelope = [];
    for (let i = 0; i < nBins; i++) envelope.push({ hz: i * GRID, db: env[i] });
    // F1 and F2 are both strong resonances, so picking the GLOBALLY strongest peak in
    // the F1 band can grab F2 when it bleeds in (F1/F2 bands overlap for /u/,/ɑ/).
    // Instead take the LOWEST peak that is "significant" — within 12 dB of the
    // strongest peak — as F1, then the next significant peak as F2.
    let maxDb = -Infinity;
    for (const pk of peaks) if (pk.db > maxDb) maxDb = pk.db;
    const sig = peaks.filter(pk => pk.db >= maxDb - 12).sort((a, b) => a.hz - b.hz);
    let f1 = null, f2 = null;
    for (const pk of sig) { if (pk.hz >= 250 && pk.hz <= 1200) { f1 = pk.hz; break; } }
    const f2lo = f1 != null ? f1 + 250 : 800;
    for (const pk of sig) { if (pk.hz >= f2lo && pk.hz <= 3000) { f2 = pk.hz; break; } }
    return { f1, f2, coverage: true, maxGapHz, points: pts, envelope };
  }

  // ----------------------------------------------------------------------------
  // Test-signal synthesis (used by the validation harness; harmless in browser).
  // Source-filter vowel: glottal pulse train (Rosenberg) → cascade formant
  // resonators → optional aspiration noise. Returns Float32Array at sr.
  // ----------------------------------------------------------------------------
  function synthVowel(opts) {
    const sr = opts.sr || 44100;
    const dur = opts.dur || 0.5;
    const f0 = opts.f0 || 150;
    const formants = opts.formants || [700, 1220, 2600, 3400, 4500];
    const bws = opts.bandwidths || formants.map((f, i) => [60, 90, 120, 150, 200][i] || 150);
    const oq = opts.oq != null ? opts.oq : 0.6;     // open quotient of the Rosenberg pulse
    const aspiration = opts.aspiration != null ? opts.aspiration : 0; // 0..1 noise mix
    const vibratoExtent = opts.vibratoExtent != null ? opts.vibratoExtent : 0; // cents
    const vibratoRate = opts.vibratoRate != null ? opts.vibratoRate : 5.5;
    const seed = opts.seed != null ? opts.seed : 12345;
    const n = Math.floor(sr * dur);

    // Rosenberg glottal flow pulse generator with instantaneous-phase tracking.
    let phase = 0;
    const Tp = oq * 0.7, Tn = oq * 0.3; // rise/fall fractions of the open phase
    const rosenberg = (ph) => {
      // ph in [0,1): open phase [0, oq), closed [oq,1)
      if (ph < Tp) { const t = ph / Tp; return 0.5 * (1 - Math.cos(Math.PI * t)); }
      if (ph < Tp + Tn) { const t = (ph - Tp) / Tn; return Math.cos(Math.PI * t * 0.5); }
      return 0;
    };

    // simple LCG noise
    let s = seed >>> 0;
    const rand = () => { s = (1664525 * s + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };

    const src = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const vib = vibratoExtent ? Math.pow(2, (vibratoExtent / 1200) * Math.sin(2 * Math.PI * vibratoRate * t)) : 1;
      const fInst = f0 * vib;
      phase += fInst / sr;
      if (phase >= 1) phase -= 1;
      let v = rosenberg(phase);
      src[i] = v + aspiration * 0.15 * rand();
    }
    // differentiate once to get the glottal-flow derivative (radiation at lips ≈ +6dB/oct)
    const dsrc = new Float64Array(n);
    for (let i = 1; i < n; i++) dsrc[i] = src[i] - src[i - 1];

    // cascade resonators
    let buf = dsrc;
    for (let fi = 0; fi < formants.length; fi++) {
      const F = formants[fi], B = bws[fi];
      const r = Math.exp(-Math.PI * B / sr);
      const c = 2 * r * Math.cos(2 * Math.PI * F / sr);
      const a2 = -r * r;
      const gain = 1 - c - a2; // unity at DC
      const out = new Float64Array(n);
      let y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const y = gain * buf[i] + c * y1 + a2 * y2;
        out[i] = y; y2 = y1; y1 = y;
      }
      buf = out;
    }
    // normalize to ~0.5 peak
    let peak = 1e-9;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
    const outF = new Float32Array(n);
    const g = 0.5 / peak;
    for (let i = 0; i < n; i++) outF[i] = buf[i] * g;
    return outF;
  }

  const api = {
    fftRadix2, nextPow2, hann,
    burgLPC, durandKerner, lpcFormants, decimate,
    yin, cpps, h1h2, iaifGlottal, autocorrF0, estimateOpenQuotient,
    yinCandidates, viterbiPitchPath, pitchContour, octaveSnap,
    offlineFormants, trackAndSmooth, vibratoProbeFormants,
    synthVowel,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    // Browser: expose as a namespace AND hoist key fns to globals for main.js.
    root.DSP = api;
    for (const k in api) if (!(k in root)) root[k] = api[k];
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
