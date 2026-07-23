// Moteur de synthèse type TB-303 pour le TD-3-SR virtuel.
// Chaîne : VCO (saw/square) -> VCF diode-ladder (AudioWorklet, fallback 2
// biquads cascadés) -> VCA -> distortion (waveshaper tanh) -> master.
// Le séquenceur utilise le pattern lookahead standard Web Audio (timer JS qui
// planifie les notes en avance sur l'horloge audio) pour un timing sans jitter.
//
// Sémantique des pas, comme le vrai : "note" déclenche, "tie" prolonge la note
// précédente sans re-déclencher, "rest" = silence. Le slide (flag d'un pas
// note) glisse vers la note SUIVANTE en temps fixe (~60 ms, circuit RC du 303)
// et maintient le gate à travers la transition.

export type Waveform = "sawtooth" | "square";
export type Gate = "note" | "tie" | "rest";

export interface Step {
  note: number; // MIDI (C1 = 24 ... C3 = 48 zone 303)
  gate: Gate;
  accent: boolean;
  slide: boolean;
}

export interface Pattern {
  steps: Step[];
  length: number; // 1..16, comme le "STEP" du vrai
}

export const NUM_STEPS = 16;
// Comme le vrai : 4 groupes de patterns (I, II, III, IV), 8 numéros par
// groupe, chacun décliné en variante A et B → 64 patterns au total.
export const PATTERN_GROUPS = 4;
export const PATTERNS_PER_GROUP = 8;
export const NUM_PATTERNS = PATTERN_GROUPS * PATTERNS_PER_GROUP * 2;

export function patternIndex(group: number, number_: number, variant: 0 | 1): number {
  return group * PATTERNS_PER_GROUP * 2 + variant * PATTERNS_PER_GROUP + number_;
}

export function defaultStep(): Step {
  return { note: 36, gate: "rest", accent: false, slide: false };
}

export function defaultPattern(): Pattern {
  return { steps: Array.from({ length: NUM_STEPS }, defaultStep), length: NUM_STEPS };
}

// Pattern de démo — ligne acid classique en Cm, avec un tie et des slides
export function demoPattern(): Pattern {
  const p = defaultPattern();
  const set = (i: number, note: number, opts: Partial<Step> = {}) => {
    p.steps[i] = { note, gate: "note", accent: false, slide: false, ...opts };
  };
  set(0, 36, { accent: true });
  set(2, 36);
  set(3, 48, { slide: true });
  set(4, 46);
  set(6, 36);
  set(7, 39, { accent: true });
  set(8, 36);
  p.steps[9] = { note: 36, gate: "tie", accent: false, slide: false };
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
  distDrive: number; // 0..1
  distTone: number; // 0..1, sombre -> brillant
  distLevel: number; // 0..1
  tempo: number; // BPM
  triplet: boolean;
  swing: number; // 0..1, retarde les pas impairs (absent du vrai, ajout "web edition")
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
  distDrive: 0.5,
  distTone: 0.5,
  distLevel: 0.6,
  tempo: 130,
  triplet: false,
  swing: 0,
};

// Générateur de pattern acid plausible : root fréquent, quelques sauts
// d'octave/quinte, accents et slides occasionnels, rests pour respirer.
const SCALE_DEGREES = [0, 3, 5, 7, 10, 12]; // gamme mineure pentatonique-ish depuis la root
export function randomPattern(length = NUM_STEPS): Pattern {
  const root = 32 + Math.floor(Math.random() * 5); // grave, zone 303
  const steps: Step[] = Array.from({ length: NUM_STEPS }, () => defaultStep());
  for (let i = 0; i < NUM_STEPS; i++) {
    const r = Math.random();
    if (r < 0.28) {
      steps[i] = { ...defaultStep(), gate: "rest" };
    } else if (r < 0.36 && i > 0 && steps[i - 1].gate !== "rest") {
      steps[i] = { ...steps[i - 1], gate: "tie", accent: false, slide: false };
    } else {
      const degree = Math.random() < 0.55 ? 0 : SCALE_DEGREES[Math.floor(Math.random() * SCALE_DEGREES.length)];
      steps[i] = {
        note: root + degree,
        gate: "note",
        accent: Math.random() < 0.22,
        slide: Math.random() < 0.18,
      };
    }
  }
  return { steps, length };
}

