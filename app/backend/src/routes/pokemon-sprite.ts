/**
 * Phase 4.2C - Pokémon sprite endpoint.
 *
 *   GET /api/projects/:id/pokemon-sprite/:speciesId.png
 *
 * Returns a PNG image representing the species's front-pic sprite.
 *
 * Today's implementation: a 32×32 colored placeholder derived from
 * the species id. The Pokémon sprite lifter (which would decode the
 * actual gMonFrontPicTable + gMonPaletteTable from the ROM) is a
 * larger engine task documented in the Phase 4 plan; until it
 * lands, this endpoint provides visually distinct placeholders so
 * the frontend's <PokemonSprite> + the SpawnGrid / TrainerInspector
 * row UI all render with the right shape + meaningful per-species
 * variation.
 *
 * When the real sprite lifter lands, this endpoint swaps in the
 * decoded RGBA pixels + reuses the same encodeRgbaPng path.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { graphics } from '@rom-introspection/engine';
import { findFirstGbaFile } from '../scan/binary-rom.js';
import { LruCache } from '../lib/lruCache.js';
import { promises as fsp } from 'node:fs';

interface ProjectSession {
  readonly id: string;
  readonly projectRoot: string;
}

interface RegisterPokemonSpriteRouteArgs {
  readonly app: FastifyInstance;
  readonly sessionStore: { get(id: string): ProjectSession | null | undefined };
  readonly errorResponse: (
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => unknown;
}

/** Map a u8 0..255 hue (×360 / 256) + s + l to RGB. Simple HSL→RGB. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Build a 32×32 RGBA placeholder PNG keyed by species id.
 *
 *  Distinct color per species id (hue rotation), small 2-tone gradient
 *  for shape, 1-pixel border. When `frame > 0`, the gradient direction
 *  rotates so cycling frames produces a visible "wobble" - meaningful
 *  visual feedback that the animation loop is running even before the
 *  real sprite lifter lands real walk frames. */
function buildPlaceholderPng(speciesId: number, frame: number = 0): Uint8Array {
  const W = 32;
  const H = 32;
  const px = new Uint8Array(W * H * 4);

  // Distribute hues across the 0..2047 species id range so consecutive
  // species look distinct.
  const hue = ((speciesId * 137) % 360 + 360) % 360;
  // Per-frame hue offset (small) so the placeholder "shimmers" when
  // animated. Real sprites will replace this with actual walk frames.
  const frameHue = (hue + frame * 8) % 360;
  const [r1, g1, b1] = hslToRgb(frameHue, 0.55, 0.55);
  const [r2, g2, b2] = hslToRgb(frameHue, 0.55, 0.32);

  // Frame controls the gradient direction so the 4-frame loop reads
  // as a circular motion: 0=NW→SE, 1=N→S, 2=NE→SW, 3=W→E.
  const gradients: Array<(x: number, y: number) => number> = [
    (x, y) => (x + y) / (W + H - 2),
    (_x, y) => y / (H - 1),
    (x, y) => (W - 1 - x + y) / (W + H - 2),
    (x) => x / (W - 1),
  ];
  const gradAt = gradients[frame % 4]!;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isBorder = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      const t = gradAt(x, y);
      const r = Math.round(r1 * (1 - t) + r2 * t);
      const g = Math.round(g1 * (1 - t) + g2 * t);
      const b = Math.round(b1 * (1 - t) + b2 * t);
      if (isBorder) {
        px[i + 0] = 30;
        px[i + 1] = 30;
        px[i + 2] = 30;
        px[i + 3] = 255;
      } else {
        px[i + 0] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      }
    }
  }

  return graphics.encodeRgbaPng(px, W, H);
}

/** Build a 128×32 horizontal strip of 4 frames. Used by the
 *  `/strip.png` endpoint for callers that want all frames in one
 *  request (e.g. a CSS sprite-sheet animation). */
function buildPlaceholderStripPng(speciesId: number): Uint8Array {
  const FRAME_COUNT = 4;
  const W = 32;
  const H = 32;
  const stripW = W * FRAME_COUNT;
  const px = new Uint8Array(stripW * H * 4);
  for (let f = 0; f < FRAME_COUNT; f++) {
    // Inline the per-frame build instead of decoding/encoding 4 PNGs.
    const framePixels = buildPlaceholderFramePixels(speciesId, f);
    for (let y = 0; y < H; y++) {
      const srcOff = y * W * 4;
      const dstOff = (y * stripW + f * W) * 4;
      px.set(framePixels.subarray(srcOff, srcOff + W * 4), dstOff);
    }
  }
  return graphics.encodeRgbaPng(px, stripW, H);
}

/** Extract from buildPlaceholderPng - returns the raw RGBA bytes
 *  for one frame so buildPlaceholderStripPng can copy them without
 *  going through PNG encode/decode. */
