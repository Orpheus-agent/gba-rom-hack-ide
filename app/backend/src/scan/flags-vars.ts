import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Flag, FlagScope, Variable } from '@rom-editor/shared';

const FLAG_NAME = /^FLAG_[A-Z0-9_]+$/;
const VAR_NAME = /^VAR_[A-Z0-9_]+$/;

const DEFINE_LINE =
  /^\s*#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)(?:\s*\/\/\s*(.*))?\s*$/;

/** Strip /* ... *\/ block comments while preserving line numbers. */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function parseLiteralValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (/^0x[0-9A-Fa-f]+$/.test(trimmed)) return Number.parseInt(trimmed.slice(2), 16);
  if (/^[0-9]+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return null;
}

function flagScopeFor(name: string, value: number | null): FlagScope {
  if (/TEMP_FLAGS|TEMP|_TMP_/i.test(name)) return 'temporary';
  if (value !== null && value < 0x100) return 'temporary';
  return 'global';
}

function variableScopeFor(name: string, value: number | null): FlagScope {
  if (/TEMP_VARS|TMP_VAR|_TMP_/i.test(name)) return 'temporary';
  if (value !== null && value < 0x40) return 'temporary';
  return 'global';
}

interface ParsedDefine {
  readonly name: string;
  readonly rawValue: string;
  readonly literalValue: number | null;
  readonly trailingComment: string | null;
}

function parseDefines(source: string): ParsedDefine[] {
  const stripped = stripBlockComments(source);
  const out: ParsedDefine[] = [];
  for (const rawLine of stripped.split(/\r?\n/)) {
    const match = DEFINE_LINE.exec(rawLine);
    if (!match) continue;
    const name = match[1];
    const rawValueRaw = match[2];
    if (!name || !rawValueRaw) continue;
    const rawValue = rawValueRaw.trim();
    const trailingComment = match[3]?.trim();
    out.push({
      name,
      rawValue,
      literalValue: parseLiteralValue(rawValue),
      trailingComment: trailingComment && trailingComment.length > 0 ? trailingComment : null,
    });
  }
  return out;
}

export function extractFlags(headerSource: string): Flag[] {
  const flags: Flag[] = [];
  for (const def of parseDefines(headerSource)) {
    if (!FLAG_NAME.test(def.name)) continue;
    flags.push({
      id: def.name,
      name: def.name,
      scope: flagScopeFor(def.name, def.literalValue),
      defaultValue: false,
      description: def.trailingComment,
      engineValue: def.rawValue,
    });
  }
  return flags;
}

export function extractVariables(headerSource: string): Variable[] {
  const variables: Variable[] = [];
  for (const def of parseDefines(headerSource)) {
    if (!VAR_NAME.test(def.name)) continue;
    variables.push({
      id: def.name,
      name: def.name,
      scope: variableScopeFor(def.name, def.literalValue),
      defaultValue: 0,
      description: def.trailingComment,
      engineValue: def.rawValue,
    });
  }
  return variables;
}

async function tryReadFile(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export interface FlagsVarsResult {
  readonly flags: ReadonlyArray<Flag>;
  readonly variables: ReadonlyArray<Variable>;
  readonly warnings: ReadonlyArray<string>;
}

export async function parseFlagsAndVariables(projectRoot: string): Promise<FlagsVarsResult> {
  const flagsPath = path.join(projectRoot, 'include', 'constants', 'flags.h');
  const varsPath = path.join(projectRoot, 'include', 'constants', 'vars.h');
  const warnings: string[] = [];

  const flagsSrc = await tryReadFile(flagsPath);
  const varsSrc = await tryReadFile(varsPath);

  if (!flagsSrc) {
    warnings.push(
      `No include/constants/flags.h at ${flagsPath} - story flags will not be indexed for this project.`,
    );
  }
  if (!varsSrc) {
    warnings.push(
      `No include/constants/vars.h at ${varsPath} - story variables will not be indexed for this project.`,
    );
  }

  const flags = flagsSrc ? extractFlags(flagsSrc) : [];
  const variables = varsSrc ? extractVariables(varsSrc) : [];

  flags.sort((a, b) => a.id.localeCompare(b.id));
  variables.sort((a, b) => a.id.localeCompare(b.id));

  return { flags, variables, warnings };
}
