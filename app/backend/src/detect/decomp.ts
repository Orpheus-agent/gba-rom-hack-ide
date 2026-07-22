import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ProjectDetector, DetectorResult } from './types.js';

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

interface KnownBaseGame {
  readonly id: string;
  readonly linkerScript: string;
}

// Gen-3 Pokémon decomp lineages this build targets (per MASTER_PROMPT §5).
const KNOWN_BASE_GAMES: ReadonlyArray<KnownBaseGame> = [
  { id: 'pokeemerald', linkerScript: 'pokeemerald.ld' },
  { id: 'pokefirered', linkerScript: 'pokefirered.ld' },
  { id: 'pokeruby', linkerScript: 'pokeruby.ld' },
];

export const decompDetector: ProjectDetector = {
  kind: 'decomp',
  name: 'DecompDetector',
  async detect(projectRoot: string): Promise<DetectorResult> {
    const evidence: string[] = [];
    const warnings: string[] = [];
    let score = 0;
    let baseGame: string | null = null;

    if (await exists(path.join(projectRoot, 'Makefile'))) {
      score += 0.2;
      evidence.push('Makefile');
    }
    if (await exists(path.join(projectRoot, 'include'))) {
      score += 0.15;
      evidence.push('include/');
    }
    if (await exists(path.join(projectRoot, 'src'))) {
      score += 0.15;
      evidence.push('src/');
    }
    if (await exists(path.join(projectRoot, 'data'))) {
      score += 0.15;
      evidence.push('data/');
    }
    if (await exists(path.join(projectRoot, 'tools', 'agbcc'))) {
      score += 0.1;
      evidence.push('tools/agbcc/');
    }
    if (await exists(path.join(projectRoot, 'sound'))) {
      score += 0.05;
      evidence.push('sound/');
    }
    if (await exists(path.join(projectRoot, 'asm'))) {
      score += 0.05;
      evidence.push('asm/');
    }

    for (const candidate of KNOWN_BASE_GAMES) {
      if (await exists(path.join(projectRoot, candidate.linkerScript))) {
        score += 0.35;
        baseGame = candidate.id;
        evidence.push(candidate.linkerScript);
        break;
      }
    }

    if (score > 0 && score < 0.4) {
      warnings.push(
        'Some decomp-shape signals are present but several expected files are missing; confirm this is a buildable decomp root.',
      );
    }

    const confidence = Math.min(1, score);
    const displayName = baseGame
      ? `${baseGame} (decomp)`
      : confidence > 0
        ? 'Generic decomp project'
        : 'Not a decomp project';

    return {
      confidence,
      displayName,
      baseGame,
      fork: null,
      featureFlags: [],
      warnings,
      evidence,
    };
  },
};
