"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Knob from "@/components/Knob";
import ModeDial, { type Mode } from "@/components/ModeDial";
import {
  TD3Engine,
  defaultParams,
  defaultPattern,
  demoPattern,
  patternIndex,
  PATTERN_GROUPS,
  PATTERNS_PER_GROUP,
  NUM_PATTERNS,
  NUM_STEPS,
  type Gate,
  type Pattern,
  type Step,
  type SynthParams,
} from "@/lib/synth";

// clavier une octave : offsets depuis C, position CSS des noires (%)
const WHITE_KEYS = [
  { off: 0, lbl: "C" },
  { off: 2, lbl: "D" },
  { off: 4, lbl: "E" },
  { off: 5, lbl: "F" },
  { off: 7, lbl: "G" },
  { off: 9, lbl: "A" },
  { off: 11, lbl: "B" },
  { off: 12, lbl: "C" },
];
const BLACK_KEYS = [
  { off: 1, pos: 12.5 },
  { off: 3, pos: 25 },
  { off: 6, pos: 50 },
  { off: 8, pos: 62.5 },
  { off: 10, pos: 75 },
];
// position horizontale (%) de la LED de chaque offset 0..12, alignée sur sa touche
const KEY_LED_POS: Record<number, number> = {
  0: 6.25, 2: 18.75, 4: 31.25, 5: 43.75, 7: 56.25, 9: 68.75, 11: 81.25, 12: 93.75,
  1: 12.5, 3: 25, 6: 50, 8: 62.5, 10: 75,
};
const BASE_NOTE = 36; // C2
const GROUP_LABEL = ["I", "II", "III", "IV"];

const STORAGE_KEY = "td3-sr-state-v3";
const OLD_STORAGE_KEY_V2 = "td3-sr-state-v2";
const OLD_STORAGE_KEY_V1 = "td3-sr-state-v1";

// migration v1 (gate booléen) -> v2/v3 (gate note|tie|rest)
function migratePattern(p: {
  length?: number;
  steps: Array<{ note: number; gate: Gate | boolean; accent: boolean; slide: boolean }>;
}): Pattern {
  return {
    length: p.length ?? NUM_STEPS,
    steps: p.steps.map((s) => ({
      note: s.note,
      accent: !!s.accent,
      slide: !!s.slide,
      gate: typeof s.gate === "string" ? s.gate : s.gate ? "note" : "rest",
    })),
  };
}

function formatPatternIndex(idx: number): string {
  const group = Math.floor(idx / (PATTERNS_PER_GROUP * 2));
  const rem = idx % (PATTERNS_PER_GROUP * 2);
  const variant = Math.floor(rem / PATTERNS_PER_GROUP);
  const number = rem % PATTERNS_PER_GROUP;
  return `${GROUP_LABEL[group]}-${number + 1}${variant === 0 ? "A" : "B"}`;
}

const nextGate: Record<Gate, Gate> = { note: "tie", tie: "rest", rest: "note" };

