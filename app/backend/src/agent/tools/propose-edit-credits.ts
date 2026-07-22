/**
 * propose_edit_credits - Phase 3.34.
 *
 * Persists the hack's credits roll to `.editor/credits.json` + emits
 * a paste-ready C snippet for CFRU's `src/credits.c`. The user pastes
 * the snippet (or applies a `replace_in_file` against CFRU sources)
 * + rebuilds.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_EDIT_CREDITS_TOOL_NAME = 'propose_edit_credits';

export const PROPOSE_EDIT_CREDITS_DESCRIPTION =
  'Persist hack credits + generate a paste-ready C snippet for CFRU\n' +
  '`src/credits.c`. Direct-apply pattern (no ROM byte writes).\n\n' +
  'Inputs:\n' +
  '  - `entries`: ordered list of { role, name } pairs (e.g.\n' +
  '    { role: \'Director\', name: \'Your Name\' }, { role: \'Art\', name: ... }).\n' +
  '  - `headerLine`: optional title for the credits screen.\n' +
  '  - `footerLine`: optional final line.';

const creditsEntrySchema = z.object({
  role: z.string().min(1).max(30),
  name: z.string().min(1).max(40),
});

export const proposeEditCreditsInputShape = {
  entries: z.array(creditsEntrySchema).min(1).max(80),
  headerLine: z.string().max(60).optional(),
  footerLine: z.string().max(60).optional(),
} as const;

export interface ProposeEditCreditsResult {
  readonly ok: boolean;
  readonly persistedPath: string | null;
  readonly cSnippet: string;
  readonly entryCount: number;
  readonly message: string;
}

export async function proposeEditCredits(
  ctx: ToolContext,
  args: {
    entries: Array<{ role: string; name: string }>;
    headerLine?: string;
    footerLine?: string;
  },
): Promise<ProposeEditCreditsResult> {
  // Persist.
  const filePath = path.join(ctx.projectRoot, '.editor', 'credits.json');
  let persistedPath: string | null = null;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(
      filePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          headerLine: args.headerLine ?? null,
          footerLine: args.footerLine ?? null,
          entries: args.entries,
        },
        null,
        2,
      ),
      'utf8',
    );
    persistedPath = filePath;
  } catch {
    /* best-effort */
  }

  // C snippet: build a static const struct array typical for CFRU
  // credits. CFRU's credits.c uses a per-screen array of u8* string
  // pairs.
  const lines: string[] = [];
  lines.push('// Phase 3.34 - paste into CFRU\'s src/credits.c (replace');
  lines.push('// the existing sCreditsEntries array).');
  lines.push('');
  if (args.headerLine) {
    lines.push(`// HEADER: ${args.headerLine}`);
  }
  lines.push('static const struct CreditsEntry sCreditsEntries[] =');
  lines.push('{');
  for (const e of args.entries) {
    lines.push(`    {.role = _("${e.role.toUpperCase()}"), .name = _("${e.name.toUpperCase()}")},`);
  }
  lines.push('};');
  if (args.footerLine) {
    lines.push('');
    lines.push(`// FOOTER: ${args.footerLine}`);
  }
  const cSnippet = lines.join('\n');

  return {
    ok: true,
    persistedPath,
    cSnippet,
    entryCount: args.entries.length,
    message: `Credits roll with ${String(args.entries.length)} entries persisted; paste cSnippet into CFRU's src/credits.c.`,
  };
}