function buildPlaceholderFramePixels(
  speciesId: number,
  frame: number,
): Uint8Array {
  const W = 32;
  const H = 32;
  const px = new Uint8Array(W * H * 4);
  const hue = ((speciesId * 137) % 360 + 360) % 360;
  const frameHue = (hue + frame * 8) % 360;
  const [r1, g1, b1] = hslToRgb(frameHue, 0.55, 0.55);
  const [r2, g2, b2] = hslToRgb(frameHue, 0.55, 0.32);
  const gradients: Array<(x: number, y: number) => number> = [
    (x, y) => (x + y) / (W + H - 2),
    (_x, y) => y / (H - 1),
    (x, y) => (W - 1 - x + y) / (W + H - 2),
    (x) => x / (W - 1),
  ];
  const gradAt = gradients[frame % 4]!;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const isBorder = x === 0 || y === 0 || x === W - 1 || y === H - 1;
      const t = gradAt(x, y);
      const r = Math.round(r1 * (1 - t) + r2 * t);
      const g = Math.round(g1 * (1 - t) + g2 * t);
      const b = Math.round(b1 * (1 - t) + b2 * t);
      if (isBorder) {
        px[i + 0] = 30;
        px[i + 1] = 30;
        px[i + 2] = 30;
        px[i + 3] = 255;
      } else {
        px[i + 0] = r;
        px[i + 1] = g;
        px[i + 2] = b;
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

/** Phase 9H - Shared LRU cache backed by `lib/lruCache.ts`. Bumped
 *  to 2048 entries to account for the Phase 9B per-frame keys:
 *  each species now has up to 5 entries (4 walk frames + 1 strip),
 *  so 2048 covers ~400 distinct species per project + plenty of
 *  headroom for the typical hack's working set.
 *  Cleared on each process restart. */
const CACHE = new LruCache<Uint8Array>({
  maxEntries: 2048,
  label: 'pokemon-sprite',
});
function cacheGet(key: string): Uint8Array | undefined {
  return CACHE.get(key);
}
function cacheSet(key: string, png: Uint8Array): void {
  CACHE.set(key, png);
}

async function sha1OfRom(projectRoot: string): Promise<string> {
  const romPath = await findFirstGbaFile(projectRoot);
  if (!romPath) return 'no-rom';
  try {
    const bytes = await fsp.readFile(romPath);
    return createHash('sha1').update(bytes).digest('hex');
  } catch {
    return 'no-rom';
  }
}

export function registerPokemonSpriteRoute({
  app,
  sessionStore,
  errorResponse,
}: RegisterPokemonSpriteRouteArgs): void {
  app.get<{
    Params: { id: string; speciesIdParam: string };
    Querystring: { frame?: string };
  }>(
    '/api/projects/:id/pokemon-sprite/:speciesIdParam',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      // Strip the .png suffix the frontend appends to make the URL
      // look like a real image asset.
      const raw = req.params.speciesIdParam.replace(/\.png$/i, '');
      const speciesId = Number.parseInt(raw, 10);
      if (!Number.isInteger(speciesId) || speciesId < 0 || speciesId > 0xffff) {
        return errorResponse(reply, 400, 'internal_error', `speciesId must be a u16 integer; got "${raw}"`);
      }
      // Phase 9B - optional `?frame=N` selects one of the 4-frame
      // walk-animation cels. Defaults to 0 (static front pic).
      let frame = 0;
      if (req.query?.frame !== undefined) {
        const parsed = Number.parseInt(req.query.frame, 10);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3) {
          return errorResponse(
            reply,
            400,
            'internal_error',
            `frame must be an integer in 0..3; got "${req.query.frame}"`,
          );
        }
        frame = parsed;
      }
      const gameSha1 = await sha1OfRom(session.projectRoot);
      const cacheKey = `${gameSha1}:${String(speciesId)}:f${String(frame)}`;
      let png = cacheGet(cacheKey);
      if (!png) {
        png = buildPlaceholderPng(speciesId, frame);
        cacheSet(cacheKey, png);
      }
      // ETag matches the cache key → 304 on subsequent requests with
      // matching If-None-Match.
      const ifNoneMatch = req.headers['if-none-match'];
      const etag = `"${cacheKey}"`;
      if (ifNoneMatch === etag) {
        void reply.code(304);
        return null;
      }
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'private, max-age=300')
        .header('ETag', etag)
        .send(Buffer.from(png));
    },
  );

  // Phase 9B - multi-frame strip endpoint. Returns a 128×32 PNG with
  // all 4 walk frames laid out horizontally. Useful for CSS sprite-
  // sheet animation when the frontend wants a single request instead
  // of four.
  app.get<{ Params: { id: string; speciesIdParam: string } }>(
    '/api/projects/:id/pokemon-sprite/:speciesIdParam/strip',
    async (req, reply) => {
      const session = sessionStore.get(req.params.id);
      if (!session) {
        return errorResponse(reply, 404, 'session_not_found', 'Session not found');
      }
      const raw = req.params.speciesIdParam.replace(/\.png$/i, '');
      const speciesId = Number.parseInt(raw, 10);
      if (!Number.isInteger(speciesId) || speciesId < 0 || speciesId > 0xffff) {
        return errorResponse(
          reply,
          400,
          'internal_error',
          `speciesId must be a u16 integer; got "${raw}"`,
        );
      }
      const gameSha1 = await sha1OfRom(session.projectRoot);
      const cacheKey = `${gameSha1}:${String(speciesId)}:strip`;
      let png = cacheGet(cacheKey);
      if (!png) {
        png = buildPlaceholderStripPng(speciesId);
        cacheSet(cacheKey, png);
      }
      const ifNoneMatch = req.headers['if-none-match'];
      const etag = `"${cacheKey}"`;
      if (ifNoneMatch === etag) {
        void reply.code(304);
        return null;
      }
      return reply
        .header('Content-Type', 'image/png')
        .header('Cache-Control', 'private, max-age=300')
        .header('ETag', etag)
        .send(Buffer.from(png));
    },
  );
}
