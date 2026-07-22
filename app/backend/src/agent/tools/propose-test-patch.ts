/**
 * propose_test_patch - Phase 3.40.
 *
 * Applies the project's current BPS patch artifact to a vanilla
 * FireRed ROM in-memory + verifies byte-level integrity. Read-only:
 * doesn't modify the project ROM or any disk state.
 *
 * Used as a distribution smoke test before the user ships a patch.
 * Catches:
 *   - BPS file corrupted / inconsistent with metadata
 *   - patch produces a cartridge with broken header (won't boot)
 *   - unexpected post-patch SHA-1 (drift between metadata + bytes)
 *
 * Out of scope: mGBA-WASM in-process boot test (Phase 3.7's deferred
 * "smoke boot" mode). For full boot verification the user runs the
 * patched ROM in mGBA / no$gba / real hardware after this passes.
 */

import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { patch as patchApi } from '@rom-introspection/engine';
import type { ToolContext } from '../types.js';

export const PROPOSE_TEST_PATCH_TOOL_NAME = 'propose_test_patch';

export const PROPOSE_TEST_PATCH_DESCRIPTION =
  'Apply the project\'s current BPS patch to a vanilla FireRed ROM\n' +
  'in-memory + verify byte-level integrity. Read-only - doesn\'t\n' +
  'modify the project or write to disk.\n\n' +
  'Inputs:\n' +
  '  - `vanillaRomPath`: path to a clean Pokémon FireRed (USA, v1.0)\n' +
  '    ROM. SHA-1 must match the canonical vanilla.\n' +
  '  - `bpsPath`: path to the BPS patch to test. Defaults to the\n' +
  '    `share/` export from the most recent propose_generate_readme\n' +
  '    output.\n' +
  '  - `expectedPostSha1`: optional SHA-1 to assert the patch produces.\n' +
  '    If set, the tool returns ok=false when the SHA differs.';

const VANILLA_FRLG_SHA1 = '41cb23d8dccc8ebd7c649cd8fbb58eeace6e2fdc';

export const proposeTestPatchInputShape = {
  vanillaRomPath: z.string().min(1),
  bpsPath: z.string().optional(),
  expectedPostSha1: z.string().length(40).optional(),
} as const;

export interface ProposeTestPatchResult {
  readonly ok: boolean;
  readonly applied: boolean;
  readonly preSha1: string | null;
  readonly postSha1: string | null;
  readonly postLength: number | null;
  readonly headerInvariantsOk: boolean;
  readonly issues: ReadonlyArray<string>;
  readonly bpsPath: string | null;
  readonly message: string;
}

function emptyResult(message: string): ProposeTestPatchResult {
  return {
    ok: false,
    applied: false,
    preSha1: null,
    postSha1: null,
    postLength: null,
    headerInvariantsOk: false,
    issues: [],
    bpsPath: null,
    message,
  };
}

export async function proposeTestPatch(
  ctx: ToolContext,
  args: {
    vanillaRomPath: string;
    bpsPath?: string;
    expectedPostSha1?: string;
  },
): Promise<ProposeTestPatchResult> {
  // Read the vanilla ROM.
  let vanilla: Buffer;
  try {
    vanilla = await fsp.readFile(args.vanillaRomPath);
  } catch (e) {
    return emptyResult(`Couldn\'t read vanilla ROM at ${args.vanillaRomPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const preSha1 = createHash('sha1').update(vanilla).digest('hex');
  if (preSha1 !== VANILLA_FRLG_SHA1) {
    return {
      ...emptyResult(`vanilla ROM SHA-1 mismatch - expected ${VANILLA_FRLG_SHA1} (canonical FRLG USA v1.0), got ${preSha1}.`),
      preSha1,
    };
  }

  // Resolve the BPS path. Default: look under <projectRoot>/share/*.bps.
  let bpsPath = args.bpsPath;
  if (!bpsPath) {
    try {
      const shareDir = path.join(ctx.projectRoot, 'share');
      const entries = await fsp.readdir(shareDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const inner = await fsp.readdir(path.join(shareDir, entry.name));
          const found = inner.find((n) => n.toLowerCase().endsWith('.bps'));
          if (found) {
            bpsPath = path.join(shareDir, entry.name, found);
            break;
          }
        }
      }
    } catch {
      /* no share dir */
    }
  }
  if (!bpsPath) {
    return {
      ...emptyResult('No bpsPath specified and no .bps file found under <projectRoot>/share/. Run propose_generate_readme or the existing patch export first.'),
      preSha1,
    };
  }
  let bpsBytes: Buffer;
  try {
    bpsBytes = await fsp.readFile(bpsPath);
  } catch (e) {
    return { ...emptyResult(`Couldn\'t read BPS at ${bpsPath}: ${e instanceof Error ? e.message : String(e)}`), preSha1, bpsPath };
  }

  // Run the harness.
  const result = patchApi.testPatch(new Uint8Array(vanilla), new Uint8Array(bpsBytes));
  const issues = [...result.issues];
  let ok = result.applied && result.headerInvariantsOk;

  if (args.expectedPostSha1 && result.postSha1 !== args.expectedPostSha1) {
    issues.push(
      `post-patch SHA-1 mismatch: expected ${args.expectedPostSha1}, got ${result.postSha1 ?? '(unknown)'}`,
    );
    ok = false;
  }

  return {
    ok,
    applied: result.applied,
    preSha1,
    postSha1: result.postSha1,
    postLength: result.postLength,
    headerInvariantsOk: result.headerInvariantsOk,
    issues: Object.freeze(issues),
    bpsPath,
    message:
      ok
        ? `Patch applies cleanly. Post-SHA: ${result.postSha1}; ${String(result.postLength)} bytes. Header invariants OK.`
        : `Patch test reported ${String(issues.length)} issue(s). ${issues[0] ?? ''}`,
  };
}
