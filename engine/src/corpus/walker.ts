/**
 * Corpus walker.
 *
 * Walks `/corpus/<class>/**\/*.gba` (and optionally `.zip`) at test/run time
 * and returns absolute paths grouped by corpus class. PD 12: the walker only
 * READS what the operator has placed in `/corpus/` - it NEVER reaches outside
 * the supplied root to pull ROMs from arbitrary filesystem locations.
 *
 * Convention: `/corpus/<class>/<...subdirs>/<file>.gba` → corpusClass=`<class>`.
 * Files directly under `/corpus/` (not in a class subdir) get `class=null`
 * and are surfaced separately so the operator notices their missing class.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

export const KNOWN_CORPUS_CLASSES = [
  'vanilla',
  'heavyHack',
  'cfru',
  'decomp',
  'customFork',
] as const;
export type KnownCorpusClass = (typeof KNOWN_CORPUS_CLASSES)[number];

export interface CorpusEntry {
  /** Absolute path to the ROM/archive file. */
  readonly path: string;
  /** Filename only. */
  readonly basename: string;
  /** §12.5 class (`vanilla` / `heavyHack` / `cfru` / `decomp` / `customFork`)
   *  derived from the immediate child-of-/corpus/ directory; null when the
   *  file sits directly in /corpus/ or in an unrecognized subdir. */
  readonly corpusClass: string | null;
  /** Whether `corpusClass` matches one of KNOWN_CORPUS_CLASSES. */
  readonly classRecognized: boolean;
}

export interface CorpusWalkResult {
  readonly rootDir: string;
  readonly entries: ReadonlyArray<CorpusEntry>;
  /** Classes the operator HAS supplied at least one ROM for. */
  readonly suppliedClasses: ReadonlyArray<string>;
  /** Of KNOWN_CORPUS_CLASSES, the ones with zero ROMs. Used by reports to
   *  surface §12.5 missing-class warnings without halting (B-0001 routing). */
  readonly missingKnownClasses: ReadonlyArray<KnownCorpusClass>;
}

/** Default extensions the walker considers ROMs/archives. */
const DEFAULT_ROM_EXTS = new Set(['.gba']);

/**
 * Walk a corpus root. Returns an empty entries list when the root doesn't
 * exist OR contains no ROM files - both legitimate states early in the build.
 * The caller (typically the smoke test) decides whether to substitute a
 * synthetic fixture per §13.3.
 */
export async function walkCorpus(args: {
  rootDir: string;
  extensions?: ReadonlySet<string>;
}): Promise<CorpusWalkResult> {
  const rootDir = path.resolve(args.rootDir);
  const extensions = args.extensions ?? DEFAULT_ROM_EXTS;

  const exists = await directoryExists(rootDir);
  if (!exists) {
    return Object.freeze({
      rootDir,
      entries: Object.freeze([]),
      suppliedClasses: Object.freeze([]),
      missingKnownClasses: Object.freeze([...KNOWN_CORPUS_CLASSES]),
    });
  }

  const entries: CorpusEntry[] = [];
  await walkRecursive({
    dir: rootDir,
    rootDir,
    extensions,
    out: entries,
  });

  const suppliedSet = new Set<string>();
  for (const e of entries) {
    if (e.corpusClass !== null) suppliedSet.add(e.corpusClass);
  }
  const supplied = Array.from(suppliedSet).sort();
  const missing = KNOWN_CORPUS_CLASSES.filter((c) => !suppliedSet.has(c));

  return Object.freeze({
    rootDir,
    entries: Object.freeze([...entries].sort((a, b) => a.path.localeCompare(b.path))),
    suppliedClasses: Object.freeze(supplied),
    missingKnownClasses: Object.freeze(missing),
  });
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const s = await fsp.stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function walkRecursive(args: {
  dir: string;
  rootDir: string;
  extensions: ReadonlySet<string>;
  out: CorpusEntry[];
}): Promise<void> {
  let dirents;
  try {
    dirents = await fsp.readdir(args.dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const de of dirents) {
    const full = path.join(args.dir, de.name);
    if (de.isDirectory()) {
      await walkRecursive({ dir: full, rootDir: args.rootDir, extensions: args.extensions, out: args.out });
      continue;
    }
    if (!de.isFile()) continue;
    const ext = path.extname(de.name).toLowerCase();
    if (!args.extensions.has(ext)) continue;

    const rel = path.relative(args.rootDir, full);
    const parts = rel.split(path.sep);
    // parts[0] is the immediate child of rootDir. If parts has only one
    // element, the file sits directly in /corpus/ - no class.
    const corpusClass = parts.length > 1 ? parts[0] ?? null : null;
    const classRecognized =
      corpusClass !== null && (KNOWN_CORPUS_CLASSES as readonly string[]).includes(corpusClass);

    args.out.push(
      Object.freeze({
        path: full,
        basename: de.name,
        corpusClass,
        classRecognized,
      }),
    );
  }
}
