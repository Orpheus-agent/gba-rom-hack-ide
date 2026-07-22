import { useMemo } from 'react';
import type { ProjectManifest } from '@rom-editor/shared';
import {
  lintRuleLabel,
  runDesignLint,
  type LintFinding,
  type LintRuleId,
} from '../lib/designLint';
import { displayName } from '../lib/displayName';
import { useUiPreferencesStore } from '../state';
import './LintView.css';

interface LintViewProps {
  readonly manifest: ProjectManifest;
}

export function LintView({ manifest }: LintViewProps) {
  const report = useMemo(() => runDesignLint(manifest), [manifest]);
  const showInternalIds = useUiPreferencesStore((s) => s.showInternalIds);

  // Group findings by ruleId for display.
  const grouped = useMemo(() => {
    const m = new Map<LintRuleId, LintFinding[]>();
    for (const f of report.findings) {
      const arr = m.get(f.ruleId) ?? [];
      arr.push(f);
      m.set(f.ruleId, arr);
    }
    return m;
  }, [report.findings]);

  if (report.findings.length === 0) {
    const isBinaryRom = manifest.binaryRom !== undefined;
    return (
      <div className="lint-view lint-view--clean" data-testid="lint-view-clean">
        <h2 className="lint-view__title">Design lint</h2>
        <div className="lint-view__clean-msg">
          <div className="lint-view__clean-emoji">✓</div>
          {isBinaryRom ? (
            <p>
              Design lint is decomp-aware: it checks orphan dialogue / unused flags /
              orphan assets / empty triggers / decorative objects by walking the
              project's script source for cross-references. Binary-ROM workspaces don't
              expose those typed references yet (the bytecode decoder reads dialogue
              text but not the matching synthetic id). Open the matching decomp project
              (pokefirered / pokeemerald) for full lint coverage.
            </p>
          ) : (
            <p>
              No findings. Every dialogue is referenced, every flag is used, every asset has a home,
              every trigger fires real script steps, every object event has either a script or a flag.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="lint-view" data-testid="lint-view">
      <header className="lint-view__header">
        <h2 className="lint-view__title">Design lint</h2>
        <div className="lint-view__counts" data-testid="lint-view-counts">
          {report.countsBySeverity.warn > 0 && (
            <span className="lint-view__count lint-view__count--warn">
              {report.countsBySeverity.warn} warn
            </span>
          )}
          {report.countsBySeverity.info > 0 && (
            <span className="lint-view__count lint-view__count--info">
              {report.countsBySeverity.info} info
            </span>
          )}
          <span className="lint-view__count-total">
            {report.findings.length} total
          </span>
        </div>
      </header>
      <div className="lint-view__body">
        {Array.from(grouped.entries()).map(([ruleId, findings]) => (
          <RuleSection
            key={ruleId}
            ruleId={ruleId}
            findings={findings}
            manifest={manifest}
            showInternalIds={showInternalIds}
          />
        ))}
      </div>
    </div>
  );
}

function RuleSection({
  ruleId,
  findings,
  manifest,
  showInternalIds,
}: {
  ruleId: LintRuleId;
  findings: ReadonlyArray<LintFinding>;
  manifest: ProjectManifest;
  showInternalIds: boolean;
}) {
  const severity = findings[0]?.severity ?? 'warn';
  return (
    <section
      className={`lint-view__rule lint-view__rule--${severity}`}
      data-testid={`lint-rule-${ruleId}`}
      data-severity={severity}
    >
      <h3 className="lint-view__rule-heading">
        <span className={`lint-view__rule-badge lint-view__rule-badge--${severity}`}>
          {severity}
        </span>
        {lintRuleLabel(ruleId)}
        <span className="lint-view__rule-count">({findings.length})</span>
      </h3>
      <ul className="lint-view__findings">
        {findings.map((f) => (
          <li
            key={`${f.ruleId}::${f.entityId}`}
            className="lint-view__finding"
            data-testid={`lint-finding-${f.ruleId}-${f.entityId}`}
          >
            {/* Phase G-RC6: resolve raw entityIds (binary_text_*,
                binary_map_*, gfx_*, etc.) through displayName so
                operators see English labels instead of synthetic ids. */}
            <span className="lint-view__finding-entity">
              {displayName(manifest, f.entityId, showInternalIds)}
            </span>
            <span className="lint-view__finding-kind">{f.entityKind}</span>
            <span className="lint-view__finding-msg">{f.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
