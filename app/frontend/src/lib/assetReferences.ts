// Pure asset cross-reference tracer for the AssetsView. Given a manifest + an
// asset id, returns the typed lists of every other entity that references the
// asset - Maps (as tileset OR as background music), ObjectEvents (graphics),
// DialogueNodes (portraits), and ScriptSteps (sound playback). The result
// drives the "where is this asset used?" pane and answers Phase 6 acceptance
// criterion 2 (the app identifies all locations an asset is used).

import type {
  DialogueNode,
  MapNode,
  ObjectEvent,
  ProjectManifest,
  ScriptStep,
} from '@rom-editor/shared';

export type MapAssetRole = 'tileset' | 'music';

export interface MapAssetReference {
  readonly map: MapNode;
  readonly role: MapAssetRole;
}

export interface AssetReferences {
  readonly maps: ReadonlyArray<MapAssetReference>;
  readonly objectEvents: ReadonlyArray<ObjectEvent>;
  readonly dialogueNodes: ReadonlyArray<DialogueNode>;
  readonly scriptSteps: ReadonlyArray<ScriptStep>;
}

const SOUND_MACRO_SOUND_KEYS: ReadonlyArray<string> = ['soundId'];

export function findAssetReferences(
  manifest: ProjectManifest,
  assetId: string,
): AssetReferences {
  const maps: MapAssetReference[] = [];
  for (const m of manifest.maps) {
    if (m.tilesetIds.includes(assetId)) maps.push({ map: m, role: 'tileset' });
    if (m.musicId === assetId) maps.push({ map: m, role: 'music' });
  }

  const objectEvents = manifest.objectEvents.filter((o) => o.graphicsId === assetId);
  const dialogueNodes = manifest.dialogue.filter((d) => d.portraitAssetId === assetId);

  const scriptSteps = manifest.scriptSteps.filter((s) => {
    for (const key of SOUND_MACRO_SOUND_KEYS) {
      const v = s.params[key];
      if (typeof v === 'string' && v === assetId) return true;
    }
    return false;
  });

  return { maps, objectEvents, dialogueNodes, scriptSteps };
}
