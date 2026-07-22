import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractTrainers, parseTrainers } from './trainers.js';

const TRAINERS_H = `
const struct Trainer gTrainers[] = {
    [TRAINER_NONE] =
    {
        .partyFlags = 0,
        .trainerClass = TRAINER_CLASS_PKMN_TRAINER_1,
        .encounterMusic_gender = TRAINER_ENCOUNTER_MUSIC_MALE,
        .trainerPic = TRAINER_PIC_HIKER,
        .trainerName = _(""),
        .items = {ITEM_NONE, ITEM_NONE, ITEM_NONE, ITEM_NONE},
        .doubleBattle = FALSE,
        .aiFlags = 0,
        .partySize = 0,
        .party = {.NoItemDefaultMoves = NULL},
    },
    [TRAINER_SAWYER_1] =
    {
        .partyFlags = 0,
        .trainerClass = TRAINER_CLASS_CAMPER,
        .encounterMusic_gender = TRAINER_ENCOUNTER_MUSIC_MALE,
        .trainerPic = TRAINER_PIC_CAMPER,
        .trainerName = _("SAWYER"),
        .items = {ITEM_NONE, ITEM_NONE, ITEM_NONE, ITEM_NONE},
        .doubleBattle = FALSE,
        .aiFlags = AI_SCRIPT_CHECK_BAD_MOVE,
        .partySize = 3,
        .party = {.NoItemDefaultMoves = sParty_Sawyer1},
    },
    [TRAINER_MAY_1] =
    {
        .partyFlags = F_TRAINER_PARTY_HELD_ITEM,
        .trainerClass = TRAINER_CLASS_PKMN_TRAINER_3,
        .encounterMusic_gender = TRAINER_ENCOUNTER_MUSIC_FEMALE,
        .trainerPic = TRAINER_PIC_POKEMON_TRAINER_MAY,
        .trainerName = _("MAY"),
        .items = {ITEM_NONE, ITEM_NONE, ITEM_NONE, ITEM_NONE},
        .doubleBattle = FALSE,
        .aiFlags = AI_SCRIPT_CHECK_BAD_MOVE | AI_SCRIPT_TRY_TO_FAINT,
        .partySize = 2,
        .party = {.ItemDefaultMoves = sParty_May1},
    },
};
`;

const PARTIES_H = `
static const struct TrainerMon sParty_Sawyer1[] = {
    {
        .lvl = 7,
        .species = SPECIES_SEEDOT,
    },
    {
        .lvl = 7,
        .species = SPECIES_SEEDOT,
    },
    {
        .lvl = 8,
        .species = SPECIES_NUMEL,
    },
};

static const struct TrainerMonItemDefaultMoves sParty_May1[] = {
    {
        .lvl = 13,
        .species = SPECIES_GRAPPLOCT,
        .heldItem = ITEM_ORAN_BERRY,
    },
    {
        .lvl = 14,
        .species = SPECIES_TORCHIC,
        .heldItem = ITEM_NONE,
    },
};
`;

