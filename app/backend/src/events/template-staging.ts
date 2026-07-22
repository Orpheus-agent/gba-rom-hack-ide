import { promises as fsp } from 'node:fs';
import path from 'node:path';

export class TemplateStagingError extends Error {
  constructor(
    public readonly code:
      | 'invalid_template_id'
      | 'invalid_payload'
      | 'mutation_failed',
    message: string,
  ) {
    super(message);
    this.name = 'TemplateStagingError';
  }
}

export interface StageTemplateOptions {
  readonly projectRoot: string;
  /** Caller-supplied template id (free text - caller validated against the
   *  frontend registry; backend only enforces shape). */
  readonly templateId: string;
  /** Parameters the writer supplied for this template instance. */
  readonly params: Record<string, string>;
  /** The materialized entity bundle the frontend produced. */
  readonly materialization: Record<string, unknown>;
}

export interface StageTemplateResult {
  readonly stagedPath: string;
  readonly stagedAtUtc: string;
  readonly templateId: string;
}

const STAGED_DIR = '.editor/staged-templates';

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function utcStampForFilename(): string {
  // ISO timestamp, safe for filenames: 2026-05-16T14-06-02Z
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function stageTemplate(
  options: StageTemplateOptions,
): Promise<StageTemplateResult> {
  const { projectRoot, templateId, params, materialization } = options;
  if (typeof templateId !== 'string' || templateId.length === 0 || templateId.length > 128) {
    throw new TemplateStagingError('invalid_template_id', 'templateId must be a non-empty string ≤128 chars');
  }
  if (!materialization || typeof materialization !== 'object') {
    throw new TemplateStagingError('invalid_payload', 'materialization must be an object');
  }
  if (!params || typeof params !== 'object') {
    throw new TemplateStagingError('invalid_payload', 'params must be an object');
  }

  const stampedId = `${utcStampForFilename()}-${safeId(templateId)}`;
  const stagedRel = `${STAGED_DIR}/${stampedId}.json`;
  const stagedAbs = path.resolve(projectRoot, stagedRel);

  try {
    await fsp.mkdir(path.dirname(stagedAbs), { recursive: true });
  } catch (e) {
    throw new TemplateStagingError(
      'mutation_failed',
      `Could not create staged-templates directory: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const stagedAtUtc = new Date().toISOString();
  const payload = {
    schemaVersion: 1,
    templateId,
    stagedAtUtc,
    params,
    materialization,
  };

  const tmp = stagedAbs + '.tmp';
  try {
    await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmp, stagedAbs);
  } catch (e) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* ignore */
    }
    throw new TemplateStagingError(
      'mutation_failed',
      `Atomic write failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  return { stagedPath: stagedRel, stagedAtUtc, templateId };
}
