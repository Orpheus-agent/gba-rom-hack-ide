import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Asset, AssetKind } from '@rom-editor/shared';
import { colorTypeLabel, parsePngHeader } from './png-header.js';

// Path-substring → AssetKind mapping for graphics/. Earlier entries win.
const GRAPHICS_KIND_RULES: ReadonlyArray<{ test: RegExp; kind: AssetKind }> = [
  { test: /(^|\/)object_events(\/|_)/, kind: 'overworld_sprite' },
  { test: /(^|\/)trainers?(\/|_)/, kind: 'trainer_sprite' },
  { test: /(^|\/)battle/, kind: 'battle_sprite' },
  { test: /(^|\/)tilesets?(\/|_)/, kind: 'tileset' },
  { test: /(^|\/)pokemon(\/|_)/, kind: 'battle_sprite' },
  { test: /(^|\/)portrait/, kind: 'portrait' },
  { test: /(^|\/)animations?(\/|_)/, kind: 'animation' },
  { test: /(^|\/)icons?(\/|_)/, kind: 'icon' },
];

const AUDIO_EXTENSIONS = new Set(['.aif', '.wav', '.ogg', '.aiff']);
const PALETTE_EXTENSIONS = new Set(['.pal', '.gbapal']);
const IMAGE_EXTENSIONS = new Set(['.png']);
// Derived/compiled outputs we skip to avoid noisy duplicates of the source PNGs.
const SKIP_EXTENSIONS = new Set([
  '.4bpp',
  '.8bpp',
  '.bin',
  '.lz',
  '.rl',
  '.smol',
  '.s', // raw assembly inside sound/ or graphics/ - covered as kind below if useful
]);

export function classifyAsset(relPath: string): AssetKind | null {
  const lower = relPath.toLowerCase().replace(/\\/g, '/');
  const ext = path.extname(lower);

  if (PALETTE_EXTENSIONS.has(ext)) return 'palette';

  if (AUDIO_EXTENSIONS.has(ext)) {
    if (lower.startsWith('sound/songs/') || lower.includes('/songs/')) return 'music';
    return 'sound';
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    for (const rule of GRAPHICS_KIND_RULES) {
      if (rule.test.test(lower)) return rule.kind;
    }
    return 'ui_graphic';
  }

  return null;
}

async function* walkDir(
  root: string,
  relPath = '',
): AsyncGenerator<{ relPath: string; size: number }> {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, relPath), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const childRel = relPath ? `${relPath}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* walkDir(root, childRel);
    } else if (e.isFile()) {
      let size = 0;
      try {
        const stat = await fsp.stat(path.join(root, childRel));
        size = stat.size;
      } catch {
        size = 0;
      }
      yield { relPath: childRel, size };
    }
  }
}

function assetIdFromRelativePath(relPath: string): string {
  // Normalize separators for cross-platform-stable IDs.
  return relPath.replace(/\\/g, '/');
}

function assetNameFromRelativePath(relPath: string): string {
  const base = path.basename(relPath);
  return base;
}

function shouldSkip(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return SKIP_EXTENSIONS.has(ext);
}

async function readPngHeaderInfo(absPath: string): Promise<{
  width: number;
  height: number;
  bitDepth: number;
  colorTypeLabel: string;
} | null> {
  try {
    const handle = await fsp.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(33);
      await handle.read(buf, 0, 33, 0);
      const h = parsePngHeader(buf);
      if (!h) return null;
      return {
        width: h.width,
        height: h.height,
        bitDepth: h.bitDepth,
        colorTypeLabel: colorTypeLabel(h.colorType),
      };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export interface AssetsResult {
  readonly assets: ReadonlyArray<Asset>;
  readonly warnings: ReadonlyArray<string>;
}

export async function parseAssets(projectRoot: string): Promise<AssetsResult> {
  const assets: Asset[] = [];
  const warnings: string[] = [];

  const roots: ReadonlyArray<{ root: string; prefix: string }> = [
    { root: path.join(projectRoot, 'graphics'), prefix: 'graphics' },
    { root: path.join(projectRoot, 'sound'), prefix: 'sound' },
  ];

  let foundAny = false;
  for (const { root, prefix } of roots) {
    let scanned = false;
    for await (const file of walkDir(root)) {
      scanned = true;
      foundAny = true;
      if (shouldSkip(file.relPath)) continue;
      const fullRel = `${prefix}/${file.relPath}`;
      const kind = classifyAsset(fullRel);
      if (!kind) continue;
      const metadata: Record<string, string | number | boolean> = {
        sizeBytes: file.size,
        extension: path.extname(file.relPath).toLowerCase(),
      };
      // For PNGs, surface dimensions + color info in metadata so the editor
      // can show them without re-reading the file. Reads only the first 33
      // bytes (PNG sig + IHDR chunk) - cheap even for thousands of files.
      if (metadata['extension'] === '.png') {
        const headerInfo = await readPngHeaderInfo(path.join(root, file.relPath));
        if (headerInfo) {
          metadata['width'] = headerInfo.width;
          metadata['height'] = headerInfo.height;
          metadata['bitDepth'] = headerInfo.bitDepth;
          metadata['colorType'] = headerInfo.colorTypeLabel;
        }
      }
      assets.push({
        id: assetIdFromRelativePath(fullRel),
        name: assetNameFromRelativePath(fullRel),
        kind,
        relativePath: fullRel,
        metadata,
      });
    }
    if (!scanned) {
      warnings.push(
        `No ${prefix}/ directory found - ${prefix} assets not indexed for this project.`,
      );
    }
  }

  if (!foundAny) {
    // Both warnings already present; nothing extra to add.
  }

  assets.sort((a, b) => a.id.localeCompare(b.id));
  return { assets, warnings };
}
