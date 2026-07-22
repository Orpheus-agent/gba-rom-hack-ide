/**
 * propose_apply_template - Phase 8H-4.
 *
 * Place a previously-mined template (a 3x3 or 2x2 vanilla pattern
 * from the tile-intel library) at a specific (x, y) anchor on an
 * existing map. The tool emits a `propose_paint_map_blocks` plan
 * - it does NOT apply the paint itself, so the user reviews each
 * placement.
 *
 * Templates that would land partially off the map are partially
 * applied (cells outside the bounds are dropped + counted).
 */

import { z } from 'zod';

import {
  getDefaultTileIntelSupervisor,
  type TileIntelSupervisor,
} from '../../tile-intel/supervisor.js';
import { TileIntelClient } from '../../tile-intel/client.js';
import type {
  ApplyTemplateResponse,
  TileIntelUnavailable,
} from '../../tile-intel/types.js';
import type { ToolContext } from '../types.js';

export const PROPOSE_APPLY_TEMPLATE_TOOL_NAME = 'propose_apply_template';

export const PROPOSE_APPLY_TEMPLATE_DESCRIPTION =
  'Place a previously-mined map template at an anchor coordinate.\n' +
  'Templates are 2x2 / 3x3 patterns extracted from vanilla pret\n' +
  'maps - useful primitives like "grass-tall on path edge" or\n' +
  '"cave wall corner".\n\n' +
  'Inputs:\n' +
  '  - `mapId`: the map to apply the template to (the tool will\n' +
  '    look up width / height from the manifest).\n' +
  '  - `templateSlug`: pattern-3x3-xxxxxxxx from the tile-intel\n' +
  '    library. Use propose_browse_tileset_library or a future\n' +
  '    8I frontend gallery to discover candidates.\n' +
  '  - `anchorX` / `anchorY`: top-left coordinate to anchor the\n' +
  '    template at (in tile coordinates).\n' +
  '  - `tagBindings`: optional `{ slot: tagSlug }` for tag-slotted\n' +
  '    templates (passthrough - v1 templates have concrete IDs).\n\n' +
  'Returns a plan: a single `propose_paint_map_blocks` call with\n' +
  'an `explicit` blockIds array. The plan covers ONLY cells the\n' +
  'template fills (4 for a 2x2, 9 for a 3x3). The user calls\n' +
  '`propose_paint_map_blocks` with the returned args to apply.';

export const proposeApplyTemplateInputShape = {
  mapId: z.string().min(1),
  templateSlug: z.string().min(1).max(200),
  anchorX: z.number().int().min(0).max(1023),
  anchorY: z.number().int().min(0).max(1023),
  tagBindings: z.record(z.string(), z.string()).optional(),
  /** When provided, the tool checks the template fits the map; when
   *  omitted, it assumes a generous 1024x1024 bound. */
  mapWidth: z.number().int().min(1).max(1024).optional(),
  mapHeight: z.number().int().min(1).max(1024).optional(),
} as const;

export type ProposeApplyTemplateArgs = {
  mapId: string;
  templateSlug: string;
  anchorX: number;
  anchorY: number;
  tagBindings?: Record<string, string>;
  mapWidth?: number;
  mapHeight?: number;
};

export interface ApplyTemplatePlannedPaint {
  readonly tool: 'propose_paint_map_blocks';
  readonly args: {
    readonly mapId: string;
    readonly rect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
    readonly mode: 'explicit';
    readonly blockIds: ReadonlyArray<number>;
    readonly description: string;
  };
  readonly description: string;
}

export interface ProposeApplyTemplateSuccess {
  readonly ok: true;
  readonly summary: string;
  readonly templateSlug: string;
  readonly role: string;
  readonly width: number;
  readonly height: number;
  readonly cells: ApplyTemplateResponse['cells'];
  readonly cellsOutOfBounds: number;
  readonly plan: ReadonlyArray<ApplyTemplatePlannedPaint>;
}

export interface ProposeApplyTemplateFailure {
  readonly ok: false;
  readonly message: string;
  readonly reason:
    | 'invalid_input'
    | 'template_not_found'
    | 'sidecar_offline'
    | 'sidecar_error';
  readonly unavailable?: TileIntelUnavailable;
}

export type ProposeApplyTemplateResult =
  | ProposeApplyTemplateSuccess
  | ProposeApplyTemplateFailure;

type SupervisorFactory = () => TileIntelSupervisor;

export interface ProposeApplyTemplateDeps {
  readonly supervisorFactory?: SupervisorFactory;
  readonly clientForTests?: TileIntelClient;
}

