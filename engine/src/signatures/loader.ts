/**
 * Signature DB loader.
 *
 * Walks `/signatures/*.json`, validates each file against the JSON Schema
 * defined in `./schema.ts` (Ajv-validated), enforces the cross-condition
 * the schema can't express ("at least one of gameCodes / sha1 /
 * (sizeBytes+buildMarkers) must be present"), and returns a fully indexed
 * `SignatureDb` optimized for the matcher's lookups.
 *
 * Hot-loadable contract (D-0007): callers can re-invoke `loadSignatureDb()`
 * at any time and get a fresh snapshot. Validation errors are surfaced as
 * `SignatureDbLoadError` PER FILE so one broken file doesn't blackhole the
 * rest - the loader returns both the loaded entries AND the file errors.
 *
 * Empty-DB is a legitimate state (the engine ships with one seed file but
 * operators can start from scratch). The Phase 1 fingerprinting detector
 * must still produce a typed Detection when the DB is empty (PD 1 + PD 5).
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
// Ajv 8 publishes the constructor as BOTH `default` and named `Ajv`. Under
// NodeNext + verbatimModuleSyntax the default-import inference is unreliable
// (some Node CJS-interop combinations make the default resolve to the
// namespace object). The named export always works regardless of interop.
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import {
  SIGNATURE_ENTRY_SCHEMA,
  SIGNATURE_FILE_SCHEMA,
  type SignatureEntry,
  type SignatureFile,
} from './schema.js';

/**
 * Fully indexed snapshot of the loaded signature DB. The indices let the
 * matcher avoid linear scans on common lookup shapes (gameCode, sha1,
 * sizeBytes). When the same entry matches multiple keys (e.g. an entry
 * with two gameCodes), it appears in both arrays under each key.
 */
export interface SignatureDb {
  readonly allEntries: ReadonlyArray<SignatureEntry>;
  readonly byGameCode: ReadonlyMap<string, ReadonlyArray<SignatureEntry>>;
  readonly bySha1: ReadonlyMap<string, ReadonlyArray<SignatureEntry>>;
  readonly bySizeBytes: ReadonlyMap<number, ReadonlyArray<SignatureEntry>>;
  /** Entries with buildMarkers (matcher iterates these when nothing else
   *  matches by index - useful for shape-only signatures). */
  readonly markerEntries: ReadonlyArray<SignatureEntry>;
  readonly loadedFiles: ReadonlyArray<string>;
  readonly fileErrors: ReadonlyArray<SignatureFileLoadError>;
}

export interface SignatureFileLoadError {
  readonly file: string;
  readonly errors: ReadonlyArray<string>;
}

