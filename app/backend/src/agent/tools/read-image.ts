import { z } from 'zod';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { ToolContext } from '../types.js';

export const READ_IMAGE_TOOL_NAME = 'read_image';

export const READ_IMAGE_DESCRIPTION =
  'Load an image (file path or http(s) URL) and surface it as a ' +
  "vision-compatible attachment in the tool result. Claude's " +
  'multimodal layer sees the image directly and can reason about it ' +
  ' - useful for:\n' +
  '  - Reading a reference map screenshot ("what does Castelia City ' +
  'look like in BW2?") then planning a recreation in the current ROM.\n' +
  '  - Comparing a freshly-rendered map screenshot against the ' +
  'canonical art to catch visual bugs.\n' +
  '  - Reading a sprite atlas / palette swatch from a fan-disassembly ' +
  'project before proposing an asset import.\n\n' +
  'Path resolution:\n' +
  '  - Absolute paths and http(s):// URLs are used directly.\n' +
  '  - Relative paths resolve relative to the current project root ' +
  '(the ROM editor\'s open project), not the agent\'s cwd.\n\n' +
  'Constraints:\n' +
  '  - PNG, JPEG, GIF, WebP supported. Other formats return ' +
  '`{ ok: false, reason: "unsupported_mime" }`.\n' +
  '  - Image data above 4 MiB is rejected (Claude\'s vision limit ' +
  'is ~5 MiB; we add a small headroom for the JSON framing). For ' +
  'larger reference materials, downscale before passing.\n' +
  '  - Network fetches have a 15-second timeout.';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 15_000;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const SNIFF_RULES: ReadonlyArray<{ signature: ReadonlyArray<number>; mime: string }> = [
  { signature: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { signature: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { signature: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif' },
  { signature: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' }, // RIFF - check WEBP further
];

export const readImageInputShape = {
  pathOrUrl: z.string().min(1),
} as const;

export interface ReadImageResult {
  readonly ok: boolean;
  readonly reason?:
    | 'file_not_found'
    | 'fetch_failed'
    | 'fetch_timeout'
    | 'too_large'
    | 'unsupported_mime'
    | 'read_error';
  readonly message?: string;
  readonly mimeType?: string;
  readonly byteLength?: number;
  /** Base64-encoded image bytes. Only present when ok=true. The MCP
   *  framework wrapper unpacks this into a vision content block. */
  readonly base64?: string;
  /** Resolved absolute source (file:// path or URL). */
  readonly source?: string;
}

function bytesStartWith(bytes: Uint8Array, signature: ReadonlyArray<number>): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function detectMime(bytes: Uint8Array, extHint?: string): string | null {
  for (const rule of SNIFF_RULES) {
    if (bytesStartWith(bytes, rule.signature)) {
      // WEBP needs an extra check at offset 8-11.
      if (rule.mime === 'image/webp') {
        if (
          bytes[8] === 0x57 && // W
          bytes[9] === 0x45 && // E
          bytes[10] === 0x42 && // B
          bytes[11] === 0x50 // P
        ) {
          return 'image/webp';
        }
        continue;
      }
      return rule.mime;
    }
  }
  if (extHint && MIME_BY_EXT[extHint] !== undefined) return MIME_BY_EXT[extHint]!;
  return null;
}

async function fetchUrl(url: string): Promise<ReadImageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        ok: false,
        reason: 'fetch_failed',
        message: `HTTP ${response.status} fetching ${url}`,
      };
    }
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        byteLength: buf.byteLength,
        message: `Image is ${buf.byteLength} bytes; max ${MAX_IMAGE_BYTES} bytes accepted.`,
      };
    }
    const mime = detectMime(buf);
    if (!mime) {
      return {
        ok: false,
        reason: 'unsupported_mime',
        message: 'Could not identify image format from byte signature (PNG/JPEG/GIF/WebP supported).',
      };
    }
    return {
      ok: true,
      mimeType: mime,
      byteLength: buf.byteLength,
      base64: Buffer.from(buf).toString('base64'),
      source: url,
    };
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return { ok: false, reason: 'fetch_timeout', message: `Fetch of ${url} exceeded ${NETWORK_TIMEOUT_MS}ms.` };
    }
    return {
      ok: false,
      reason: 'fetch_failed',
      message: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readFile(absPath: string): Promise<ReadImageResult> {
  try {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      return { ok: false, reason: 'file_not_found', message: `Not a regular file: ${absPath}` };
    }
    if (stat.size > MAX_IMAGE_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        byteLength: stat.size,
        message: `File is ${stat.size} bytes; max ${MAX_IMAGE_BYTES} bytes accepted.`,
      };
    }
    const buf = await fsp.readFile(absPath);
    const ext = path.extname(absPath).toLowerCase();
    const mime = detectMime(new Uint8Array(buf), ext);
    if (!mime) {
      return {
        ok: false,
        reason: 'unsupported_mime',
        message: `Could not identify image format from byte signature for ${absPath}.`,
      };
    }
    return {
      ok: true,
      mimeType: mime,
      byteLength: buf.byteLength,
      base64: buf.toString('base64'),
      source: `file://${absPath}`,
    };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return { ok: false, reason: 'file_not_found', message: `File not found: ${absPath}` };
    }
    return {
      ok: false,
      reason: 'read_error',
      message: `Read error: ${err.message}`,
    };
  }
}

export async function readImage(
  ctx: ToolContext,
  args: { pathOrUrl: string },
): Promise<ReadImageResult> {
  const target = args.pathOrUrl.trim();
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return fetchUrl(target);
  }
  const absPath = path.isAbsolute(target)
    ? target
    : path.resolve(ctx.projectRoot, target);
  return readFile(absPath);
}
