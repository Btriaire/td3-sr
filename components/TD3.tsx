"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Knob from "@/components/Knob";
import {
  TD3Engine,
  defaultParams,
  defaultPattern,
  demoPattern,
  NUM_PATTERNS,
  NUM_STEPS,
  type Pattern,
  type SynthParams,
} from "@/lib/synth";

type Mode = "patt-play" | "patt-write" | "track-play" | "track-write";

const MODES: { id: Mode; label: string }[] = [
  { id: "patt-play", label: "PATTERN PLAY" },
  { id: "patt-write", label: "PATTERN WRITE" },
  { id: "track-play", label: "TRACK PLAY" },
  { id: "track-write", label: "TRACK WRITE" },
];

// clavier une octave : offsets depuis C, isBlack, position CSS des noires (%)
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
const BASE_NOTE = 36; // C2

const STORAGE_KEY = "td3-sr-state-v1";

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
    arr[0] = demoPattern();
    return arr;
  });
  const [currentPattern, setCurrentPattern] = useState(0);
  const [mode, setMode] = useState<Mode>("patt-play");
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(-1);
  const [selectedStep, setSelectedStep] = useState(0);
  const [heldKey, setHeldKey] = useState<number | null>(null);
  const [track, setTrack] = useState<number[]>([]);
  const [octaveShift, setOctaveShift] = useState(0);
  const [loaded, setLoaded] = useState(false);

  // restauration localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.params) setParams((p) => ({ ...p, ...s.params }));
        if (s.patterns) setPatterns(s.patterns);
        if (typeof s.currentPattern === "number") setCurrentPattern(s.currentPattern);
        if (Array.isArray(s.track)) setTrack(s.track);
      }
    } catch {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const id = setTimeout(() => {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ params, patterns, currentPattern, track }),
        );
      } catch {}
    }, 300);
    return () => clearTimeout(id);
  }, [params, patterns, currentPattern, track, loaded]);

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
      if (engine.trackMode) setCurrentPattern(engine.currentPattern);
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
    (idx: number, patch: Partial<Pattern["steps"][number]>) => {
      setPatterns((ps) => {
        const next = ps.map((p, i) =>
          i === currentPattern
            ? { ...p, steps: p.steps.map((s, j) => (j === idx ? { ...s, ...patch } : s)) }
            : p,
        );
        return next;
      });
    },
    [currentPattern],
  );

  const onStepClick = useCallback(
    (idx: number) => {
      if (mode === "patt-write") {
        if (idx === selectedStep) {
          updateStep(idx, { gate: !patterns[currentPattern].steps[idx].gate });
        }
        setSelectedStep(idx);
      } else {
        updateStep(idx, { gate: !patterns[currentPattern].steps[idx].gate });
      }
    },
    [mode, selectedStep, updateStep, patterns, currentPattern],
  );

  const onKeyPress = useCallback(
    (noteOffset: number) => {
      const note = BASE_NOTE + noteOffset + octaveShift * 12;
      setHeldKey(noteOffset);
      engine.playNote(note);
      if (mode === "patt-write") {
        updateStep(selectedStep, { note, gate: true });
        setSelectedStep((s) => (s + 1) % NUM_STEPS);
      }
    },
    [engine, mode, selectedStep, updateStep, octaveShift],
  );

  const onKeyRelease = useCallback(() => {
    setHeldKey(null);
    if (!engine.playing) engine.releaseNote();
  }, [engine]);

  const onPatternBtn = useCallback(
    (i: number) => {
      if (mode === "track-write") {
        setTrack((t) => [...t, i]);
      } else {
        setCurrentPattern(i);
      }
    },
    [mode],
  );

  const clearAction = useCallback(() => {
    if (mode === "track-write") {
      setTrack([]);
    } else {
      setPatterns((ps) => ps.map((p, i) => (i === currentPattern ? defaultPattern() : p)));
    }
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

  return (
    <div className="stage">
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
                onClick={() => setP("waveform", params.waveform === "sawtooth" ? "square" : "sawtooth")}
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
            <div className={`led${params.distortion ? " on" : ""}`} />
            <button
              className={`push-btn${params.distortion ? " lit" : ""}`}
              onClick={() => setP("distortion", !params.distortion)}
            >
              ON
            </button>
          </div>
        </div>

        {/* ————— rangée mode / tempo / transport ————— */}
        <div className="row-mid">
          <div className="section sec-mode">
            <div className="section-label">MODE</div>
            <div className="mode-unit">
              <div className="mode-labels left">
                {MODES.slice(0, 2).map((m) => (
                  <div key={m.id} className="mode-label" onClick={() => setMode(m.id)}>
                    {m.label}
                    <div className={`led${mode === m.id ? " on" : ""}`} />
                  </div>
                ))}
              </div>
              <div style={{ width: 10 }} />
              <div className="mode-labels right">
                {MODES.slice(2).map((m) => (
                  <div key={m.id} className="mode-label" onClick={() => setMode(m.id)}>
                    <div className={`led${mode === m.id ? " on" : ""}`} />
                    {m.label}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="section sec-pattern">
            <div className="section-label">PATTERN {mode === "track-write" ? "→ TRACK" : "GROUP"}</div>
            <div className="patt-btns">
              {Array.from({ length: NUM_PATTERNS }, (_, i) => (
                <button
                  key={i}
                  className={`patt-btn${currentPattern === i ? " active" : ""}`}
                  onClick={() => onPatternBtn(i)}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            {mode.startsWith("track") && (
              <div style={{ fontSize: 9, color: "#3a3c3e", fontWeight: 700 }}>
                CHAIN: {track.length ? track.map((t) => t + 1).join("·") : "—"}
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
              className={`step-cell${writeMode && selectedStep === i ? " selected" : ""}`}
              onClick={() => onStepClick(i)}
            >
              <div className="step-num">{i + 1}</div>
              <div className={`led${playhead === i ? " on" : s.gate ? " dim-on" : ""}`}
                style={s.gate && playhead !== i ? { background: "radial-gradient(circle at 40% 35%, #e0705a, #a03318)", boxShadow: "0 0 4px rgba(255,80,30,0.45)" } : undefined}
              />
              <div className="step-flags">
                {s.accent && <div className="step-flag accent" />}
                {s.slide && <div className="step-flag slide" />}
              </div>
            </div>
          ))}
        </div>

        {/* ————— clavier + touches fonction ————— */}
        <div className="kb-row">
          <div className="kb-main">
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
            onClick={() => writeMode && updateStep(selectedStep, { gate: !selStep.gate })}
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
          <button className="push-btn" onClick={clearAction}>
            CLEAR
          </button>
          <div className="spacer" />
          <div style={{ fontSize: 8.5, color: "#4a4c4f", fontWeight: 600, letterSpacing: 0.5 }}>
            16-STEP SEQUENCER · VCO · VCF · VCA
          </div>
        </div>

        <div className="hint">
          {writeMode
            ? `WRITE — pas ${selectedStep + 1} sélectionné : clavier = note · ACCENT/SLIDE = marquer le pas · clic pas = sélection / gate`
            : mode === "track-write"
              ? "TRACK WRITE — tapez les numéros de pattern pour construire la chaîne, CLEAR pour vider"
              : "RUN pour lancer · clic sur un pas = gate on/off · PITCH MODE pour éditer les notes"}
        </div>
      </div>
    </div>
  );
}