export default function TD3() {
  const engineRef = useRef<TD3Engine | null>(null);
  if (!engineRef.current) engineRef.current = new TD3Engine();
  const engine = engineRef.current;
  useEffect(() => {
    (window as unknown as { __td3: TD3Engine }).__td3 = engine;
  }, [engine]);

  const [params, setParams] = useState<SynthParams>({ ...defaultParams });
  const [patterns, setPatterns] = useState<Pattern[]>(() => {
    const arr = Array.from({ length: NUM_PATTERNS }, defaultPattern);
    arr[0] = demoPattern(); // groupe I, pattern 1A
    return arr;
  });
  // sélection de pattern : groupe (I-IV) + numéro (1-8) + variante (A/B), comme le vrai
  const [group, setGroup] = useState(0);
  const [number, setNumber] = useState(0);
  const [variant, setVariant] = useState<0 | 1>(0);
  const currentPattern = patternIndex(group, number, variant);

  const [mode, setMode] = useState<Mode>("patt-play");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [selectedStep, setSelectedStep] = useState(0);
  const [heldKey, setHeldKey] = useState<number | null>(null);
  const [track, setTrack] = useState<number[]>([]);
  const [octaveShift, setOctaveShift] = useState(0);
  const [fnActive, setFnActive] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // restauration localStorage (v3 direct, sinon migration depuis v2/v1)
  useEffect(() => {
    try {
      const rawV3 = localStorage.getItem(STORAGE_KEY);
      if (rawV3) {
        const s = JSON.parse(rawV3);
        if (s.params) setParams((p) => ({ ...p, ...s.params }));
        if (s.patterns) setPatterns(s.patterns.map(migratePattern));
        if (typeof s.group === "number") setGroup(s.group);
        if (typeof s.number === "number") setNumber(s.number);
        if (s.variant === 0 || s.variant === 1) setVariant(s.variant);
        if (Array.isArray(s.track)) setTrack(s.track);
      } else {
        const rawV2 = localStorage.getItem(OLD_STORAGE_KEY_V2);
        if (rawV2) {
          const s = JSON.parse(rawV2);
          if (s.params) setParams((p) => ({ ...p, ...s.params }));
          if (s.patterns) {
            // v2 avait 8 patterns -> deviennent groupe I, variante A, numéros 1-8
            const arr = Array.from({ length: NUM_PATTERNS }, defaultPattern);
            arr[0] = demoPattern();
            s.patterns.forEach((p: Parameters<typeof migratePattern>[0], i: number) => {
              arr[i] = migratePattern(p);
            });
            setPatterns(arr);
          }
          if (typeof s.currentPattern === "number") setNumber(s.currentPattern);
          if (Array.isArray(s.track)) setTrack(s.track);
        }
      }
      localStorage.removeItem(OLD_STORAGE_KEY_V1);
      localStorage.removeItem(OLD_STORAGE_KEY_V2);
    } catch {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ params, patterns, group, number, variant, track }),
        );
      } catch {}
    }, 300);
    return () => clearTimeout(id);
  }, [params, patterns, group, number, variant, track, loaded]);

  // sync moteur
  useEffect(() => {
    engine.params = { ...params };
    if (engine.isReady) {
      engine.setParam("volume", params.volume);
      engine.setDistortion(params.distortion);
    }
  }, [params, engine]);
  useEffect(() => {
    engine.patterns = patterns;
  }, [patterns, engine]);
  useEffect(() => {
    engine.currentPattern = currentPattern;
  }, [currentPattern, engine]);
  useEffect(() => {
    engine.track = track;
    engine.trackMode = mode === "track-play";
  }, [track, mode, engine]);
  useEffect(() => {
    engine.onStep = (s) => {
      setPlayhead(s);
      if (engine.trackMode) {
        const idx = engine.currentPattern;
        setGroup(Math.floor(idx / (PATTERNS_PER_GROUP * 2)));
        const rem = idx % (PATTERNS_PER_GROUP * 2);
        setVariant(Math.floor(rem / PATTERNS_PER_GROUP) as 0 | 1);
        setNumber(rem % PATTERNS_PER_GROUP);
      }
    };
    return () => {
      engine.onStep = null;
    };
  }, [engine]);

  const setP = useCallback(<K extends keyof SynthParams>(key: K, v: SynthParams[K]) => {
    setParams((p) => ({ ...p, [key]: v }));
  }, []);

  const togglePlay = useCallback(() => {
    engine.toggle();
    setPlaying(engine.playing);
    if (!engine.playing) setPlayhead(-1);
  }, [engine]);

  // ————— édition de pattern —————
  const updateStep = useCallback(
    (idx: number, patch: Partial<Step>) => {
      setPatterns((ps) =>
        ps.map((p, i) =>
          i === currentPattern
            ? { ...p, steps: p.steps.map((s, j) => (j === idx ? { ...s, ...patch } : s)) }
            : p,
        ),
      );
    },
    [currentPattern],
  );

  const setPatternLength = useCallback(
    (len: number) => {
      setPatterns((ps) =>
        ps.map((p, i) => (i === currentPattern ? { ...p, length: len } : p)),
      );
    },
    [currentPattern],
  );

  const onStepClick = useCallback(
    (idx: number) => {
      if (fnActive) {
        // FUNCTION + pas = longueur du pattern (le "STEP" du vrai)
        setPatternLength(idx + 1);
        setFnActive(false);
        return;
      }
      const cur = patterns[currentPattern].steps[idx];
      if (mode === "patt-write") {
        if (idx === selectedStep) updateStep(idx, { gate: nextGate[cur.gate] });
        setSelectedStep(idx);
      } else {
        updateStep(idx, { gate: cur.gate === "rest" ? "note" : "rest" });
      }
    },
    [fnActive, mode, selectedStep, updateStep, setPatternLength, patterns, currentPattern],
  );

  const onKeyPress = useCallback(
    (noteOffset: number) => {
      const note = BASE_NOTE + noteOffset + octaveShift * 12;
      setHeldKey(noteOffset);
      engine.playNote(note);
      if (mode === "patt-write") {
        updateStep(selectedStep, { note, gate: "note" });
        setSelectedStep((s) => (s + 1) % NUM_STEPS);
      }
    },
    [engine, mode, selectedStep, updateStep, octaveShift],
  );

  const onKeyRelease = useCallback(() => {
    setHeldKey(null);
    if (!engine.playing) engine.releaseNote();
  }, [engine]);

  // PATTERN GROUP (I-IV) : sélectionnable à tout moment, comme le sélecteur du vrai
  const onGroupBtn = useCallback((g: number) => setGroup(g), []);

  const onVariantToggle = useCallback(() => setVariant((v) => (v === 0 ? 1 : 0)), []);

  // boutons numérotés 1-8 : sélection directe, ou ajout à la chaîne en TRACK WRITE
  const onNumberBtn = useCallback(
    (i: number) => {
      if (mode === "track-write") setTrack((t) => [...t, patternIndex(group, i, variant)]);
      else setNumber(i);
    },
    [mode, group, variant],
  );

  const clearAction = useCallback(() => {
    if (mode === "track-write") setTrack([]);
    else setPatterns((ps) => ps.map((p, i) => (i === currentPattern ? defaultPattern() : p)));
  }, [mode, currentPattern]);

  const tapTempo = useRef<number[]>([]);
  const onTap = useCallback(() => {
    const now = performance.now();
    tapTempo.current = [...tapTempo.current.filter((t) => now - t < 3000), now];
    if (tapTempo.current.length >= 2) {
      const arr = tapTempo.current;
      const avg = (arr[arr.length - 1] - arr[0]) / (arr.length - 1);
      setP("tempo", Math.round(Math.min(300, Math.max(40, 60000 / avg))));
    }
  }, [setP]);

  const pattern = patterns[currentPattern];
  const selStep = pattern.steps[selectedStep];
  const writeMode = mode === "patt-write";

  // LED clavier : note du pas joué en lecture, note du pas sélectionné en write
  let litKeyOff: number | null = null;
  const ledStep =
    playing && playhead >= 0
      ? pattern.steps[playhead]
      : writeMode
        ? selStep
        : null;
  if (heldKey !== null) litKeyOff = heldKey;
  else if (ledStep && ledStep.gate === "note") {
    const off = ledStep.note - BASE_NOTE - octaveShift * 12;
    if (off >= 0 && off <= 12) litKeyOff = off;
  }

  const hint = fnActive
    ? "FUNCTION — cliquez un pas pour fixer la longueur du pattern (1–16)"
    : writeMode
      ? `WRITE — pas ${selectedStep + 1} : clavier = note · re-clic pas = note→tie→rest · ACCENT/SLIDE = marquer`
      : mode === "track-write"
        ? "TRACK WRITE — GROUP/numéro/A-B puis tapez le numéro pour ajouter à la chaîne, CLEAR pour vider"
        : "RUN pour lancer · clic pas = note/rest · TIME MODE = tie sur le pas sélectionné · FUNCTION+pas = longueur";

  return (
    <div className="stage">
      <div className="chassis">
        <div className="chassis-cap" />
        <div className="panel">
          <div className="screw tl" />
          <div className="screw tr" />
          <div className="screw bl" />
          <div className="screw br" />

          {/* ————— header ————— */}
          <div className="header">
            <div className="brand">
              <div className="behringer">BEHRINGER</div>
              <div className="subtitle">Analog Bass Line Synthesizer</div>
            </div>
            <div className="model">
              TD-3-SR <span>web edition</span>
            </div>
          </div>

          {/* ————— rangée knobs ————— */}
          <div className="row-top">
            <div className="section sec-vco">
              <div className="section-label">VCO</div>
              <div className="wave-unit">
                <div className="wave-icons">
                  <span>⎍</span>
                  <span>◺</span>
                </div>
                <div
                  className="slide-switch"
                  onClick={() =>
                    setP("waveform", params.waveform === "sawtooth" ? "square" : "sawtooth")
                  }
                  role="switch"
                  aria-checked={params.waveform === "square"}
                  aria-label="Waveform"
                >
                  <div
                    className="slide-thumb"
                    style={{ top: params.waveform === "square" ? 2 : 26 }}
                  />
                </div>
                <div className="knob-label">WAVEFORM</div>
              </div>
            </div>

            <div className="section sec-sound">
              <div className="section-label">SOUND</div>
              <div className="knob-row">
                <Knob label="TUNING" value={params.tuning} onChange={(v) => setP("tuning", v)} />
                <Knob label="CUT OFF" value={params.cutoff} onChange={(v) => setP("cutoff", v)} defaultValue={0.45} />
                <Knob label="RESONANCE" value={params.resonance} onChange={(v) => setP("resonance", v)} defaultValue={0.55} />
                <Knob label="ENV MOD" value={params.envMod} onChange={(v) => setP("envMod", v)} defaultValue={0.55} />
                <Knob label="DECAY" value={params.decay} onChange={(v) => setP("decay", v)} defaultValue={0.4} />
                <Knob label="ACCENT" value={params.accent} onChange={(v) => setP("accent", v)} defaultValue={0.6} />
                <Knob label="VOLUME" value={params.volume} onChange={(v) => setP("volume", v)} defaultValue={0.8} />
              </div>
            </div>

            <div className="section sec-dist">
              <div className="section-label">DISTORTION</div>
              <div className="dist-knobs">
                <Knob small label="DRIVE" value={params.distDrive} onChange={(v) => setP("distDrive", v)} defaultValue={0.5} />
                <Knob small label="TONE" value={params.distTone} onChange={(v) => setP("distTone", v)} defaultValue={0.5} />
                <Knob small label="LEVEL" value={params.distLevel} onChange={(v) => setP("distLevel", v)} defaultValue={0.6} />
              </div>
              <div className="dist-footer">
                <div className={`led${params.distortion ? " on" : ""}`} />
                <button
                  className={`push-btn${params.distortion ? " lit" : ""}`}
                  onClick={() => setP("distortion", !params.distortion)}
                >
                  ON
                </button>
              </div>
            </div>
          </div>

          {/* ————— rangée mode / tempo / transport ————— */}
          <div className="row-mid">
            <div className="section sec-mode">
              <div className="section-label">MODE</div>
              <ModeDial mode={mode} onChange={setMode} />
            </div>

            <div className="section sec-pattern">
              <div className="section-label">
                PATTERN {mode === "track-write" ? "→ TRACK" : formatPatternIndex(currentPattern)}
              </div>
              <div className="pattern-selectors">
                <div className="group-btns">
                  {GROUP_LABEL.map((label, g) => (
                    <button
                      key={label}
                      className={`group-btn${group === g ? " active" : ""}`}
                      onClick={() => onGroupBtn(g)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="patt-btns">
                  {Array.from({ length: PATTERNS_PER_GROUP }, (_, i) => (
                    <button
                      key={i}
                      className={`patt-btn${number === i ? " active" : ""}`}
                      onClick={() => onNumberBtn(i)}
                    >
                      {i + 1}
                    </button>
                  ))}
                </div>
                <button
                  className={`ab-toggle${variant === 1 ? " b" : ""}`}
                  onClick={onVariantToggle}
                  aria-label="Pattern A/B"
                >
                  <span className={variant === 0 ? "on" : ""}>A</span>
                  <span className={variant === 1 ? "on" : ""}>B</span>
                </button>
              </div>
              {mode.startsWith("track") && (
                <div className="chain-display">
                  CHAIN: {track.length ? track.map(formatPatternIndex).join(" · ") : "—"}
                </div>
              )}
            </div>

            <div className="section sec-tempo">
              <div className="section-label">TEMPO</div>
              <div className="tempo-knob-col">
                <div className={`led${playing && playhead % 4 === 0 ? " on" : ""}`} />
                <Knob
                  small
                  label={`${params.tempo} BPM`}
                  value={(params.tempo - 40) / 260}
                  onChange={(v) => setP("tempo", Math.round(40 + v * 260))}
                  defaultValue={(130 - 40) / 260}
                />
              </div>
              <button className={`push-btn run-btn${playing ? " lit" : ""}`} onClick={togglePlay}>
                {playing ? "■ STOP" : "▶ RUN"}
              </button>
              <button className="push-btn" onClick={onTap}>
                TAP
              </button>
            </div>
          </div>

          {/* ————— step strip ————— */}
          <div className="step-strip">
            {pattern.steps.map((s, i) => (
              <div
                key={i}
                className={`step-cell${writeMode && selectedStep === i ? " selected" : ""}${i >= pattern.length ? " beyond" : ""}`}
                onClick={() => onStepClick(i)}
              >
                <div className="step-num">{i + 1}</div>
                <div
                  className={`led${playhead === i ? " on" : ""}`}
                  style={
                    s.gate === "note" && playhead !== i
                      ? {
                          background:
                            "radial-gradient(circle at 40% 35%, #e0705a, #a03318)",
                          boxShadow: "0 0 4px rgba(255,80,30,0.45)",
                        }
                      : undefined
                  }
                />
                <div className="step-flags">
                  {s.gate === "tie" && <div className="step-flag tie" />}
                  {s.accent && <div className="step-flag accent" />}
                  {s.slide && <div className="step-flag slide" />}
                </div>
              </div>
            ))}
          </div>

          {/* ————— clavier + touches fonction ————— */}
          <div className="kb-row">
            <div className="kb-main">
              <div className="key-leds">
                {Object.entries(KEY_LED_POS).map(([off, pos]) => (
                  <div
                    key={off}
                    className={`led${litKeyOff === Number(off) ? " on" : ""}`}
                    style={{ left: `${pos}%` }}
                  />
                ))}
              </div>
              {WHITE_KEYS.map((k, i) => (
                <div
                  key={i}
                  className={`key-white${heldKey === k.off ? " down" : ""}`}
                  onPointerDown={() => onKeyPress(k.off)}
                  onPointerUp={onKeyRelease}
                  onPointerLeave={() => heldKey === k.off && onKeyRelease()}
                >
                  {k.lbl}
                </div>
              ))}
              {BLACK_KEYS.map((k, i) => (
                <div
                  key={i}
                  className={`key-black${heldKey === k.off ? " down" : ""}`}
                  style={{ left: `${k.pos}%` }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    onKeyPress(k.off);
                  }}
                  onPointerUp={onKeyRelease}
                />
              ))}
            </div>
            <div className="fn-keys">
              <button
                className="fn-key"
                onClick={() => setOctaveShift((o) => Math.max(-1, o - 1))}
                style={octaveShift < 0 ? { color: "#ffb59e" } : undefined}
              >
                DOWN
              </button>
              <button
                className="fn-key"
                onClick={() => setOctaveShift((o) => Math.min(1, o + 1))}
                style={octaveShift > 0 ? { color: "#ffb59e" } : undefined}
              >
                UP
              </button>
              <button
                className={`fn-key${writeMode && selStep.accent ? " lit" : ""}`}
                onClick={() => writeMode && updateStep(selectedStep, { accent: !selStep.accent })}
              >
                ACCENT
              </button>
              <button
                className={`fn-key${writeMode && selStep.slide ? " lit" : ""}`}
                onClick={() => writeMode && updateStep(selectedStep, { slide: !selStep.slide })}
              >
                SLIDE
              </button>
            </div>
          </div>

          {/* ————— rangée fonctions ————— */}
          <div className="bottom-row">
            <button
              className={`push-btn${writeMode ? " lit" : ""}`}
              onClick={() => setMode(writeMode ? "patt-play" : "patt-write")}
            >
              PITCH MODE
            </button>
            <button
              className="push-btn"
              onClick={() => updateStep(selectedStep, { gate: nextGate[selStep.gate] })}
            >
              TIME MODE
            </button>
            <button
              className="push-btn"
              onClick={() => setSelectedStep((s) => (s - 1 + NUM_STEPS) % NUM_STEPS)}
            >
              BACK
            </button>
            <button
              className="push-btn"
              onClick={() => setSelectedStep((s) => (s + 1) % NUM_STEPS)}
            >
              WRITE / NEXT
            </button>
            <button
              className={`push-btn${fnActive ? " lit" : ""}`}
              onClick={() => setFnActive((f) => !f)}
            >
              FUNCTION
            </button>
            <button
              className={`push-btn${params.triplet ? " lit" : ""}`}
              onClick={() => setP("triplet", !params.triplet)}
            >
              TRIPLET
            </button>
            <button className="push-btn" onClick={clearAction}>
              CLEAR
            </button>
            <div className="spacer" />
            <div style={{ fontSize: 8.5, color: "#4a4c4f", fontWeight: 600, letterSpacing: 0.5 }}>
              STEP {pattern.length} · 16-STEP SEQUENCER · VCO · VCF · VCA
            </div>
          </div>

          <div className="hint">{hint}</div>
        </div>
        <div className="chassis-cap" />
      </div>
    </div>
  );
}