export class SignatureDbLoadError extends Error {
  constructor(message: string, readonly fileErrors: ReadonlyArray<SignatureFileLoadError>) {
    super(message);
    this.name = 'SignatureDbLoadError';
  }
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validateEntry: ValidateFunction = ajv.compile(SIGNATURE_ENTRY_SCHEMA);
const validateFile: ValidateFunction = ajv.compile(SIGNATURE_FILE_SCHEMA);

/**
 * Load and validate every `*.json` in `signaturesDir` (non-recursive).
 *
 * `strict: true` (default) throws `SignatureDbLoadError` if any file fails
 * validation; `strict: false` returns a partial DB and records the errors
 * in `fileErrors` so the engine can continue with whatever loaded cleanly.
 */
export async function loadSignatureDb(args: {
  signaturesDir: string;
  strict?: boolean;
}): Promise<SignatureDb> {
  const dir = path.resolve(args.signaturesDir);
  const strict = args.strict ?? true;

  const files = await listJsonFiles(dir);
  const validEntries: SignatureEntry[] = [];
  const loadedFiles: string[] = [];
  const fileErrors: SignatureFileLoadError[] = [];
  const seenEntryIds = new Set<string>();

  for (const file of files) {
    const errors: string[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    } catch (e) {
      errors.push(`could not parse JSON: ${(e as Error).message}`);
      fileErrors.push({ file, errors: Object.freeze([...errors]) });
      continue;
    }

    if (!validateFile(parsed)) {
      for (const err of validateFile.errors ?? []) {
        errors.push(`${err.instancePath || '/'} ${err.message ?? 'invalid'}`);
      }
      fileErrors.push({ file, errors: Object.freeze([...errors]) });
      continue;
    }
    const fileData = parsed as SignatureFile;
    for (const rawEntry of fileData.entries) {
      // Run-time-validate against the strict per-entry schema (the file-level
      // schema already accepted the shape but JSON Schema validation of the
      // OUTER container doesn't recompile the INNER schema per entry - we
      // re-run it here so a corrupt entry can be skipped individually).
      const entryUnknown: unknown = rawEntry;
      if (!validateEntry(entryUnknown)) {
        const probableId =
          typeof rawEntry === 'object' && rawEntry !== null && 'id' in rawEntry
            ? String((rawEntry as { id: unknown }).id ?? '(unknown)')
            : '(unknown)';
        for (const err of validateEntry.errors ?? []) {
          errors.push(`entry "${probableId}": ${err.instancePath || '/'} ${err.message ?? 'invalid'}`);
        }
        continue;
      }
      const entry = entryUnknown as SignatureEntry;
      const crossErr = enforceCrossCondition(entry);
      if (crossErr) {
        errors.push(`entry "${entry.id}": ${crossErr}`);
        continue;
      }
      if (seenEntryIds.has(entry.id)) {
        errors.push(`entry "${entry.id}": duplicate id across signature DB`);
        continue;
      }
      seenEntryIds.add(entry.id);
      validEntries.push(Object.freeze(deepFreeze(entry)));
    }

    if (errors.length > 0) {
      fileErrors.push({ file, errors: Object.freeze([...errors]) });
    }
    loadedFiles.push(file);
  }

  if (strict && fileErrors.length > 0) {
    throw new SignatureDbLoadError(
      `${String(fileErrors.length)} signature file(s) failed validation`,
      Object.freeze([...fileErrors]),
    );
  }

  return buildDb({
    entries: validEntries,
    loadedFiles,
    fileErrors,
  });
}

function enforceCrossCondition(entry: SignatureEntry): string | null {
  const hasGameCode = entry.gameCodes !== undefined && entry.gameCodes.length > 0;
  const hasSha1 = entry.sha1 !== undefined && entry.sha1.length > 0;
  const hasSizeMarker =
    entry.sizeBytes !== undefined &&
    entry.sizeBytes.length > 0 &&
    entry.buildMarkers !== undefined &&
    entry.buildMarkers.length > 0;
  if (!hasGameCode && !hasSha1 && !hasSizeMarker) {
    return 'must declare at least one of gameCodes, sha1, or (sizeBytes AND buildMarkers)';
  }
  return null;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && path.extname(e.name).toLowerCase() === '.json')
    .map((e) => path.join(dir, e.name))
    .sort();
}

function buildDb(args: {
  entries: ReadonlyArray<SignatureEntry>;
  loadedFiles: ReadonlyArray<string>;
  fileErrors: ReadonlyArray<SignatureFileLoadError>;
}): SignatureDb {
  const byGameCode = new Map<string, SignatureEntry[]>();
  const bySha1 = new Map<string, SignatureEntry[]>();
  const bySizeBytes = new Map<number, SignatureEntry[]>();
  const markerEntries: SignatureEntry[] = [];

  for (const e of args.entries) {
    if (e.gameCodes) {
      for (const code of e.gameCodes) push(byGameCode, code, e);
    }
    if (e.sha1) {
      for (const hash of e.sha1) push(bySha1, hash.toLowerCase(), e);
    }
    if (e.sizeBytes) {
      for (const size of e.sizeBytes) push(bySizeBytes, size, e);
    }
    if (e.buildMarkers && e.buildMarkers.length > 0) {
      markerEntries.push(e);
    }
  }

  return Object.freeze({
    allEntries: Object.freeze([...args.entries]),
    byGameCode: freezeMap(byGameCode),
    bySha1: freezeMap(bySha1),
    bySizeBytes: freezeMap(bySizeBytes),
    markerEntries: Object.freeze(markerEntries),
    loadedFiles: Object.freeze([...args.loadedFiles]),
    fileErrors: Object.freeze([...args.fileErrors]),
  });
}

function push<K>(m: Map<K, SignatureEntry[]>, k: K, v: SignatureEntry): void {
  const arr = m.get(k);
  if (arr === undefined) {
    m.set(k, [v]);
  } else {
    arr.push(v);
  }
}

function freezeMap<K, V>(m: Map<K, V[]>): ReadonlyMap<K, ReadonlyArray<V>> {
  const out = new Map<K, ReadonlyArray<V>>();
  for (const [k, v] of m) out.set(k, Object.freeze([...v]));
  return out;
}

function deepFreeze<T>(v: T): T {
  if (v === null || typeof v !== 'object') return v;
  for (const key of Object.keys(v as object)) {
    deepFreeze((v as Record<string, unknown>)[key]);
  }
  return Object.freeze(v);
}
