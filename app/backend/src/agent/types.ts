import type { ProjectKind } from '@rom-editor/shared';

export interface ToolContext {
  readonly projectRoot: string;
  /**
   * Base URL for HTTP callbacks to the Fastify backend (e.g.
   * `http://127.0.0.1:8717`). Tools that need to push state into the
   * backend (propose_patch) read this; manifest-reader tools ignore it.
   * Set from ROM_EDITOR_BASE_URL env at MCP server startup.
   */
  readonly baseUrl?: string;
}

export type EntityKind =
  | 'map'
  | 'warp'
  | 'trigger'
  | 'objectEvent'
  | 'dialogue'
  | 'flag'
  | 'variable'
  | 'encounterTable'
  | 'trainer'
  | 'scriptStep'
  | 'asset';

export interface ReferenceHit {
  readonly referrerKind: EntityKind;
  readonly referrerId: string;
  readonly referrerName: string;
  readonly field: string;
  readonly mapId?: string | null;
  readonly snippet?: string;
}

export interface FindReferencesResult {
  readonly target: { readonly kind: string; readonly id: string };
  readonly references: ReadonlyArray<ReferenceHit>;
  readonly truncated: boolean;
  readonly summary: string;
}

export interface ReadMapResult {
  readonly available: true;
  readonly map: {
    readonly id: string;
    readonly name: string;
    readonly group: string;
    readonly dimensions: { readonly width: number; readonly height: number };
    readonly tilesetIds: ReadonlyArray<string>;
    readonly musicId: string | null;
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
  };
  readonly warps: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly fromCoord: { readonly x: number; readonly y: number };
    readonly toMapId: string;
    readonly toCoord: { readonly x: number; readonly y: number };
  }>;
  readonly triggers: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly coord: { readonly x: number; readonly y: number } | null;
    readonly scriptStepCount: number;
  }>;
  readonly objectEvents: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly coord: { readonly x: number; readonly y: number };
    readonly graphicsId: string | null;
    readonly scriptId: string | null;
    readonly flagId: string | null;
    readonly trainerType: string | null;
  }>;
  readonly encounterTables: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly slotCount: number;
  }>;
  readonly trainersOnMap: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly className: string;
    readonly partySize: number;
  }>;
  readonly connections: ReadonlyArray<{
    readonly direction: number;
    readonly offset: number;
    readonly destMapId: string | null;
  }>;
}

export interface ReadMapUnavailable {
  readonly available: false;
  readonly mapId: string;
  readonly reason: 'manifest_not_found' | 'map_not_found';
  readonly message: string;
}

export interface ReadDecodedScriptStep {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ReadDecodedScriptResult {
  readonly available: true;
  readonly scriptId: string;
  readonly matchMode: 'exact' | 'prefix' | 'chain';
  readonly steps: ReadonlyArray<ReadDecodedScriptStep>;
  readonly truncated: boolean;
}

export interface ReadDecodedScriptUnavailable {
  readonly available: false;
  readonly scriptId: string;
  readonly reason: 'manifest_not_found' | 'script_not_found';
  readonly message: string;
}

export interface ListEntitiesItem {
  readonly id: string;
  readonly name: string;
  readonly extras: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ListEntitiesResult {
  readonly available: true;
  readonly kind: EntityKind;
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
  readonly items: ReadonlyArray<ListEntitiesItem>;
}

export interface ListEntitiesUnavailable {
  readonly available: false;
  readonly kind: EntityKind;
  readonly reason: 'manifest_not_found';
  readonly message: string;
}

export interface WorkspaceSummaryAvailable {
  readonly available: true;
  readonly projectRoot: string;
  readonly generatedAtUtc: string;
  readonly identity: {
    readonly kind: ProjectKind;
    readonly displayName: string;
    readonly baseGame: string | null;
    readonly fork: string | null;
    readonly confidence: number;
  };
  readonly counts: {
    readonly maps: number;
    readonly warps: number;
    readonly triggers: number;
    readonly objectEvents: number;
    readonly dialogue: number;
    readonly flags: number;
    readonly variables: number;
    readonly encounterTables: number;
    readonly trainers: number;
    readonly scriptSteps: number;
    readonly assets: number;
  };
}

export type WorkspaceSummaryUnavailableReason =
  | 'manifest_not_found'
  | 'manifest_malformed';

export interface WorkspaceSummaryUnavailable {
  readonly available: false;
  readonly projectRoot: string;
  readonly reason: WorkspaceSummaryUnavailableReason;
  readonly message: string;
}

export type WorkspaceSummary = WorkspaceSummaryAvailable | WorkspaceSummaryUnavailable;
