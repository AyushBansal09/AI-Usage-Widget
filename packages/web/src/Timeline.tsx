import { useState } from "react";
import { fmt, type TimelineBucket } from "./api.js";

const W = 900, H = 200, PAD_L = 48, PAD_B = 22, PAD_T = 8;

/** Stacked bars: cache (bottom), input, output. One axis, 2px gaps, hover tooltip. */
export function Timeline({ data }: { data: TimelineBucket[] }) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  if (!data.length) return <div className="chart empty">No usage in this range yet.</div>;

  const max = Math.max(...data.map((d) => d.cache + d.input + d.output), 1);
  const innerW = W - PAD_L - 8;
  const innerH = H - PAD_T - PAD_B;
  const bw = Math.max(innerW / data.length - 2, 1);
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;
  const ticks = [0, 0.5, 1].map((f) => f * max);

  return (
    <div className="chart">
      <div className="legend">
        <span style={{ "--c": "var(--series-3)" } as any}>Cache read/write</span>
        <span style={{ "--c": "var(--series-1)" } as any}>Input</span>
        <span style={{ "--c": "var(--series-2)" } as any}>Output</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Token usage over time" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - 8} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD_L - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{fmt.tokens(t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = PAD_L + i * (innerW / data.length) + 1;
          const segs = [
            ["var(--series-3)", d.cache],
            ["var(--series-1)", d.input],
            ["var(--series-2)", d.output],
          ] as const;
          let acc = 0;
          return (
            <g key={d.t} onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })}>
              <rect x={x} y={PAD_T} width={bw} height={innerH} fill="transparent" />
              {segs.map(([c, v], k) => {
                const top = y(acc + v), bottom = y(acc);
                acc += v;
                if (v <= 0) return null;
                return <rect key={k} x={x} y={top} width={bw} height={Math.max(bottom - top - 1, 0.5)} fill={c} rx={k === 2 ? 2 : 0} />;
              })}
            </g>
          );
        })}
        {data.map((d, i) =>
          i % Math.ceil(data.length / 8) === 0 ? (
            <text key={d.t} x={PAD_L + i * (innerW / data.length) + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--muted)">
              {label(d.t, data)}
            </text>
          ) : null,
        )}
      </svg>
      {hover && (
        <div className="tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div><b>{new Date(data[hover.i]!.t).toLocaleString()}</b></div>
          <div>Cache {fmt.tokens(data[hover.i]!.cache)} · Input {fmt.tokens(data[hover.i]!.input)} · Output {fmt.tokens(data[hover.i]!.output)}</div>
          <div>{fmt.usd(data[hover.i]!.costUsd)}</div>
        </div>
      )}
    </div>
  );
}

function label(t: string, data: TimelineBucket[]): string {
  const d = new Date(t);
  const span = Date.parse(data[data.length - 1]!.t) - Date.parse(data[0]!.t);
  return span > 2 * 86400000
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