/** Render a list of `(x, y, tileset_slug, metatile_index)` cells
 *  into a `propose_paint_map_blocks` plan covering the cells'
 *  bounding rect. Cells that don't match the rect get the value
 *  -1 in the blockIds array - but in practice every cell DOES sit
 *  in the rect because the rect IS the bounding box. */
function cellsToPaintPlan(
  mapId: string,
  templateSlug: string,
  cells: ApplyTemplateResponse['cells'],
): ApplyTemplatePlannedPaint | null {
  if (cells.length === 0) return null;
  const minX = cells.reduce((m, c) => Math.min(m, c.x), cells[0]!.x);
  const minY = cells.reduce((m, c) => Math.min(m, c.y), cells[0]!.y);
  const maxX = cells.reduce((m, c) => Math.max(m, c.x), cells[0]!.x);
  const maxY = cells.reduce((m, c) => Math.max(m, c.y), cells[0]!.y);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const cellMap = new Map<string, number>();
  for (const c of cells) {
    // u16 metatile ID, no extra collision/elevation bits.
    cellMap.set(`${c.x},${c.y}`, c.metatile_index & 0x3ff);
  }
  const blockIds: number[] = [];
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      // Fall back to 0 when the cell didn't exist (e.g. partial
      // anchors near map edges) - the caller can review.
      blockIds.push(cellMap.get(`${x},${y}`) ?? 0);
    }
  }
  return {
    tool: 'propose_paint_map_blocks',
    args: {
      mapId,
      rect: { x: minX, y: minY, w, h },
      mode: 'explicit',
      blockIds,
      description: `Apply template ${templateSlug} (${w}×${h}) at (${minX}, ${minY})`,
    },
    description: `Paint ${w}×${h} block from template ${templateSlug} at (${minX}, ${minY}).`,
  };
}

export async function proposeApplyTemplate(
  ctx: ToolContext,
  args: ProposeApplyTemplateArgs,
  deps: ProposeApplyTemplateDeps = {},
): Promise<ProposeApplyTemplateResult> {
  void ctx;

  let client: TileIntelClient;
  if (deps.clientForTests) {
    client = deps.clientForTests;
  } else {
    const factory = deps.supervisorFactory ?? (() => getDefaultTileIntelSupervisor());
    const supervisor = factory();
    const status = await supervisor.ensureReady();
    if (!status.available) {
      return {
        ok: false,
        reason: 'sidecar_offline',
        unavailable: status,
        message:
          'The tile-intelligence sidecar is offline. Template application needs ' +
          'it running.',
      };
    }
    client = new TileIntelClient(status.baseUrl);
  }

  let response: ApplyTemplateResponse;
  try {
    response = await client.applyTemplate({
      template_slug: args.templateSlug,
      anchor: { x: args.anchorX, y: args.anchorY },
      tag_bindings: args.tagBindings,
      map_width: args.mapWidth,
      map_height: args.mapHeight,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('404')) {
      return {
        ok: false,
        reason: 'template_not_found',
        message:
          `The tile-intelligence sidecar doesn\'t know about template ` +
          `${args.templateSlug}. Use propose_browse_tileset_library to list ` +
          `known tilesets, or rebuild templates via the sidecar\'s ` +
          `/v1/grammar/templates/build endpoint.`,
      };
    }
    return {
      ok: false,
      reason: 'sidecar_error',
      message: 'The tile-intelligence sidecar returned an error: ' + message,
    };
  }

  const planned = cellsToPaintPlan(args.mapId, args.templateSlug, response.cells);
  const plan: ApplyTemplatePlannedPaint[] = planned ? [planned] : [];

  const lines: string[] = [];
  lines.push(
    `Template ${args.templateSlug} ready to apply at (${args.anchorX}, ${args.anchorY}).`,
  );
  lines.push(
    `Role: ${response.role}. Size: ${response.width}×${response.height}. ` +
      `Cells in bounds: ${response.cells.length}` +
      (response.cells_out_of_bounds > 0
        ? ` (${response.cells_out_of_bounds} dropped at map edge).`
        : '.'),
  );
  lines.push(
    `Apply by calling propose_paint_map_blocks with the plan above.`,
  );

  return {
    ok: true,
    summary: lines.join('\n'),
    templateSlug: response.template_slug,
    role: response.role,
    width: response.width,
    height: response.height,
    cells: response.cells,
    cellsOutOfBounds: response.cells_out_of_bounds,
    plan,
  };
}
