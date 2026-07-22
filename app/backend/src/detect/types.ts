import type {
  CoverageSummary,
  DetectedSubsystem,
  ProjectKind,
  RomBinaryStats,
  RomCartridgeHeader,
  RomStructure,
} from '@rom-editor/shared';

/**
 * A detector for one project kind. Returns its own confidence (0..1) over the
 * given project root. The orchestrator combines results from multiple detectors
 * to choose the final ProjectIdentity.
 */
export interface ProjectDetector {
  readonly kind: ProjectKind & ('decomp' | 'patch');
  readonly name: string;
  detect(projectRoot: string): Promise<DetectorResult>;
}

export interface DetectorResult {
  /** 0..1 confidence that this kind matches the project. */
  readonly confidence: number;
  /** Human-readable identity (e.g. "pokeemerald (decomp)", "Patch project (2 patch files)"). */
  readonly displayName: string;
  readonly baseGame: string | null;
  readonly fork: string | null;
  readonly featureFlags: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
  /** Concrete files/folders that drove this detector's signal. */
  readonly evidence: ReadonlyArray<string>;
  /** Populated by the patch detector when a .gba ROM was found + its
   *  binary data tables could be read. Carries species names + counts. */
  readonly romBinary?: RomBinaryStats;
  /** Populated by the patch detector when a .gba ROM was found + its
   *  cartridge header parsed cleanly (UW-1-T3). Carries the engine's
   *  parsed header so the editor's identity card can render
   *  game code / title / maker / version / known-game visually. */
  readonly romHeader?: RomCartridgeHeader;
  /** Populated by the patch detector when a .gba ROM was found + its
   *  structural picture was scanned (UW-1-T4). Carries memoryLayout +
   *  pointerTables + compressionRegions inventories lifted from the
   *  engine's WorkspaceIdentity. */
  readonly romStructure?: RomStructure;
  /** Per-subsystem detection summaries from the 5 Cat 2/4 subsystem
   *  detectors. Populated by the patch detector during the bare-ROM
   *  structural scan. */
  readonly detectedSubsystems?: ReadonlyArray<DetectedSubsystem>;
  /** Coverage summary for Cat 15 unknowns-policy surface. Populated by
   *  the patch detector during the bare-ROM structural scan. */
  readonly coverageSummary?: CoverageSummary;
  /** Modernize-and-Ship slice 5 - hint that the editor can offer a
   *  one-click ROM upgrade. Set to 'vanilla-frlg-rev0' when the
   *  loaded ROM matches the canonical FireRed USA rev 0 SHA-1.
   *  Forwarded into ProjectIdentity by detect/index.ts. */
  readonly upgradeOffer?: 'vanilla-frlg-rev0' | null;
  /** Phase 6.2 - set when the project's op-log records a
   *  `modernize_rom` entry whose post-apply SHA-1 matches the
   *  currently-loaded ROM. Strongest evidence that the editor's own
   *  modernise flow produced this ROM; the displayName overlay
   *  (Phase 6.5) reads this to gate vanilla-truth assertions.
   *  Forwarded into ProjectIdentity by detect/index.ts. */
  readonly modernizedBy?: 'CFRU' | 'CFRU+DPE' | null;
  /** Phase 6.2 - true when the vanilla-truth overlay is safe to apply
   *  to this ROM. Derived from `modernizedBy` (op-log proof) or a
   *  recognised fingerprint match. Forwarded into ProjectIdentity. */
  readonly overlaySafe?: boolean;
}
