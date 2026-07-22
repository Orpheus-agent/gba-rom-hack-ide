/**
 * @rom-introspection/engine - universal Pokémon-family GBA ROM workspace
 * reconstruction & full-engine introspection engine.
 *
 * Governed by MASTER_PROMPT_ROM_INTROSPECTION.md at the Project Root.
 * Phase 0 surface: universal Detection result type, ROM-coverage metric
 * infrastructure, ROM loader + GBA cartridge-header parser, the
 * header-fingerprint detector, the ingest orchestrator that enforces PD 1
 * at the boundary, and the corpus walker. Later phases add detectors that
 * produce Detection results and CoverageMap rows through the same
 * orchestrator + contract.
 */
export * as detection from './detection/index.js';
export * as coverage from './coverage/index.js';
export * as identity from './identity/index.js';
export * as rom from './rom/index.js';
export * as detectors from './detectors/index.js';
export * as signatures from './signatures/index.js';
export * as pointers from './pointers/index.js';
export * as compression from './compression/index.js';
export * as maps from './maps/index.js';
export * as audio from './audio/index.js';
export * as scripts from './scripts/index.js';
export * as species from './species/index.js';
export * as trainers from './trainers/index.js';
export * as encounters from './encounters/index.js';
export * as runtime from './runtime/index.js';
export * as search from './search/index.js';
export * as workspace from './workspace/index.js';
export * as patch from './patch/index.js';
export * as plugins from './plugins/index.js';
export * as ingest from './ingest/index.js';
export * as classify from './classify/index.js';
export * as graph from './graph/index.js';
export * as world from './world/index.js';
export * as corpus from './corpus/index.js';
export * as fixtures from './fixtures/index.js';
export * as text from './text/index.js';
export * as moves from './moves/index.js';
export * as battle from './battle/index.js';
export * as items from './items/index.js';
export * as abilities from './abilities/index.js';
export * as saveData from './save-data/index.js';
export * as menus from './menus/index.js';
export * as graphics from './graphics/index.js';
export * as emulator from './emulator/index.js';
