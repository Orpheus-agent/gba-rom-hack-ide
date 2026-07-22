/**
 * Minimal, dependency-free .xlsx reader (read-only) for the BW demake pipeline.
 * An .xlsx is a ZIP of XML parts; we only need the shared-strings table and the
 * first worksheet. Uses node:zlib for DEFLATE - no external zip lib, fully typed.
 *
 * Scope: handles stored (method 0) + deflate (method 8) entries, shared-string
 * and numeric/inline cells. Sufficient for the trainer spreadsheet; not a
 * general-purpose xlsx parser.
 */
import { inflateRawSync } from 'node:zlib';

/** Unzip a ZIP buffer → map of entry name → uncompressed bytes. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // Find End Of Central Directory record (sig 0x06054b50), scanning backward.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('xlsx/zip: no EOCD record');
  const cdCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // central directory offset
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Local header: name + extra lengths can differ from the CD's.
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 0 ? Buffer.from(comp) : inflateRawSync(comp));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    const inner = m[1] ?? '';
    let text = '';
    for (const t of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1] ?? '';
    out.push(decodeEntities(text));
  }
  return out;
}

function colToIndex(col: string): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64);
  return n - 1;
}

export interface SheetData {
  readonly headers: string[];
  readonly rows: Array<Record<string, string>>;
}

/** Read the first worksheet as objects keyed by the header row (row 1). */
export function readXlsxSheet(fileBytes: Buffer): SheetData {
  const entries = unzip(fileBytes);
  const ssXml = entries.get('xl/sharedStrings.xml');
  const shared = ssXml ? parseSharedStrings(ssXml.toString('utf8')) : [];
  // First worksheet (sheet1.xml is the conventional first sheet).
  let sheetXml: Buffer | undefined;
  for (const [k, v] of entries) {
    if (/^xl\/worksheets\/sheet1\.xml$/.test(k)) {
      sheetXml = v;
      break;
    }
  }
  if (!sheetXml) {
    for (const [k, v] of entries) {
      if (/^xl\/worksheets\/.*\.xml$/.test(k)) {
        sheetXml = v;
        break;
      }
    }
  }
  if (!sheetXml) throw new Error('xlsx: no worksheet');
  const xml = sheetXml.toString('utf8');

  const rowsRaw: Array<Map<number, string>> = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = new Map<number, string>();
    for (const cm of (rm[1] ?? '').matchAll(
      /<c r="([A-Z]+)\d+"((?:[^>]*?))(?:\/>|>([\s\S]*?)<\/c>)/g,
    )) {
      const colIdx = colToIndex(cm[1] ?? 'A');
      const attrs = cm[2] ?? '';
      const body = cm[3] ?? '';
      const tMatch = /\bt="([^"]+)"/.exec(attrs);
      const type = tMatch?.[1];
      const vMatch = /<v>([\s\S]*?)<\/v>/.exec(body);
      const isMatch = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(body);
      let value = '';
      if (type === 's' && vMatch) value = shared[parseInt(vMatch[1] ?? '0', 10)] ?? '';
      else if (type === 'inlineStr' && isMatch) value = decodeEntities(isMatch[1] ?? '');
      else if (vMatch) value = decodeEntities(vMatch[1] ?? '');
      cells.set(colIdx, value);
    }
    rowsRaw.push(cells);
  }

  if (rowsRaw.length === 0) return { headers: [], rows: [] };
  const headerRow = rowsRaw[0]!;
  let maxCol = 0;
  for (const c of headerRow.keys()) maxCol = Math.max(maxCol, c);
  const headers: string[] = [];
  for (let i = 0; i <= maxCol; i++) headers.push((headerRow.get(i) ?? '').trim());

  const rows: Array<Record<string, string>> = [];
  for (let r = 1; r < rowsRaw.length; r++) {
    const cells = rowsRaw[r]!;
    const obj: Record<string, string> = {};
    for (let i = 0; i <= maxCol; i++) {
      const h = headers[i];
      if (h) obj[h] = cells.get(i) ?? '';
    }
    rows.push(obj);
  }
  return { headers, rows };
}
