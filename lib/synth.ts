// Moteur de synthèse type TB-303 pour le TD-3-SR virtuel.
// Chaîne : VCO (saw/square) -> VCF passe-bas résonant (2 biquads cascadés,
// ~24 dB/oct comme le vrai) -> VCA -> distortion (waveshaper type DS-1) -> master.
// Le séquenceur utilise le pattern lookahead standard Web Audio (timer JS qui
// planifie les notes en avance sur l'horloge audio) pour un timing sans jitter.

export type Waveform = "sawtooth" | "square";

export interface Step {
  note: number; // MIDI (C1 = 24 ... C3 = 48 zone 303)
  gate: boolean;
  accent: boolean;
  slide: boolean;
}

export interface Pattern {
  steps: Step[];
  length: number;
}

export const NUM_STEPS = 16;
export const NUM_PATTERNS = 8;

export function defaultStep(): Step {
  return { note: 36, gate: false, accent: false, slide: false };
}

export function defaultPattern(): Pattern {
  return { steps: Array.from({ length: NUM_STEPS }, defaultStep), length: NUM_STEPS };
}

// Pattern de démo — ligne acid classique en Cm
export function demoPattern(): Pattern {
  const p = defaultPattern();
  const set = (i: number, note: number, opts: Partial<Step> = {}) => {
    p.steps[i] = { note, gate: true, accent: false, slide: false, ...opts };
  };
  set(0, 36, { accent: true });
  set(2, 36);
  set(3, 48, { slide: true });
  set(4, 46);
  set(6, 36);
  set(7, 39, { accent: true });
  set(8, 36);
  set(10, 43, { slide: true });
  set(11, 41);
  set(12, 36, { accent: true });
  set(14, 34);
  set(15, 36, { slide: true });
  return p;
}

export interface SynthParams {
  tuning: number; // 0..1, ±6 demi-tons
  cutoff: number; // 0..1
  resonance: number; // 0..1
  envMod: number; // 0..1
  decay: number; // 0..1
  accent: number; // 0..1
  volume: number; // 0..1
  waveform: Waveform;
  distortion: boolean;
  tempo: number; // BPM
}

export const defaultParams: SynthParams = {
  tuning: 0.5,
  cutoff: 0.45,
  resonance: 0.55,
  envMod: 0.55,
  decay: 0.4,
  accent: 0.6,
  volume: 0.8,
  waveform: "sawtooth",
  distortion: false,
  tempo: 130,
};

function midiToFreq(note: number, tuning: number): number {
  const detune = (tuning - 0.5) * 12; // ±6 demi-tons
  return 440 * Math.pow(2, (note + detune - 69) / 12);
}

// Réponse du "CUT OFF" : ~65 Hz à ~4,8 kHz, exponentiel comme le vrai potard
function cutoffHz(v: number): number {
  return 65 * Math.pow(2, v * 6.2);
}

