/**
 * Public barrel for the ROM-coverage module.
 *
 * See §5 + §7 + §9.7 of MASTER_PROMPT_ROM_INTROSPECTION.md for the contract.
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
