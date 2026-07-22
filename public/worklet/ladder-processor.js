// Filtre passe-bas "diode ladder" type TB-303 — AudioWorklet.
// 4 étages one-pole en topologie TPT (transposed direct form II), feedback de
// résonance sur le dernier étage avec saturation tanh à l'entrée : c'est la
// non-linéarité qui donne le "squelch" du 303, absente des biquads natifs.
// La boucle de feedback a un retard d'un sample — l'instabilité résiduelle à
// haute résonance fait partie du caractère (self-oscillation vers res ≈ 1).

class LadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "cutoff", defaultValue: 500, minValue: 20, maxValue: 12000, automationRate: "a-rate" },
      { name: "resonance", defaultValue: 0, minValue: 0, maxValue: 1.1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.s1 = 0;
    this.s2 = 0;
    this.s3 = 0;
    this.s4 = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];
    const inCh = input && input[0] ? input[0] : null;

    const cutoff = parameters.cutoff;
    const res = parameters.resonance[0];
    const k = res * 4.3; // ≥4 : auto-oscillation
    const nyqGuard = sampleRate * 0.45;

    let { s1, s2, s3, s4 } = this;

    for (let i = 0; i < out.length; i++) {
      const fc = cutoff.length > 1 ? cutoff[i] : cutoff[0];
      const g = Math.tan((Math.PI * Math.min(fc, nyqGuard)) / sampleRate);
      const G = g / (1 + g);

      const xin = inCh ? inCh[i] : 0;
      // entrée + feedback saturés ensemble (comportement diode)
      const x = Math.tanh(xin * 0.9 - k * s4);

      let v = (x - s1) * G;
      const y1 = v + s1;
      s1 = y1 + v;
      v = (y1 - s2) * G;
      const y2 = v + s2;
      s2 = y2 + v;
      v = (y2 - s3) * G;
      const y3 = v + s3;
      s3 = y3 + v;
      v = (y3 - s4) * G;
      const y4 = v + s4;
      s4 = y4 + v;

      // compensation de gain quand la résonance mange les basses
      out[i] = y4 * (1 + k * 0.45);
    }

    this.s1 = s1;
    this.s2 = s2;
    this.s3 = s3;
    this.s4 = s4;

    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor("ladder-filter", LadderProcessor);