function midiToFreq(note: number, tuning: number): number {
  const detune = (tuning - 0.5) * 12; // ±6 demi-tons
  return 440 * Math.pow(2, (note + detune - 69) / 12);
}

// Réponse du "CUT OFF" : ~65 Hz à ~4,8 kHz, exponentiel comme le vrai potard
function cutoffHz(v: number): number {
  return 65 * Math.pow(2, v * 6.2);
}

const SLIDE_TAU = 0.018; // constante RC ≈ 60 ms de glide perçu, indépendant du tempo

const TONE_CORNER_HZ = 900; // fréquence de coupure des deux filtres du tone stack

function driveToK(drive: number): number {
  return 3 + drive * 27; // pente tanh : douce à fond de dents-de-scie saturé
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
  ladder: AudioWorkletNode | null = null; // filtre principal (worklet)
  private filter1: BiquadFilterNode | null = null; // fallback
  private filter2: BiquadFilterNode | null = null;
  private vca: GainNode | null = null;
  private accentGain: GainNode | null = null;
  private shaper: WaveShaperNode | null = null;
  private toneLow: BiquadFilterNode | null = null; // tone stack type DS-1 : crossfade
  private toneHigh: BiquadFilterNode | null = null; // lowpass/highpass fixe autour de ~900 Hz
  private toneLowGain: GainNode | null = null;
  private toneHighGain: GainNode | null = null;
  private levelGain: GainNode | null = null;
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
  // circuit d'accent : les accents rapprochés chargent le "condensateur" et
  // amplifient le sweep — le fameux wow qui monte sur les accents répétés
  private accentSweep = 0;

  private initPromise: Promise<void> | null = null;

  onStep: ((step: number) => void) | null = null;

  get isReady() {
    return this.ctx !== null;
  }

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.buildGraph();
    return this.initPromise;
  }

  private async buildGraph() {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    this.ctx = ctx;

    this.osc = ctx.createOscillator();
    this.osc.type = this.params.waveform;
    this.osc.frequency.value = 110;

    // filtre : worklet diode-ladder, sinon 2 biquads cascadés
    let filterIn: AudioNode;
    let filterOut: AudioNode;
    try {
      await ctx.audioWorklet.addModule("/worklet/ladder-processor.js");
      this.ladder = new AudioWorkletNode(ctx, "ladder-filter", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      filterIn = this.ladder;
      filterOut = this.ladder;
    } catch {
      this.filter1 = ctx.createBiquadFilter();
      this.filter2 = ctx.createBiquadFilter();
      for (const f of [this.filter1, this.filter2]) {
        f.type = "lowpass";
        f.frequency.value = cutoffHz(this.params.cutoff);
      }
      this.filter1.Q.value = 0.5;
      this.filter1.connect(this.filter2);
      filterIn = this.filter1;
      filterOut = this.filter2;
    }

    this.vca = ctx.createGain();
    this.vca.gain.value = 0;

    this.accentGain = ctx.createGain();
    this.accentGain.gain.value = 1;

    // ————— distortion type DS-1 : drive (waveshaper) -> tone stack (crossfade
    // lowpass/highpass) -> level, en parallèle du bypass sec —————
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = makeDistortionCurve(driveToK(this.params.distDrive)) as Float32Array<ArrayBuffer>;
    this.shaper.oversample = "4x";
    this.toneLow = ctx.createBiquadFilter();
    this.toneLow.type = "lowpass";
    this.toneLow.frequency.value = TONE_CORNER_HZ;
    this.toneHigh = ctx.createBiquadFilter();
    this.toneHigh.type = "highpass";
    this.toneHigh.frequency.value = TONE_CORNER_HZ;
    this.toneLowGain = ctx.createGain();
    this.toneHighGain = ctx.createGain();
    this.levelGain = ctx.createGain();
    this.distWet = ctx.createGain();
    this.distDry = ctx.createGain();

    this.master = ctx.createGain();
    this.master.gain.value = this.params.volume * 0.5;

    this.osc.connect(filterIn);
    filterOut.connect(this.vca);
    this.vca.connect(this.accentGain);
    this.accentGain.connect(this.distDry);
    this.accentGain.connect(this.shaper);
    this.shaper.connect(this.toneLow);
    this.shaper.connect(this.toneHigh);
    this.toneLow.connect(this.toneLowGain);
    this.toneHigh.connect(this.toneHighGain);
    this.toneLowGain.connect(this.levelGain);
    this.toneHighGain.connect(this.levelGain);
    this.levelGain.connect(this.distWet);
    this.distDry.connect(this.master);
    this.distWet.connect(this.master);
    this.master.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);

    this.osc.start();
    this.setDistortion(this.params.distortion);
    this.applyDistortionTone();
    this.applyParams();
  }

  resume() {
    this.ctx?.resume();
  }

  private get cutoffParam(): AudioParam | null {
    return this.ladder ? this.ladder.parameters.get("cutoff") ?? null : null;
  }

  setParam<K extends keyof SynthParams>(key: K, value: SynthParams[K]) {
    this.params[key] = value;
    this.applyParams();
    if (key === "distDrive" || key === "distTone" || key === "distLevel") {
      this.applyDistortionTone();
    }
  }

  // DRIVE régénère la courbe du waveshaper (pente de saturation), TONE
  // crossfade à puissance égale entre le chemin lowpass et highpass fixes
  // (comme le potard tone d'une DS-1), LEVEL est le gain de sortie du wet.
  private applyDistortionTone() {
    if (!this.ctx || !this.shaper || !this.toneLowGain || !this.toneHighGain || !this.levelGain)
      return;
    const t = this.ctx.currentTime;
    this.shaper.curve = makeDistortionCurve(driveToK(this.params.distDrive)) as Float32Array<ArrayBuffer>;
    const tone = this.params.distTone;
    this.toneLowGain.gain.setTargetAtTime(Math.cos((tone * Math.PI) / 2), t, 0.01);
    this.toneHighGain.gain.setTargetAtTime(Math.sin((tone * Math.PI) / 2), t, 0.01);
    this.levelGain.gain.setTargetAtTime(0.3 + this.params.distLevel * 1.4, t, 0.01);
  }

  private applyParams() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (this.osc && this.osc.type !== this.params.waveform) this.osc.type = this.params.waveform;
    if (this.master) this.master.gain.setTargetAtTime(this.params.volume * 0.5, t, 0.01);

    if (this.ladder) {
      const resParam = this.ladder.parameters.get("resonance");
      resParam?.setTargetAtTime(this.params.resonance, t, 0.01);
    } else if (this.filter2) {
      this.filter2.Q.setTargetAtTime(0.7 + this.params.resonance * 19, t, 0.01);
    }

    // hors lecture, refléter le cutoff immédiatement pour les tweaks à l'arrêt
    if (!this.playing) {
      const fc = cutoffHz(this.params.cutoff);
      const p = this.cutoffParam;
      if (p) p.setTargetAtTime(fc, t, 0.02);
      else
        for (const f of [this.filter1, this.filter2])
          f?.frequency.setTargetAtTime(fc, t, 0.02);
    }
  }

  setDistortion(on: boolean) {
    this.params.distortion = on;
    if (!this.distWet || !this.distDry || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.distWet.gain.setTargetAtTime(on ? 0.9 : 0, t, 0.005);
    this.distDry.gain.setTargetAtTime(on ? 0 : 1, t, 0.005);
  }

  get stepDur(): number {
    // double-croches, ou triolets de croches (12 pas par mesure) en mode triplet
    return 60 / this.params.tempo / (this.params.triplet ? 3 : 4);
  }

  // ————— déclenchement d'une note (séquenceur ou clavier) —————
  // tiedSteps : nombre de pas "tie" qui suivent — prolonge le gate d'autant.
  private trigger(
    time: number,
    step: Step,
    slideFromPrev: boolean,
    stepDur: number,
    tiedSteps = 0,
  ) {
    if (!this.ctx || !this.osc || !this.vca || !this.accentGain) return;

    const p = this.params;
    const freq = midiToFreq(step.note, p.tuning);

    // pitch : slide = glide RC temps fixe depuis la note précédente
    this.osc.frequency.cancelScheduledValues(time);
    if (slideFromPrev && this.lastFreq !== null) {
      this.osc.frequency.setValueAtTime(this.lastFreq, time);
      this.osc.frequency.setTargetAtTime(freq, time, SLIDE_TAU);
    } else {
      this.osc.frequency.setValueAtTime(freq, time);
    }
    this.lastFreq = freq;

    // circuit d'accent : charge sur les accents rapprochés, décharge sinon
    if (step.accent) this.accentSweep = Math.min(1, this.accentSweep * 0.6 + 0.45);
    else this.accentSweep *= 0.5;
    const accentAmt = step.accent ? p.accent : 0;

    // ————— enveloppe de filtre (MEG) —————
    const baseFc = cutoffHz(p.cutoff);
    const envAmt = p.envMod * (1 + accentAmt * (0.7 + this.accentSweep * 0.8));
    const peak = Math.min(baseFc * (1 + envAmt * 14), 11000);
    // accent = decay raccourci (le fameux "wow"), sinon DECAY 30 ms à 2 s
    const decayTime = step.accent ? 0.2 : 0.03 + Math.pow(p.decay, 1.8) * 1.97;

    const cp = this.cutoffParam;
    if (cp) {
      cp.cancelScheduledValues(time);
      cp.setValueAtTime(Math.max(peak, 40), time);
      cp.setTargetAtTime(baseFc, time + 0.003, decayTime / 3.5);
    } else {
      for (const f of [this.filter1, this.filter2]) {
        if (!f) continue;
        f.frequency.cancelScheduledValues(time);
        f.frequency.setValueAtTime(Math.max(peak, 40), time);
        f.frequency.setTargetAtTime(baseFc, time + 0.003, decayTime / 3.5);
      }
    }

    // ————— enveloppe d'ampli —————
    const g = this.vca.gain;
    const gateLen = stepDur * (0.55 + tiedSteps); // les ties prolongent le gate
    if (!slideFromPrev) {
      g.cancelScheduledValues(time);
      g.setValueAtTime(0.0001, time);
      g.exponentialRampToValueAtTime(0.9, time + 0.004);
      if (!step.slide) {
        const gateEnd = time + gateLen;
        g.setValueAtTime(0.9, gateEnd);
        g.exponentialRampToValueAtTime(0.0001, gateEnd + 0.012);
      }
    } else if (!step.slide) {
      const gateEnd = time + stepDur * (0.9 + tiedSteps);
      g.cancelScheduledValues(time + stepDur * 0.5);
      g.setValueAtTime(0.9, gateEnd);
      g.exponentialRampToValueAtTime(0.0001, gateEnd + 0.012);
    }

    // accent = boost de volume net (plus le sweep chargé)
    this.accentGain.gain.setValueAtTime(1 + accentAmt * (0.6 + this.accentSweep * 0.4), time);
  }

  // note jouée au clavier (hors séquenceur)
  async playNote(note: number) {
    await this.init();
    this.resume();
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.001;
    this.trigger(t, { note, gate: "note", accent: false, slide: false }, false, 0.3);
  }

  releaseNote() {
    if (!this.ctx || !this.vca) return;
    const t = this.ctx.currentTime;
    this.vca.gain.cancelScheduledValues(t);
    this.vca.gain.setTargetAtTime(0.0001, t, 0.02);
  }

  // ————— séquenceur —————
  async start() {
    await this.init();
    this.resume();
    if (!this.ctx || this.playing) return;
    this.playing = true;
    this.currentStep = 0;
    this.trackPos = 0;
    this.prevStepHadSlide = false;
    this.accentSweep = 0;
    if (this.trackMode && this.track.length > 0) this.currentPattern = this.track[0];
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
      // swing : retarde les pas impairs, la grille elle-même reste stable
      // (pas de dérive cumulée) — absent du vrai, ajout "web edition"
      const swungTime =
        this.currentStep % 2 === 1
          ? this.nextNoteTime + this.params.swing * this.stepDur * 0.5
          : this.nextNoteTime;
      this.scheduleStep(this.currentStep, swungTime);
      const pattern = this.patterns[this.currentPattern];
      this.nextNoteTime += this.stepDur;
      this.currentStep = (this.currentStep + 1) % Math.max(1, pattern.length);
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
    const stepDur = this.stepDur;

    const delay = Math.max(0, (time - this.ctx.currentTime) * 1000);
    window.setTimeout(() => this.onStep?.(stepIndex), delay);

    if (step.gate === "note") {
      // compter les ties qui suivent pour prolonger le gate
      let ties = 0;
      for (let j = 1; j < pattern.length; j++) {
        if (pattern.steps[(stepIndex + j) % pattern.length].gate === "tie") ties++;
        else break;
      }
      this.trigger(time, step, this.prevStepHadSlide, stepDur, ties);
      this.prevStepHadSlide = step.slide;
    } else if (step.gate === "rest") {
      this.prevStepHadSlide = false;
    }
    // tie : rien à faire, le gate de la note précédente couvre déjà ce pas
  }
}
