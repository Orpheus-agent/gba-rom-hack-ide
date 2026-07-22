export type SearchableEntityKind =
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

export interface SearchRequest {
  readonly query: string;
  readonly limit?: number;
}

export interface SearchHit {
  readonly entityKind: SearchableEntityKind;
  readonly entityId: string;
  readonly entityName: string;
  readonly score: number;
  readonly snippet: string | null;
  readonly matchedTerms: ReadonlyArray<string>;
}

export interface SearchResponse {
  readonly query: string;
  readonly tokenizedTerms: ReadonlyArray<string>;
  readonly hits: ReadonlyArray<SearchHit>;
  readonly truncated: boolean;
  readonly searchedAtUtc: string;
}
