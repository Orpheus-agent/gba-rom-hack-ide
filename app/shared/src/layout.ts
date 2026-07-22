export interface LayoutCellDecoded {
  /** Metatile id (0..1023 in pokeemerald-class). */
  readonly metatileId: number;
  /** Collision attribute (0..3). */
  readonly collision: number;
  /** Elevation attribute (0..15). */
  readonly elevation: number;
}

export interface LayoutData {
  /** Engine identifier as declared in layout.json (e.g. "LAYOUT_LITTLEROOT_TOWN"). */
  readonly id: string;
  /** Human-readable name (defaults to id when absent). */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly borderWidth: number;
  readonly borderHeight: number;
  readonly primaryTileset: string | null;
  readonly secondaryTileset: string | null;
  /** Decoded cells laid out row-major. Length = width * height. */
  readonly cells: ReadonlyArray<LayoutCellDecoded>;
  /** Source path the parser read (relative to project root). */
  readonly sourceLayoutJsonPath: string;
}

export interface LayoutErrorResponse {
  readonly error: {
    readonly code:
      | 'session_not_found'
      | 'layout_not_found'
      | 'layout_parse_failed'
      | 'internal_error';
    readonly message: string;
  };
}
