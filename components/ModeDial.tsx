"use client";

// Sélecteur MODE rotatif à 4 crans, comme sur la façade du vrai TD-3 :
// PATTERN WRITE / PATTERN PLAY à gauche, TRACK PLAY / TRACK WRITE à droite.
// Clic sur le knob = cran suivant ; clic sur un label = position directe.

export type Mode = "patt-write" | "patt-play" | "track-play" | "track-write";

const POSITIONS: { id: Mode; label: string[]; angle: number; side: "left" | "right" }[] = [
  { id: "patt-write", label: ["PATTERN", "WRITE"], angle: -64, side: "left" },
  { id: "patt-play", label: ["PATTERN", "PLAY"], angle: -22, side: "left" },
  { id: "track-play", label: ["TRACK", "PLAY"], angle: 22, side: "right" },
  { id: "track-write", label: ["TRACK", "WRITE"], angle: 64, side: "right" },
];

export default function ModeDial({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const idx = POSITIONS.findIndex((p) => p.id === mode);
  const angle = POSITIONS[idx]?.angle ?? -22;

  return (
    <div className="mode-dial">
      <div className="mode-dial-labels">
        {POSITIONS.filter((p) => p.side === "left").map((p) => (
          <div
            key={p.id}
            className={`mode-dial-label left${mode === p.id ? " active" : ""}`}
            style={{ ["--a" as string]: `${p.angle}deg` }}
            onClick={() => onChange(p.id)}
          >
            {p.label[0]}
            <br />
            {p.label[1]}
          </div>
        ))}
      </div>
      <div
        className="mode-dial-knob"
        onClick={() => onChange(POSITIONS[(idx + 1) % POSITIONS.length].id)}
        role="slider"
        aria-label="Mode"
        aria-valuenow={idx}
        aria-valuemin={0}
        aria-valuemax={3}
        aria-valuetext={mode}
      >
        <div className="mode-dial-pointer" style={{ transform: `rotate(${angle}deg)` }} />
      </div>
      <div className="mode-dial-labels">
        {POSITIONS.filter((p) => p.side === "right").map((p) => (
          <div
            key={p.id}
            className={`mode-dial-label right${mode === p.id ? " active" : ""}`}
            onClick={() => onChange(p.id)}
          >
            {p.label[0]}
            <br />
            {p.label[1]}
          </div>
        ))}
      </div>
    </div>
  );
}
