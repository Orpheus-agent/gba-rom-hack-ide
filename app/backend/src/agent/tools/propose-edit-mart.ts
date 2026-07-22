/**
 * propose_edit_mart - Phase 3.27.
 *
 * Mart inventories aren't currently scanned by the engine (the
 * structural detection for `gMart*` tables is a gap surfaced in
 * the Phase 3 audit). Until that scanner lands, this tool follows
 * the direct-apply CFRU-source-edit pattern (like Phase 2D / 2E /
 * 3.31): the user supplies the absolute path of the mart's u16 array
 * (or specifies the mart by symbolic name resolved against CFRU
 * source), the tool computes a `replace_in_file` style update + a
 * paste-ready C snippet.
 *
 * Simpler first cut: persist the mart spec to
 * .editor/mart-inventories.json + emit a paste-ready C snippet for
 * CFRU source.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const PROPOSE_EDIT_MART_TOOL_NAME = 'propose_edit_mart';

export const PROPOSE_EDIT_MART_DESCRIPTION =
  'Set a mart\'s inventory (the ITEM_NONE-terminated u16 array). Until\n' +
  'the engine adds a mart-table scanner, this tool uses the direct-\n' +
  'apply CFRU-source-edit pattern: persists the spec to .editor/mart-\n' +
  'inventories.json + emits a paste-ready C array for the user to drop\n' +
  'into CFRU source.\n\n' +
  'Inputs:\n' +
  '  - `martId`: stable id (e.g. \'mart_pewter\', \'mart_celadon_floor3\').\n' +
  '  - `items`: ordered list of ITEM_* names (the C snippet wraps them\n' +
  '    in the standard gMart array; ITEM_NONE terminator is appended).\n' +
  '  - `notes`: optional design notes.';

export const proposeEditMartInputShape = {
  martId: z.string().min(1).max(60),
  items: z.array(z.string().min(1).max(40)).min(1).max(64),
  notes: z.string().max(500).optional(),
} as const;

export interface ProposeEditMartResult {
  readonly ok: boolean;
  readonly martId: string;
  readonly persistedPath: string | null;
  readonly cSnippet: string;
  readonly itemCount: number;
  readonly message: string;
}

interface StoredMart {
  readonly martId: string;
  readonly items: string[];
  readonly notes: string | null;
}

export async function proposeEditMart(
  ctx: ToolContext,
  args: { martId: string; items: string[]; notes?: string },
): Promise<ProposeEditMartResult> {
  const filePath = path.join(ctx.projectRoot, '.editor', 'mart-inventories.json');
  let stored: StoredMart[] = [];
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { marts: StoredMart[] };
    if (Array.isArray(parsed.marts)) stored = parsed.marts;
  } catch {
    /* new file */
  }
  const entry: StoredMart = {
    martId: args.martId,
    items: [...args.items],
    notes: args.notes ?? null,
  };
  const existingIdx = stored.findIndex((m) => m.martId === args.martId);
  if (existingIdx >= 0) stored.splice(existingIdx, 1, entry);
  else stored.push(entry);
  let persistedPath: string | null = null;
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, JSON.stringify({ schemaVersion: 1, marts: stored }, null, 2), 'utf8');
    persistedPath = filePath;
  } catch {
    /* best-effort */
  }

  const arrayName = `g${args.martId.replace(/[^a-z0-9_]/gi, '').replace(/^./, (s) => s.toUpperCase())}Items`;
  const lines: string[] = [];
  lines.push(`// Phase 3.27 - mart inventory ${args.martId}`);
  lines.push(`// Paste into CFRU's src/shop.c (or wherever the mart definitions live).`);
  lines.push('');
  lines.push(`static const u16 ${arrayName}[] =`);
  lines.push('{');
  for (const item of args.items) {
    lines.push(`    ${item.toUpperCase()},`);
  }
  lines.push('    ITEM_NONE,');
  lines.push('};');
  const cSnippet = lines.join('\n');

  return {
    ok: true,
    martId: args.martId,
    persistedPath,
    cSnippet,
    itemCount: args.items.length,
    message: `Mart "${args.martId}" with ${String(args.items.length)} items persisted; paste C snippet into CFRU source + rebuild bundle.`,
  };
}
