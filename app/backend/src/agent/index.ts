export type {
  EntityKind,
  FindReferencesResult,
  ListEntitiesItem,
  ListEntitiesResult,
  ListEntitiesUnavailable,
  ReadDecodedScriptResult,
  ReadDecodedScriptStep,
  ReadDecodedScriptUnavailable,
  ReadMapResult,
  ReadMapUnavailable,
  ReferenceHit,
  ToolContext,
  WorkspaceSummary,
  WorkspaceSummaryAvailable,
  WorkspaceSummaryUnavailable,
  WorkspaceSummaryUnavailableReason,
} from './types.js';

export {
  GET_WORKSPACE_SUMMARY_DESCRIPTION,
  GET_WORKSPACE_SUMMARY_TOOL_NAME,
  getWorkspaceSummary,
  getWorkspaceSummaryInputShape,
  getWorkspaceSummaryOutputShape,
} from './tools/get-workspace-summary.js';

export {
  FIND_REFERENCES_TO_DESCRIPTION,
  FIND_REFERENCES_TO_TOOL_NAME,
  findReferencesTo,
  findReferencesToInputShape,
} from './tools/find-references-to.js';

export {
  READ_MAP_DESCRIPTION,
  READ_MAP_TOOL_NAME,
  readMap,
  readMapInputShape,
} from './tools/read-map.js';

export {
  READ_DECODED_SCRIPT_DESCRIPTION,
  READ_DECODED_SCRIPT_TOOL_NAME,
  readDecodedScript,
  readDecodedScriptInputShape,
} from './tools/read-decoded-script.js';

export {
  LIST_ENTITIES_DESCRIPTION,
  LIST_ENTITIES_TOOL_NAME,
  listEntities,
  listEntitiesInputShape,
} from './tools/list-entities.js';

export { createAgentMcpServer } from './mcp-server.js';
export { findClaudeBinary } from './binary-discovery.js';
export { AgentSessionStore, type AgentSession } from './agent-session-store.js';
export { writeTempMcpConfig, type McpConfigHandle, type McpConfigOptions } from './mcp-config.js';
export {
  runAgentTurn,
  TurnError,
  type RunTurnOptions,
  type TurnErrorCode,
  type TurnResult,
} from './spawner.js';
export { PatchStore, type CreateProposalInput } from './patch-store.js';
export {
  PROPOSE_PATCH_DESCRIPTION,
  PROPOSE_PATCH_TOOL_NAME,
  proposePatch,
  proposePatchInputShape,
  ProposePatchError,
} from './tools/propose-patch.js';
export {
  applyEdits,
  PatchApplyError,
  type PatchApplyErrorCode,
  type ApplyEditsResult,
} from './patch-applier.js';
export {
  PROPOSE_RENAME_DESCRIPTION,
  PROPOSE_RENAME_TOOL_NAME,
  proposeRename,
  proposeRenameInputShape,
  type ProposeRenameResult,
} from './tools/propose-rename.js';
export {
  LIST_SPECIES_LIBRARIES_DESCRIPTION,
  LIST_SPECIES_LIBRARIES_TOOL_NAME,
  listSpeciesLibraries,
  listSpeciesLibrariesInputShape,
} from './tools/list-species-libraries.js';
