// Shared plugin manifest types - see DECISIONS.md D-0019 for the rationale
// behind the declarative-only design.
//
// A plugin manifest is a single JSON file in `<projectRoot>/.editor/plugins/`
// that declares zero or more extensions the editor evaluates against the
// canonical manifest. All evaluation is performed by the editor itself; the
// plugin file contains data, never code.

export type ProjectEntityKind =
  | 'map'
  | 'warp'
  | 'trigger'
  | 'objectEvent'
  | 'flag'
  | 'variable'
  | 'encounterTable'
  | 'trainer'
  | 'dialogue'
  | 'asset'
  | 'scriptStep';

export type LintSeverity = 'warn' | 'info';

// Each predicate kind is a small, intentionally narrow shape that covers
// a real project-specific design rule. Future kinds can be added; existing
// kinds are stable.
export type ValidatorPredicate =
  | {
      readonly kind: 'entity_pattern';
      readonly entityKind: ProjectEntityKind;
      readonly idPattern: string;
    }
  | {
      readonly kind: 'entity_count';
      readonly entityKind: ProjectEntityKind;
      readonly filter?: {
        readonly fieldPath: string;
        readonly equals: string | number | boolean;
      };
      readonly min?: number;
      readonly max?: number;
    }
  | {
      readonly kind: 'entity_reference_required';
      readonly entityKind: ProjectEntityKind;
      readonly referenceFieldPath: string;
      readonly mustReferenceKind: ProjectEntityKind;
    }
  | {
      readonly kind: 'field_pattern';
      readonly entityKind: ProjectEntityKind;
      readonly fieldPath: string;
      readonly pattern: string;
      readonly mustMatch: boolean;
    };

export interface ValidatorExtension {
  readonly ruleId: string;
  readonly severity: LintSeverity;
  readonly message: string;
  readonly predicate: ValidatorPredicate;
}

export interface EventTypeExtension {
  readonly macroName: string;
  readonly kindAlias: string;
  readonly description: string;
}

export interface MapLayerExtension {
  readonly layerId: string;
  readonly label: string;
  readonly source: string;
  readonly color: string;
}

export interface AdapterExtension {
  readonly adapterId: string;
  readonly direction: 'import' | 'export';
  readonly label: string;
  readonly description: string;
}

export interface PluginManifest {
  readonly id: string;
  readonly label: string;
  readonly version: string;
  readonly description: string;
  readonly validators?: ReadonlyArray<ValidatorExtension>;
  readonly eventTypes?: ReadonlyArray<EventTypeExtension>;
  readonly mapLayers?: ReadonlyArray<MapLayerExtension>;
  readonly adapters?: ReadonlyArray<AdapterExtension>;
}

export interface PluginParseError {
  readonly filePath: string;
  readonly code:
    | 'invalid_json'
    | 'invalid_shape'
    | 'duplicate_id'
    | 'duplicate_rule_id';
  readonly message: string;
}

export interface PluginsResponse {
  readonly projectRoot: string;
  readonly pluginsDir: string;
  readonly plugins: ReadonlyArray<PluginManifest>;
  readonly parseErrors: ReadonlyArray<PluginParseError>;
}
