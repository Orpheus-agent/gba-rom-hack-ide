/**
 * Gen-3 trainer AI flag decoder (Phase 3.4).
 *
 * pret/pokefirered's `include/constants/battle_ai.h` defines the AI
 * bits the Gen-3 engine reads from gTrainers[i].aiFlags. Vanilla
 * trainers typically use 0x07 = checkBadMove + tryToFaint +
 * checkViability; gym leaders + Elite Four add switch and useItems.
 *
 * Bit values per pret:
 *   bit 0  = AI_SCRIPT_CHECK_BAD_MOVE        (avoid moves <50% hit)
 *   bit 1  = AI_SCRIPT_TRY_TO_FAINT          (prefer OHKO moves)
 *   bit 2  = AI_SCRIPT_CHECK_VIABILITY       (avoid self-harming moves)
 *   bit 3  = AI_SCRIPT_SETUP_FIRST_TURN      (use stat boosts opening turn)
 *   bit 4  = AI_SCRIPT_RISKY                 (favor low-acc high-damage)
 *   bit 5  = AI_SCRIPT_PREFER_STRONGEST_MOVE (no min-PP awareness)
 *   bit 6  = AI_SCRIPT_PREFER_BATON_PASS     (used by Baton Passer NPCs)
 *   bit 7  = AI_SCRIPT_TAG_BATTLE            (double-battle aware)
 *   bit 8  = AI_SCRIPT_CHECK_ABILITY         (consider abilities)
 *   bit 9  = AI_SCRIPT_CHECK_HP              (consider HP thresholds)
 *   bit 10 = AI_SCRIPT_FIRST_BATTLE          (intro-battle AI override)
 *   bit 11 = AI_SCRIPT_SUPER_EFFECTIVE       (always pick super-eff if available)
 *   bit 31 = AI_SCRIPT_ROAMING               (legendary roaming Pokémon)
 *
 * The decoder + encoder make these bits round-trippable + named.
 */

export interface AiFlagSet {
  readonly checkBadMove: boolean;
  readonly tryToFaint: boolean;
  readonly checkViability: boolean;
  readonly setupFirstTurn: boolean;
  readonly risky: boolean;
  readonly preferStrongestMove: boolean;
  readonly preferBatonPass: boolean;
  readonly tagBattle: boolean;
  readonly checkAbility: boolean;
  readonly checkHp: boolean;
  readonly firstBattle: boolean;
  readonly superEffective: boolean;
  readonly roaming: boolean;
  /** Any bits the decoder didn't recognise (preserves CFRU/hack
   *  extensions; encoder emits these unchanged). */
  readonly unknownBits: number;
}

const BIT = {
  checkBadMove: 0,
  tryToFaint: 1,
  checkViability: 2,
  setupFirstTurn: 3,
  risky: 4,
  preferStrongestMove: 5,
  preferBatonPass: 6,
  tagBattle: 7,
  checkAbility: 8,
  checkHp: 9,
  firstBattle: 10,
  superEffective: 11,
  roaming: 31,
} as const;

const KNOWN_MASK = (() => {
  let m = 0;
  for (const bit of Object.values(BIT)) m |= 1 << bit;
  return m >>> 0;
})();

/** Decode a u32 aiFlags value into a named AiFlagSet. */
export function decodeAiFlags(value: number): AiFlagSet {
  const v = value >>> 0;
  return Object.freeze({
    checkBadMove: ((v >>> BIT.checkBadMove) & 1) === 1,
    tryToFaint: ((v >>> BIT.tryToFaint) & 1) === 1,
    checkViability: ((v >>> BIT.checkViability) & 1) === 1,
    setupFirstTurn: ((v >>> BIT.setupFirstTurn) & 1) === 1,
    risky: ((v >>> BIT.risky) & 1) === 1,
    preferStrongestMove: ((v >>> BIT.preferStrongestMove) & 1) === 1,
    preferBatonPass: ((v >>> BIT.preferBatonPass) & 1) === 1,
    tagBattle: ((v >>> BIT.tagBattle) & 1) === 1,
    checkAbility: ((v >>> BIT.checkAbility) & 1) === 1,
    checkHp: ((v >>> BIT.checkHp) & 1) === 1,
    firstBattle: ((v >>> BIT.firstBattle) & 1) === 1,
    superEffective: ((v >>> BIT.superEffective) & 1) === 1,
    roaming: ((v >>> BIT.roaming) & 1) === 1,
    unknownBits: (v & ~KNOWN_MASK) >>> 0,
  });
}

/** Encode a named AiFlagSet back to a u32. Round-trips: decodeAiFlags
 *  composed with encodeAiFlags is identity. */
export function encodeAiFlags(set: AiFlagSet): number {
  let v = set.unknownBits >>> 0;
  if (set.checkBadMove) v |= 1 << BIT.checkBadMove;
  if (set.tryToFaint) v |= 1 << BIT.tryToFaint;
  if (set.checkViability) v |= 1 << BIT.checkViability;
  if (set.setupFirstTurn) v |= 1 << BIT.setupFirstTurn;
  if (set.risky) v |= 1 << BIT.risky;
  if (set.preferStrongestMove) v |= 1 << BIT.preferStrongestMove;
  if (set.preferBatonPass) v |= 1 << BIT.preferBatonPass;
  if (set.tagBattle) v |= 1 << BIT.tagBattle;
  if (set.checkAbility) v |= 1 << BIT.checkAbility;
  if (set.checkHp) v |= 1 << BIT.checkHp;
  if (set.firstBattle) v |= 1 << BIT.firstBattle;
  if (set.superEffective) v |= 1 << BIT.superEffective;
  if (set.roaming) v |= 1 << BIT.roaming;
  return v >>> 0;
}

/** Vanilla "smart trainer" preset (0x07). */
export const SMART_TRAINER_AI_FLAGS = 0x07;

/** Vanilla "gym leader" preset (0x07 + setupFirstTurn + checkHp). */
export const GYM_LEADER_AI_FLAGS = 0x07 | (1 << BIT.setupFirstTurn) | (1 << BIT.checkHp);

/** Vanilla "Elite Four / Champion" preset (gym + superEffective + checkAbility). */
export const ELITE_FOUR_AI_FLAGS =
  GYM_LEADER_AI_FLAGS | (1 << BIT.superEffective) | (1 << BIT.checkAbility);

/** Bit lookup so callers (e.g. propose tools) can surface symbolic
 *  names rather than hardcoding. */
export const AI_FLAG_BIT_INDICES: Readonly<Record<keyof typeof BIT, number>> = Object.freeze({ ...BIT });
