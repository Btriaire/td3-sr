"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Knob from "@/components/Knob";
import ModeDial, { type Mode } from "@/components/ModeDial";
import PatternDial from "@/components/PatternDial";
import {
  TD3Engine,
  defaultParams,
  defaultPattern,
  defaultStep,
  demoPattern,
  randomPattern,
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

// rangée de 13 interrupteurs (comme le vrai — pas de touches piano), un octave
// chromatique complet, offsets 0..12 depuis la racine
const NOTE_OFFSETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B", "C"];
const BASE_NOTE = 36; // C2
const GROUP_LABEL = ["I", "II", "III", "IV"];

// touches noires (C#/D#/F#/G#/A#) : double fonction avec FUNCTION, comme la
// sérigraphie DEL/INS/CH/CPY/PST sous les touches du vrai
const EDIT_FN_FOR_OFFSET: Record<number, "DEL" | "INS" | "CH" | "CPY" | "PST"> = {
  1: "DEL",
  3: "INS",
  6: "CH",
  8: "CPY",
  10: "PST",
};

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
  const [syncOn, setSyncOn] = useState(false);
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

  // FUNCTION + touche noire (C#/D#/F#/G#/A#) = DEL/INS/CH/CPY/PST sur le pas
  // sélectionné, comme sur la façade du vrai (sérigraphie sous les touches).
  const [stepClipboard, setStepClipboard] = useState<Step | null>(null);
  const performStepEdit = useCallback(
    (fn: "DEL" | "INS" | "CH" | "CPY" | "PST") => {
      setPatterns((ps) =>
        ps.map((p, i) => {
          if (i !== currentPattern) return p;
          const steps = [...p.steps];
          if (fn === "DEL") {
            steps.splice(selectedStep, 1);
            steps.push(defaultStep());
            return { ...p, steps, length: Math.max(1, p.length - 1) };
          }
          if (fn === "INS") {
            steps.splice(selectedStep, 0, defaultStep());
            steps.pop();
            return { ...p, steps, length: Math.min(NUM_STEPS, p.length + 1) };
          }
          if (fn === "CH") {
            steps[selectedStep] = { ...steps[selectedStep], accent: false, slide: false };
            return { ...p, steps };
          }
          if (fn === "CPY") {
            setStepClipboard(steps[selectedStep]);
            return p;
          }
          // PST
          if (stepClipboard) steps[selectedStep] = { ...stepClipboard };
          return { ...p, steps };
        }),
      );
      setFnActive(false);
    },
    [currentPattern, selectedStep, stepClipboard],
  );

  const onKeyPress = useCallback(
    (noteOffset: number) => {
      if (fnActive && EDIT_FN_FOR_OFFSET[noteOffset]) {
        performStepEdit(EDIT_FN_FOR_OFFSET[noteOffset]);
        return;
      }
      const note = BASE_NOTE + noteOffset + octaveShift * 12;
      setHeldKey(noteOffset);
      engine.playNote(note);
      if (mode === "patt-write") {
        updateStep(selectedStep, { note, gate: "note" });
        setSelectedStep((s) => (s + 1) % NUM_STEPS);
      }
    },
    [engine, mode, selectedStep, updateStep, octaveShift, fnActive, performStepEdit],
  );

  const onKeyRelease = useCallback(() => {
    setHeldKey(null);
    if (!engine.playing) engine.releaseNote();
  }, [engine]);

  // PATTERN GROUP (I-IV) : sélectionnable à tout moment, comme le sélecteur du vrai
  const onGroupBtn = useCallback((g: number) => setGroup(g), []);

  // boutons numérotés 1-8 (rotary) : sélection directe, ou ajout à la chaîne en TRACK WRITE
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

  const onRandomize = useCallback(() => {
    setPatterns((ps) =>
      ps.map((p, i) => (i === currentPattern ? randomPattern(p.length) : p)),
    );
  }, [currentPattern]);

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

  // LED des interrupteurs : note du pas joué en lecture, note du pas sélectionné en write
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
    ? "FUNCTION — clic pas = longueur du pattern · touches noires C♯/D♯/F♯/G♯/A♯ = DEL/INS/CH/CPY/PST sur le pas sélectionné"
    : writeMode
      ? `WRITE — pas ${selectedStep + 1} : interrupteur = note · re-clic pas = note→tie→rest · ACCENT/SLIDE = marquer`
      : mode === "track-write"
        ? "TRACK WRITE — GROUP/numéro puis ACCENT(A)/SLIDE(B), tapez le numéro pour ajouter à la chaîne, CLEAR pour vider"
        : "START/STOP pour lancer · clic pas = note/rest · ACCENT/SLIDE (hors write) = section A/B du pattern";

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

          {/* ————— bandeau continu de knobs, comme le vrai ————— */}
          <div className="knob-strip">
            <Knob label="TUNING" value={params.tuning} onChange={(v) => setP("tuning", v)} />
            <Knob label="CUT OFF" value={params.cutoff} onChange={(v) => setP("cutoff", v)} defaultValue={0.45} />
            <Knob label="RESONANCE" value={params.resonance} onChange={(v) => setP("resonance", v)} defaultValue={0.55} />
            <Knob label="ENV MOD" value={params.envMod} onChange={(v) => setP("envMod", v)} defaultValue={0.55} />
            <Knob label="DECAY" value={params.decay} onChange={(v) => setP("decay", v)} defaultValue={0.4} />
            <Knob label="ACCENT" value={params.accent} onChange={(v) => setP("accent", v)} defaultValue={0.6} />
            <div className="jack-row">
              {[
                ["FILTER", "IN", "▾"],
                ["SYNC", "IN", "▾"],
                ["CV", "OUT", "▴"],
                ["GATE", "OUT", "▴"],
                ["", "PHONES", "▴"],
              ].map(([l1, l2, arrow], i) => (
                <div key={i} className="jack">
                  <div className="jack-arrow">{arrow}</div>
                  <div className="jack-hole" />
                  <div className="jack-label">
                    {l1 && <span>{l1}</span>}
                    <span>{l2}</span>
                  </div>
                </div>
              ))}
            </div>
            <Knob label="DISTORTION" value={params.distDrive} onChange={(v) => setP("distDrive", v)} defaultValue={0.5} />
            <Knob label="TONE" value={params.distTone} onChange={(v) => setP("distTone", v)} defaultValue={0.5} />
            <Knob label="LEVEL" value={params.distLevel} onChange={(v) => setP("distLevel", v)} defaultValue={0.6} />
          </div>

          {/* ————— rangée sections : tempo / swing / waveform / pattern / mode / distortion / volume ————— */}
          <div className="row-mid">
            <div className="section sec-tempo">
              <div className="section-label">TEMPO</div>
              <Knob
                small
                label={`${params.tempo} BPM`}
                value={(params.tempo - 40) / 260}
                onChange={(v) => setP("tempo", Math.round(40 + v * 260))}
                defaultValue={(130 - 40) / 260}
              />
              <div className="tempo-range">SLOW · FAST</div>
            </div>

            <div className="section sec-swing">
              <div className="section-label">SWING</div>
              <Knob
                small
                label={`${Math.round(params.swing * 100)}%`}
                value={params.swing}
                onChange={(v) => setP("swing", v)}
                defaultValue={0}
              />
            </div>

            <div className="section sec-vco">
              <div className="section-label">WAVEFORM</div>
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
              </div>
            </div>

            <div className="section sec-pattern">
              <div className="section-label">
                TRACK / PATTERN GROUP — {mode === "track-write" ? "→ TRACK" : formatPatternIndex(currentPattern)}
              </div>
              <div className="pattern-dial-area">
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
                <PatternDial value={number} onChange={onNumberBtn} />
              </div>
              {mode.startsWith("track") && (
                <div className="chain-display">
                  CHAIN: {track.length ? track.map(formatPatternIndex).join(" · ") : "—"}
                </div>
              )}
            </div>

            <div className="section sec-mode">
              <div className="section-label">MODE</div>
              <ModeDial mode={mode} onChange={setMode} />
            </div>

            <div className="logo-block">
              <div className={`led${playing && playhead % 4 === 0 ? " on" : ""}`} />
              <div className="behringer-mini">behringer</div>
            </div>

            <div className="section sec-dist-switch">
              <div className="section-label">DISTORTION</div>
              <div
                className="hswitch"
                onClick={() => setP("distortion", !params.distortion)}
                role="switch"
                aria-checked={params.distortion}
                aria-label="Distortion on/off"
              >
                <span className={!params.distortion ? "on" : ""}>OFF</span>
                <span className={params.distortion ? "on" : ""}>ON</span>
                <div className="hswitch-thumb" style={{ left: params.distortion ? "50%" : "2px" }} />
              </div>
            </div>

            <div className="section sec-volume">
              <div className="section-label">VOLUME</div>
              <Knob
                label={`${Math.round(params.volume * 100)}%`}
                value={params.volume}
                onChange={(v) => setP("volume", v)}
                defaultValue={0.8}
              />
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

          {/* ————— rangée d'interrupteurs (notes) + fonctions ————— */}
          <div className="kb-row">
            <div className="note-switches">
              {NOTE_OFFSETS.map((off, i) => (
                <div key={off} className="switch-col">
                  <div className={`led${litKeyOff === off ? " on" : ""}`} />
                  <button
                    className={`rocker-switch${heldKey === off ? " down" : ""}`}
                    onPointerDown={() => onKeyPress(off)}
                    onPointerUp={onKeyRelease}
                    onPointerLeave={() => heldKey === off && onKeyRelease()}
                  />
                  <div className="rocker-label">{NOTE_NAMES[i]}</div>
                </div>
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
                className={`fn-key${writeMode ? (selStep.accent ? " lit" : "") : variant === 0 ? " lit" : ""}`}
                onClick={() =>
                  writeMode ? updateStep(selectedStep, { accent: !selStep.accent }) : setVariant(0)
                }
              >
                {writeMode ? "ACCENT" : "ACCENT · A"}
              </button>
              <button
                className={`fn-key${writeMode ? (selStep.slide ? " lit" : "") : variant === 1 ? " lit" : ""}`}
                onClick={() =>
                  writeMode ? updateStep(selectedStep, { slide: !selStep.slide }) : setVariant(1)
                }
              >
                {writeMode ? "SLIDE" : "SLIDE · B"}
              </button>
            </div>
          </div>

          {/* ————— rangée du bas : transport + fonctions ————— */}
          <div className="bottom-row">
            <div className="transport-cluster">
              <button className="push-btn" onClick={clearAction}>
                CLEAR
              </button>
              <button className={`push-btn run-btn${playing ? " lit" : ""}`} onClick={togglePlay}>
                {playing ? "■" : "▶"} START/STOP
              </button>
              <button className="push-btn rand-btn" onClick={onRandomize}>
                RAND
              </button>
            </div>
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
            <button className="push-btn" onClick={onTap}>
              TAP
            </button>
            <button className="push-btn" onClick={() => engine.restart()}>
              D.S.
            </button>
            <button
              className={`push-btn${syncOn ? " lit" : ""}`}
              onClick={() => setSyncOn((s) => !s)}
              title="Sync externe — décoratif, pas de MIDI dans cette édition web"
            >
              SYNC
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
