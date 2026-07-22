/**
 * NitroFS reader (read-only, pure) - the DS cartridge filesystem.
 *
 * Two tables (located via the cartridge header):
 *   FAT - array of 8-byte {startOffset, endOffset} per file id (absolute ROM offsets).
 *   FNT - directory tree: a main table of directory records + per-directory
 *          sub-tables listing child file/dir names. Reference: GBATEK.
 *
 * Gen 4/5 Pokémon games store data under numbered dirs (a/0/1/2, …). We expose
 * BOTH access by full path (FNT walk) and by raw file id (the safety net when
 * community docs give a file id directly).
 */
import { parseNdsHeader, type NdsHeader } from './rom-header.js';

function u16(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)) & 0xffff;
}
function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0
  );
}

export interface FatEntry {
  readonly start: number;
  readonly end: number;
}

export interface NitroFs {
  readonly header: NdsHeader;
  readonly fat: readonly FatEntry[];
  /** Full path (e.g. "a/0/1/2") → file id. */
  readonly pathToId: ReadonlyMap<string, number>;
  /** Read a file's bytes by id (subarray view into the ROM). */
  readFileById(id: number): Uint8Array | null;
  /** Read a file's bytes by full path; null if the path is unknown. */
  readFileByPath(path: string): Uint8Array | null;
  /** List every known full path (sorted). */
  listPaths(): string[];
}

function parseFat(rom: Uint8Array, header: NdsHeader): FatEntry[] {
  const fat: FatEntry[] = [];
  for (let i = 0; i < header.fileCount; i++) {
    const o = header.fatOffset + i * 8;
    fat.push({ start: u32(rom, o), end: u32(rom, o + 4) });
  }
  return fat;
}

/** Walk the FNT into a flat path→id map. Directory ids are 0xF000-based; the
 *  root (0xF000) holds the directory count in its parent field. */
function parseFnt(rom: Uint8Array, header: NdsHeader): Map<string, number> {
  const pathToId = new Map<string, number>();
  const base = header.fntOffset;
  if (header.fntSize < 8) return pathToId;
  const dirCount = u16(rom, base + 6); // root entry's "parent" field = total dirs

  // Read a directory record (8 bytes each) for dir id 0xF000+idx.
  const dirRecord = (idx: number): { subTableOffset: number; firstFileId: number } => {
    const o = base + idx * 8;
    return { subTableOffset: u32(rom, o), firstFileId: u16(rom, o + 4) };
  };

  const walk = (dirIdx: number, prefix: string): void => {
    if (dirIdx >= dirCount) return;
    const { subTableOffset, firstFileId } = dirRecord(dirIdx);
    let p = base + subTableOffset;
    let fileId = firstFileId;
    // Guard against runaway loops on malformed tables.
    let guard = 0;
    while (p < rom.length && guard++ < 100000) {
      const len = rom[p++] ?? 0;
      if (len === 0) break; // end of this directory
      const isDir = (len & 0x80) !== 0;
      const nameLen = len & 0x7f;
      let name = '';
      for (let i = 0; i < nameLen; i++) name += String.fromCharCode(rom[p + i] ?? 0);
      p += nameLen;
      const full = prefix ? `${prefix}/${name}` : name;
      if (isDir) {
        const subDirId = u16(rom, p);
        p += 2;
        walk(subDirId & 0x0fff, full); // 0xF0xx → index
      } else {
        pathToId.set(full, fileId);
        fileId += 1;
      }
    }
  };

  walk(0, '');
  return pathToId;
}

/** Open a DS ROM image as a NitroFS. Returns null if the header is invalid. */
export function openNitroFs(rom: Uint8Array): NitroFs | null {
  const h = parseNdsHeader(rom);
  if (!h.ok) return null;
  const header = h.header;
  const fat = parseFat(rom, header);
  const pathToId = parseFnt(rom, header);

  const readFileById = (id: number): Uint8Array | null => {
    const e = fat[id];
    if (!e || e.end < e.start || e.end > rom.length) return null;
    return rom.subarray(e.start, e.end);
  };

  return {
    header,
    fat,
    pathToId,
    readFileById,
    readFileByPath(path: string): Uint8Array | null {
      const id = pathToId.get(path);
      return id === undefined ? null : readFileById(id);
    },
    listPaths(): string[] {
      return [...pathToId.keys()].sort();
    },
  };
}