describe('extractTrainers', () => {
  it('parses each [TRAINER_X] block from trainers.h into a Trainer entry', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    expect(r.trainers).toHaveLength(3);
    const ids = r.trainers.map((t) => t.id);
    expect(ids).toContain('TRAINER_NONE');
    expect(ids).toContain('TRAINER_SAWYER_1');
    expect(ids).toContain('TRAINER_MAY_1');
  });

  it('extracts trainerClass, name, and AI flags', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const sawyer = r.trainers.find((t) => t.id === 'TRAINER_SAWYER_1');
    expect(sawyer?.className).toBe('TRAINER_CLASS_CAMPER');
    expect(sawyer?.name).toBe('SAWYER');
    expect(sawyer?.aiFlags).toEqual(['AI_SCRIPT_CHECK_BAD_MOVE']);
  });

  it('parses multi-OR AI flag expressions into a flag array', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const may = r.trainers.find((t) => t.id === 'TRAINER_MAY_1');
    expect(may?.aiFlags).toEqual(['AI_SCRIPT_CHECK_BAD_MOVE', 'AI_SCRIPT_TRY_TO_FAINT']);
  });

  it('resolves party variable references to TrainerPartyMembers', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const sawyer = r.trainers.find((t) => t.id === 'TRAINER_SAWYER_1');
    expect(sawyer?.party).toHaveLength(3);
    expect(sawyer?.party[0]?.speciesId).toBe('SPECIES_SEEDOT');
    expect(sawyer?.party[0]?.level).toBe(7);
    expect(sawyer?.party[2]?.speciesId).toBe('SPECIES_NUMEL');
    expect(sawyer?.party[2]?.level).toBe(8);
  });

  it('parses heldItem when present (non-NONE)', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const may = r.trainers.find((t) => t.id === 'TRAINER_MAY_1');
    expect(may?.party).toHaveLength(2);
    expect(may?.party[0]?.heldItemId).toBe('ITEM_ORAN_BERRY');
    expect(may?.party[1]?.heldItemId).toBeNull(); // ITEM_NONE → null
  });

  it('TRAINER_NONE with NULL party gets empty party and no warning', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const none = r.trainers.find((t) => t.id === 'TRAINER_NONE');
    expect(none?.party).toEqual([]);
    expect(r.warnings.some((w) => /TRAINER_NONE/.test(w))).toBe(false);
  });

  it('warns when a trainer references a party variable that is not defined', () => {
    const orphan = `
const struct Trainer gTrainers[] = {
  [TRAINER_GHOST] = {
    .trainerClass = TRAINER_CLASS_MYSTERY,
    .trainerName = _("?"),
    .aiFlags = 0,
    .party = {.NoItemDefaultMoves = sParty_DoesNotExist},
  },
};
`;
    const r = extractTrainers(orphan, '');
    expect(r.trainers).toHaveLength(1);
    expect(r.trainers[0]?.party).toEqual([]);
    expect(r.warnings.some((w) => /sParty_DoesNotExist/.test(w))).toBe(true);
  });

  it('strips line and block comments before parsing', () => {
    const withComments = `
// gTrainers list
/* Multi-line
   comment block */
const struct Trainer gTrainers[] = {
    [TRAINER_X] = { // inline
        .trainerClass = TRAINER_CLASS_X,
        .trainerName = _("X"),
        .aiFlags = 0,
        .party = {.NoItemDefaultMoves = NULL},
    },
};
`;
    const r = extractTrainers(withComments, '');
    expect(r.trainers).toHaveLength(1);
    expect(r.trainers[0]?.className).toBe('TRAINER_CLASS_X');
    expect(r.trainers[0]?.name).toBe('X');
  });

  it('sorts trainers by id for stable serialization', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const ids = r.trainers.map((t) => t.id);
    expect(ids).toEqual([...ids].sort());
  });

  it('falls back name to id when trainerName is empty string', () => {
    const r = extractTrainers(TRAINERS_H, PARTIES_H);
    const none = r.trainers.find((t) => t.id === 'TRAINER_NONE');
    // .trainerName = _("") produces an empty name; the entity name falls back to id.
    expect(none?.name).toBe('TRAINER_NONE');
  });
});

describe('parseTrainers (on-disk)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'rom-editor-trainers-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads src/data/trainers.h + trainer_parties.h from a project', async () => {
    mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'data', 'trainers.h'), TRAINERS_H);
    writeFileSync(path.join(dir, 'src', 'data', 'trainer_parties.h'), PARTIES_H);
    const result = await parseTrainers(dir);
    expect(result.trainers).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
  });

  it('warns and returns empty when trainers.h is absent', async () => {
    const result = await parseTrainers(dir);
    expect(result.trainers).toHaveLength(0);
    expect(result.warnings.some((w) => /trainers\.h/.test(w))).toBe(true);
  });

  it('warns when trainer_parties.h is absent but trainers.h is present (parties = [])', async () => {
    mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'data', 'trainers.h'), TRAINERS_H);
    const result = await parseTrainers(dir);
    expect(result.trainers).toHaveLength(3);
    expect(result.warnings.some((w) => /trainer_parties\.h/.test(w))).toBe(true);
    const sawyer = result.trainers.find((t) => t.id === 'TRAINER_SAWYER_1');
    expect(sawyer?.party).toEqual([]);
  });
});
