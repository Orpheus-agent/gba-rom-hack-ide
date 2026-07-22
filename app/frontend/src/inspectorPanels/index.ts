import { registerInspectorPanel } from '../lib/inspectorRegistry';
import { FlagInspector } from './FlagInspector';
import { MoveInspector } from './MoveInspector';
import { TypeInspector } from './TypeInspector';
import { SpeciesInspector } from './SpeciesInspector';
import { TrainerInspector } from './TrainerInspector';
import { ItemInspector } from './ItemInspector';
import { HealLocationInspector } from './HealLocationInspector';
import { ObjectEventInspector } from './ObjectEventInspector';
import { WarpInspector } from './WarpInspector';
import { TriggerInspector } from './TriggerInspector';
import { EncounterTableInspector } from './EncounterTableInspector';
import { DialogueInspector } from './DialogueInspector';
import { ScriptStepInspector } from './ScriptStepInspector';

// Phase P.3 - Central registration entry point. Importing this module
// (from `main.tsx`) registers every shipped inspector panel for its
// EntityKind. New panels added in Phase S subphases follow the same
// pattern: import + register.

let initialized = false;

export function initializeInspectorPanels(): void {
  if (initialized) return;
  initialized = true;

  registerInspectorPanel({
    kind: 'flag',
    slot: 'identity',
    component: FlagInspector,
    description: 'P.3 sample · Flag metadata + Q.2 cross-references',
  });
  registerInspectorPanel({
    kind: 'variable',
    slot: 'identity',
    component: FlagInspector,
    description: 'Q.2 · variable metadata + cross-references',
  });
  registerInspectorPanel({
    kind: 'move',
    slot: 'identity',
    component: MoveInspector,
    description: 'S.10 · Move stats + species learnset back-references',
  });
  registerInspectorPanel({
    kind: 'ability',
    slot: 'identity',
    component: SpeciesInspector,
    description: 'Consolidated · ability lookup opens SpeciesInspector with abilities section',
  });
  registerInspectorPanel({
    kind: 'type',
    slot: 'identity',
    component: TypeInspector,
    description: 'S.12 · Type effectiveness chart + species back-references',
  });
  registerInspectorPanel({
    kind: 'species',
    slot: 'identity',
    component: SpeciesInspector,
    description:
      'S.6 · Pokémon stats + types + abilities + level-up learnset with click-through',
  });
  registerInspectorPanel({
    kind: 'trainer',
    slot: 'identity',
    component: TrainerInspector,
    description: 'S.7 · Trainer class + party (species/moves/items click-through) + AI flags',
  });
  registerInspectorPanel({
    kind: 'item',
    slot: 'identity',
    component: ItemInspector,
    description: 'S.9 · Item metadata + trainer/script back-references',
  });
  registerInspectorPanel({
    kind: 'healLocation',
    slot: 'identity',
    component: HealLocationInspector,
    description: 'S.13 · Heal location (SPAWN slot) + destination map link',
  });
  registerInspectorPanel({
    kind: 'pokedexEntry',
    slot: 'identity',
    component: SpeciesInspector,
    description: 'Consolidated · Pokédex entry opens SpeciesInspector with pokedex section',
  });
  registerInspectorPanel({
    kind: 'objectEvent',
    slot: 'identity',
    component: ObjectEventInspector,
    description: 'S.2 · NPC/object event readout with map/flag/script click-through',
  });
  registerInspectorPanel({
    kind: 'warp',
    slot: 'identity',
    component: WarpInspector,
    description: 'S.3 · Warp endpoints + return-path detection',
  });
  registerInspectorPanel({
    kind: 'trigger',
    slot: 'identity',
    component: TriggerInspector,
    description: 'S.8-lite · Trigger kind + condition + script step chain',
  });
  registerInspectorPanel({
    kind: 'multichoice',
    slot: 'identity',
    component: DialogueInspector,
    description: 'Consolidated · multichoice opens DialogueInspector with multichoice section',
  });
  registerInspectorPanel({
    kind: 'encounterTable',
    slot: 'identity',
    component: EncounterTableInspector,
    description: 'S.1 · Wild encounter table slots with species click-through',
  });
  registerInspectorPanel({
    kind: 'dialogue',
    slot: 'identity',
    component: DialogueInspector,
    description: 'Dialogue node text + choices + caller scripts with inline edit',
  });
  registerInspectorPanel({
    kind: 'scriptStep',
    slot: 'identity',
    component: ScriptStepInspector,
    description:
      'V-lite · Script step kind + params with click-through references (flag/var/species/move/item/dialogue/map)',
  });
  registerInspectorPanel({
    kind: 'trainerClass',
    slot: 'identity',
    component: SpeciesInspector,
    description: 'Consolidated · trainer class opens SpeciesInspector with class section',
  });
  // Asset / Song / Tileset have no inspector panel - they're surfaced via
  // the Advanced drawer's AssetsView / TilesetsView. Selecting one with
  // no panel registered yields the empty-inspector slot, and the matching
  // View renders the data grid.
  // Region / Structure also have no inspector panel - region info is in
  // the atlas tooltip; structures get a floor-stack overlay on the atlas.
  registerInspectorPanel({
    kind: 'palette',
    slot: 'identity',
    component: ObjectEventInspector,
    description: 'Consolidated · palette opens ObjectEventInspector with palette section',
  });
  registerInspectorPanel({
    kind: 'sprite',
    slot: 'identity',
    component: ObjectEventInspector,
    description: 'Consolidated · sprite opens ObjectEventInspector with graphics section',
  });
}
