"use client";

import { useCallback, useRef } from "react";

const SWEEP = 270; // degrés utiles, -135° à +135°

interface KnobProps {
  label: string;
  value: number; // 0..1
  onChange: (v: number) => void;
  defaultValue?: number;
  small?: boolean;
}

export default function Knob({ label, value, onChange, defaultValue = 0.5, small }: KnobProps) {
  const drag = useRef<{ startY: number; startV: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {}
      drag.current = { startY: e.clientY, startV: value };
    },
    [value],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!drag.current) return;
      const dy = drag.current.startY - e.clientY;
      const fine = e.shiftKey ? 0.25 : 1;
      onChange(Math.min(1, Math.max(0, drag.current.startV + (dy / 160) * fine)));
    },
    [onChange],
  );

  const onPointerUp = useCallback(() => {
    drag.current = null;
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      onChange(Math.min(1, Math.max(0, value - Math.sign(e.deltaY) * 0.03)));
    },
    [onChange, value],
  );

  const angle = -SWEEP / 2 + value * SWEEP;

  const ticks = [];
  const n = 11;
  const r = (x: number) => Math.round(x * 100) / 100; // coordonnées stables SSR/client
  for (let i = 0; i < n; i++) {
    const a = ((-SWEEP / 2 + (i / (n - 1)) * SWEEP) * Math.PI) / 180;
    const r1 = 46;
    const r2 = i === 0 || i === n - 1 || i === (n - 1) / 2 ? 38 : 41;
    ticks.push(
      <line
        key={i}
        x1={r(50 + r1 * Math.sin(a))}
        y1={r(50 - r1 * Math.cos(a))}
        x2={r(50 + r2 * Math.sin(a))}
        y2={r(50 - r2 * Math.cos(a))}
        stroke="#232426"
        strokeWidth={i === (n - 1) / 2 ? 2.5 : 2}
      />,
    );
  }

  return (
    <div className={`knob-unit${small ? " small" : ""}`}>
      <div className="knob-scale">
        <svg className="knob-ticks" viewBox="0 0 100 100">
          {ticks}
        </svg>
        <div
          className="knob-body"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onDoubleClick={() => onChange(defaultValue)}
          role="slider"
          aria-label={label}
          aria-valuenow={Math.round(value * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="knob-pointer" style={{ transform: `rotate(${angle + 180}deg)` }} />
        </div>
      </div>
      <div className="knob-label">{label}</div>
    </div>
  );
}
