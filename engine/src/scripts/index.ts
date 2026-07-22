export {
  SCRIPT_OPCODE_TABLE_ENTRY_SIZE_BYTES,
  SCRIPT_OPCODE_TABLE_MAX_ENTRIES,
  SCRIPT_OPCODE_TABLE_MIN_ENTRIES,
  scanScriptOpcodeTable,
  type ScanScriptOpcodeTableOptions,
  type ScriptOpcodeTable,
} from './opcode-table.js';

export {
  THUMB_BL_INSTRUCTION_SIZE_BYTES,
  tryDecodeThumbBL,
  type ThumbBL,
} from './thumb-disasm.js';

export {
  HANDLER_ANALYSIS_DEFAULT_MAX_INSTRUCTIONS,
  HANDLER_ANALYSIS_DEFAULT_TOP_N,
  analyzeHandler,
  analyzeScriptHandlers,
  helperCallHistogram,
  inferOpcodeHelperProfiles,
  type CommonHelperFunction,
  type HandlerAnalysis,
  type HandlerWalkStopReason,
  type OpcodeHelperProfile,
  type ScriptHandlersAnalysis,
} from './handler-analysis.js';

export {
  BYTECODE_WALKER_DEFAULT_MAX_OPCODES,
  walkScriptBytecode,
  type BytecodeWalkerStopReason,
  type WalkScriptBytecodeOptions,
  type WalkedOpcode,
  type WalkedScriptBody,
} from './bytecode-walker.js';

export {
  renderWalkedBody,
  type RenderWalkedBodyOptions,
} from './decompile.js';

export {
  classifyOpcodeVariableAccess,
  detectVariableAccessSites,
  type VariableAccessKind,
  type VariableAccessSite,
} from './variable-access.js';

export {
  aggregateVariableUsage,
  classifyVariableRole,
  type VariableAccessRecord,
  type VariableIncomingEdgeKind,
  type VariableRole,
  type VariableUsageProfile,
} from './variable-roles.js';

export {
  deriveUnlockChains,
  type UnlockChain,
} from './unlock-chains.js';

export {
  BRANCH_OPERATOR_SYMBOLS,
  MOVEMENT_END_BYTE,
  MSGBOX_CALLSTD_TYPES,
  branchOperatorToConditionByte,
  conditionByteToBranchOperator,
  getGen3OpcodeSpec,
  getTrainerbattleArgBytes,
  listGen3OpcodeSpecs,
  type BranchOperator,
  type Gen3OpcodeSpec,
} from './gen3-script-opcodes.js';

export {
  MAX_OPCODES_PER_SCRIPT,
  decodeBinaryScript,
  type DecodeStopReason,
  type DecodedScript,
  type DecodedScriptStep,
  type ScriptStepKind,
} from './binary-script-decoder.js';

export {
  GBA_ROM_BASE,
  ScriptEncodeError,
  encodeDecodedSteps,
  encodeScript,
  encodeStep,
  type AllocateRequest,
  type EncodableStep,
  type EncodeContext,
} from './binary-script-encoder.js';

// Phase 3.5 - in-memory script step simulator.
export {
  simulateScript,
  type ScriptSimOptions,
  type ScriptSimResult,
  type ScriptSimState,
} from './step-simulator.js';
