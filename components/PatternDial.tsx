"use client";

// Rotary "TRACK / PATTERN GROUP" du vrai : un seul gros sélecteur crocheté
// avec les 8 numéros disposés en cercle. Clic sur un chiffre = saut direct,
// clic sur le corps du knob = position suivante.

const POSITIONS = 8;

export default function PatternDial({
  value,
  onChange,
}: {
  value: number; // 0..7
  onChange: (n: number) => void;
}) {
  const angle = (value / POSITIONS) * 360;

  return (
    <div className="pattern-dial">
      <div className="pattern-dial-ring">
        {Array.from({ length: POSITIONS }, (_, i) => {
          const a = (i / POSITIONS) * 360 - 90;
          const rad = (a * Math.PI) / 180;
          const x = 50 + 44 * Math.cos(rad);
          const y = 50 + 44 * Math.sin(rad);
          return (
            <button
              key={i}
              className={`pattern-dial-num${value === i ? " active" : ""}`}
              style={{ left: `${x}%`, top: `${y}%` }}
              onClick={() => onChange(i)}
            >
              {i + 1}
            </button>
          );
        })}
        <div
          className="pattern-dial-knob"
          onClick={() => onChange((value + 1) % POSITIONS)}
          role="slider"
          aria-label="Pattern number"
          aria-valuenow={value + 1}
          aria-valuemin={1}
          aria-valuemax={8}
        >
          <div className="pattern-dial-pointer" style={{ transform: `rotate(${angle}deg)` }} />
        </div>
      </div>
    </div>
  );
}
