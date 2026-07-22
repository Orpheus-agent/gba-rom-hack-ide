export type MoveEventKind = 'objectEvent' | 'warp' | 'trigger';

export interface MoveEventRequest {
  readonly x: number;
  readonly y: number;
}

export interface MoveEventResponse {
  readonly entityKind: MoveEventKind;
  readonly entityId: string;
  readonly mapId: string;
  readonly previous: { readonly x: number; readonly y: number };
  readonly next: { readonly x: number; readonly y: number };
  readonly mapJsonPath: string;
}

export type MoveEventErrorCode =
  | 'session_not_found'
  | 'entity_not_found'
  | 'map_not_found'
  | 'coord_out_of_bounds'
  | 'invalid_coord'
  | 'mutation_failed';

export interface MoveEventErrorResponse {
  readonly error: {
    readonly code: MoveEventErrorCode;
    readonly message: string;
  };
}
