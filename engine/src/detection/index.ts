/**
 * Public barrel for the detection module.
 *
 * Engine code consumes detection types through this barrel rather than
 * deep-importing - keeps the module's public surface auditable.
 */
export type {
  Confidence,
  Detection,
  DetectionDetected,
  DetectionNotDetected,
  DetectionPartial,
  DetectionStatus,
  Evidence,
  EvidenceKind,
} from './result.js';

export {
  asConfidence,
  assertNoEmptySuccess,
  DetectionInvariantError,
  EmptySuccessError,
  isConfidence,
  isEmptyValue,
  makeDetected,
  makeEvidence,
  makeNotDetected,
  makePartial,
} from './result.js';

export {
  CFRU_PROBE_SAMPLE_LENGTH,
  CFRU_PROBE_STEP,
  CFRU_PROBE_WINDOW_END,
  CFRU_PROBE_WINDOW_START,
  VANILLA_FRLG_ROM_SIZE,
  detectCfruHeuristic,
  type CfruHeuristicResult,
} from './cfru-heuristic.js';
