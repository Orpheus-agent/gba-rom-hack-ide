import './RenderCostMeter.css';

interface RenderCostMeterProps {
  /** Time the manifest -> sceneOptions derive took, in ms. */
  readonly deriveMs: number | null;
  /** Time the pixi scene mount took, in ms. */
  readonly mountMs: number | null;
}

function bucket(ms: number | null): 'ok' | 'warn' | 'bad' | 'unknown' {
  if (ms === null) return 'unknown';
  if (ms < 16) return 'ok';
  if (ms < 50) return 'warn';
  return 'bad';
}

function format(ms: number | null): string {
  if (ms === null) return ' - ';
  if (ms < 1) return '<1ms';
  return `${Math.round(ms)}ms`;
}

export function RenderCostMeter({ deriveMs, mountMs }: RenderCostMeterProps) {
  const derive = bucket(deriveMs);
  const mount = bucket(mountMs);
  return (
    <section className="render-cost-meter" data-testid="render-cost-meter">
      <h4 className="render-cost-meter__heading">Preview latency</h4>
      <div className="render-cost-meter__row">
        <span className="render-cost-meter__label">Manifest derive</span>
        <span
          className={`render-cost-meter__value render-cost-meter__value--${derive}`}
          data-testid="render-cost-derive"
          data-bucket={derive}
        >
          {format(deriveMs)}
        </span>
      </div>
      <div className="render-cost-meter__row">
        <span className="render-cost-meter__label">Scene mount</span>
        <span
          className={`render-cost-meter__value render-cost-meter__value--${mount}`}
          data-testid="render-cost-mount"
          data-bucket={mount}
        >
          {format(mountMs)}
        </span>
      </div>
      <div className="render-cost-meter__legend" title="Latency buckets">
        <span className="render-cost-meter__legend-chip render-cost-meter__legend-chip--ok">&lt;16ms</span>
        <span className="render-cost-meter__legend-chip render-cost-meter__legend-chip--warn">&lt;50ms</span>
        <span className="render-cost-meter__legend-chip render-cost-meter__legend-chip--bad">≥50ms</span>
      </div>
    </section>
  );
}
