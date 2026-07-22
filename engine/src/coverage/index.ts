/**
 * Public barrel for the ROM-coverage module.
 *
 * Contract: coverage is reported for every ingest, is monotone
 * non-decreasing, and every ROM byte is classified, scored-UNKNOWN, or
 * counted as `unaccounted`. See coverage.ts for the full statement.
 */
export type {
  CoverageRegion,
  CoverageReport,
  ProbableClass,
  RegionKind,
} from './coverage.js';

export {
  CoverageInvariantError,
  CoverageMap,
  OverlapError,
  assertMonotoneCoverage,
  formatCoverageLogLine,
} from './coverage.js';