function makeDistortionCurve(amount: number): Float32Array {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = amount;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

export class TD3Engine {
  ctx: AudioContext | null = null;
  private osc: OscillatorNode | null = null;
  private filter1: BiquadFilterNode | null = null;
  private filter2: BiquadFilterNode | null = null;
  private vca: GainNode | null = null;
  private accentGain: GainNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private distWet: GainNode | null = null;
  private distDry: GainNode | null = null;
  private master: GainNode | null = null;
  analyser: AnalyserNode | null = null;

  params: SynthParams = { ...defaultParams };
  patterns: Pattern[] = Array.from({ length: NUM_PATTERNS }, defaultPattern);
  currentPattern = 0;

  // mode TRACK : chaîne de patterns jouée en boucle
  track: number[] = [];
  trackMode = false;
  private trackPos = 0;

  // état transport
  playing = false;
  private schedulerTimer: number | null = null;
  private nextNoteTime = 0;
  private currentStep = 0;
  private lastFreq: number | null = null;
  private prevStepHadSlide = false;

  onStep: ((step: number) => void) | null = null;

  get isReady() {
    return this.ctx !== null;
  }

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;

    this.osc = ctx.createOscillator();
    this.osc.type = this.params.waveform;
    this.osc.frequency.value = 110;

    this.filter1 = ctx.createBiquadFilter();
    this.filter2 = ctx.createBiquadFilter();
    for (const f of [this.filter1, this.filter2]) {
      f.type = "lowpass";
      f.frequency.value = cutoffHz(this.params.cutoff);
    }
    // la résonance vit surtout sur le 2e pôle, comme la cascade diode du 303
    this.filter1.Q.value = 0.5;

    this.vca = ctx.createGain();
    this.vca.gain.value = 0;

    this.accentGain = ctx.createGain();
    this.accentGain.gain.value = 1;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeDistortionCurve(12) as Float32Array<ArrayBuffer>;
    this.shaper.oversample = "4x";
    this.distWet = ctx.createGain();
    this.distDry = ctx.createGain();
    this.setDistortion(this.params.distortion);

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume * 0.5;

    this.osc.connect(this.filter1);
    this.filter1.connect(this.filter2);
    this.filter2.connect(this.vca);
    this.vca.connect(this.accentGain);
    // dry/wet distortion
    this.accentGain.connect(this.distDry);
    this.accentGain.connect(this.shaper);
    this.shaper.connect(this.distWet);
    this.distDry.connect(this.master);
    this.distWet.connect(this.master);
    this.master.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);

    this.osc.start();
    this.applyParams();
  }

  resume() {
    this.ctx?.resume();
  }

  setParam<K extends keyof SynthParams>(key: K, value: SynthParams[K]) {
    this.params[key] = value;
    this.applyParams();
  }

  private applyParams() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.osc && this.osc.type !== this.params.waveform) this.osc.type = this.params.waveform;
    if (this.master) this.master.gain.setTargetAtTime(this.params.volume * 0.5, t, 0.01);
    if (this.filter2) {
      // Q de 0.7 à ~20 : auto-oscillation perceptible à fond, comme le vrai
      this.filter2.Q.setTargetAtTime(0.7 + this.params.resonance * 19, t, 0.01);
    }
    // le cutoff de base est réappliqué à chaque note (l'enveloppe le module),
    // mais on le pousse aussi hors des notes pour les tweaks à l'arrêt
    if (!this.playing && this.filter1 && this.filter2) {
      const fc = cutoffHz(this.params.cutoff);
      this.filter1.frequency.setTargetAtTime(fc, t, 0.02);
      this.filter2.frequency.setTargetAtTime(fc, t, 0.02);
    }
  }

  setDistortion(on: boolean) {
    this.params.distortion = on;
    if (!this.distWet || !this.distDry || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.distWet.gain.setTargetAtTime(on ? 0.9 : 0, t, 0.005);
    this.distDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.005);
  }

  // ————— déclenchement d'une note (séquenceur ou clavier) —————
  private trigger(time: number, step: Step, slideFromPrev: boolean, stepDur: number) {
    if (!this.ctx || !this.osc || !this.filter1 || !this.filter2 || !this.vca || !this.accentGain)
      return;

    const p = this.params;
    const freq = midiToFreq(step.note, p.tuning);

    // pitch : slide = glissement exponentiel depuis la note précédente
    if (slideFromPrev && this.lastFreq !== null) {
      this.osc.frequency.setValueAtTime(this.lastFreq, time);
      this.osc.frequency.exponentialRampToValueAtTime(freq, time + stepDur * 0.9);
    } else {
      this.osc.frequency.setValueAtTime(freq, time);
    }
    this.lastFreq = freq;

    const accentAmt = step.accent ? p.accent : 0;

    // ————— enveloppe de filtre (MEG) —————
    const baseFc = cutoffHz(p.cutoff);
    const envAmt = p.envMod * (1 + accentAmt * 0.9);
    const peak = Math.min(baseFc * (1 + envAmt * 14), 12000);
    // accent = decay raccourci (le fameux "wow"), sinon DECAY 30 ms à 2 s
    const decayTime = step.accent ? 0.2 : 0.03 + Math.pow(p.decay, 1.8) * 1.97;

    for (const f of [this.filter1, this.filter2]) {
      f.frequency.cancelScheduledValues(time);
      f.frequency.setValueAtTime(Math.max(peak, 40), time);
      f.frequency.setTargetAtTime(baseFc, time + 0.003, decayTime / 3.5);
    }

    // ————— enveloppe d'ampli —————
    const g = this.vca.gain;
    if (!slideFromPrev) {
      g.cancelScheduledValues(time);
      g.setValueAtTime(0.0001, time);
      g.exponentialRampToValueAtTime(0.9, time + 0.004);
      // note normale : gate ~55 % du pas ; slide sortant géré par la note suivante
      if (!step.slide) {
        const gateEnd = time + stepDur * 0.55;
        g.setValueAtTime(0.9, gateEnd);
        g.exponentialRampToValueAtTime(0.0001, gateEnd + 0.012);
      }
    } else if (!step.slide) {
      const gateEnd = time + stepDur * 0.9;
      g.cancelScheduledValues(time + stepDur * 0.5);
      g.setValueAtTime(0.9, gateEnd);
      g.exponentialRampToValueAtTime(0.0001, gateEnd + 0.012);
    }

    // accent = boost de volume net
    this.accentGain.gain.setValueAtTime(1 + accentAmt * 0.8, time);
  }

  // note jouée au clavier (hors séquenceur)
  playNote(note: number) {
    this.init();
    this.resume();
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.001;
    this.trigger(t, { note, gate: true, accent: false, slide: false }, false, 0.3);
  }

  releaseNote() {
    if (!this.ctx || !this.vca) return;
    const t = this.ctx.currentTime;
    this.vca.gain.cancelScheduledValues(t);
    this.vca.gain.setTargetAtTime(0.0001, t, 0.02);
  }

  // ————— séquenceur —————
  start() {
    this.init();
    this.resume();
    if (!this.ctx || this.playing) return;
    this.playing = true;
    this.currentStep = 0;
    this.prevStepHadSlide = false;
    this.nextNoteTime = this.ctx.currentTime + 0.06;
    this.schedulerTimer = window.setInterval(() => this.scheduler(), 25);
  }

  stop() {
    this.playing = false;
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    if (this.ctx && this.vca) {
      const t = this.ctx.currentTime;
      this.vca.gain.cancelScheduledValues(t);
      this.vca.gain.setTargetAtTime(0.0001, t, 0.03);
    }
    this.onStep?.(-1);
  }

  toggle() {
    if (this.playing) this.stop();
    else this.start();
  }

  private scheduler() {
    if (!this.ctx) return;
    const lookahead = 0.12;
    while (this.nextNoteTime < this.ctx.currentTime + lookahead) {
      this.scheduleStep(this.currentStep, this.nextNoteTime);
      const pattern = this.patterns[this.currentPattern];
      const stepDur = 60 / this.params.tempo / 4; // double-croches
      this.nextNoteTime += stepDur;
      this.currentStep = (this.currentStep + 1) % pattern.length;
      if (this.currentStep === 0 && this.trackMode && this.track.length > 0) {
        this.trackPos = (this.trackPos + 1) % this.track.length;
        this.currentPattern = this.track[this.trackPos];
      }
    }
  }

  private scheduleStep(stepIndex: number, time: number) {
    if (!this.ctx) return;
    const pattern = this.patterns[this.currentPattern];
    const step = pattern.steps[stepIndex];
    const stepDur = 60 / this.params.tempo / 4;

    const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
    window.setTimeout(() => this.onStep?.(stepIndex), delay);

    if (step.gate) {
      this.trigger(time, step, this.prevStepHadSlide, stepDur);
      this.prevStepHadSlide = step.slide;
    } else {
      this.prevStepHadSlide = false;
    }
  }
}
