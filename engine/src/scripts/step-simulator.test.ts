import { describe, it, expect } from 'vitest';
import type { DecodedScriptStep } from './binary-script-decoder.js';
import { simulateScript } from './step-simulator.js';

function step(kind: DecodedScriptStep['kind'], params: Record<string, unknown>): DecodedScriptStep {
  return Object.freeze({
    index: 0,
    fileOffset: 0,
    kind,
    label: '',
    params: Object.freeze(params),
  });
}

describe('simulateScript', () => {
  it('tracks set_flag and clear_flag', () => {
    const steps = [
      step('set_flag', { flagId: 0x800 }),
      step('set_flag', { flagId: 0x801 }),
      step('clear_flag', { flagId: 0x800 }),
      step('raw', { opcode: 0x02 }), // end
    ];
    const r = simulateScript(steps);
    expect(r.state.flags.has(0x800)).toBe(false);
    expect(r.state.flags.has(0x801)).toBe(true);
    expect(r.stoppedReason).toBe('terminator');
  });

  it('tracks set_variable', () => {
    const steps = [
      step('set_variable', { opcodeName: 'setvar', varId: 0x40d0, value: 3 }),
      step('set_variable', { opcodeName: 'addvar', varId: 0x40d0, value: 1 }),
      step('raw', { opcode: 0x02 }),
    ];
    const r = simulateScript(steps);
    expect(r.state.vars.get(0x40d0)).toBe(4);
  });

  it('records dialogues', () => {
    const steps = [
      step('dialogue', { dialogueText: 'Hello!' }),
      step('dialogue', { dialogueText: 'World!' }),
      step('raw', { opcode: 0x02 }),
    ];
    const r = simulateScript(steps);
    expect(r.state.dialoguesShown).toEqual(['Hello!', 'World!']);
  });

  it('stops at start_battle and records the trainer', () => {
    const steps = [
      step('dialogue', { dialogueText: 'Prepare!' }),
      step('start_battle', { trainerId: 42 }),
      step('dialogue', { dialogueText: 'After (unreachable)' }),
    ];
    const r = simulateScript(steps);
    expect(r.state.battlesStarted).toEqual([42]);
    expect(r.stoppedReason).toBe('branch');
    expect(r.state.dialoguesShown).toEqual(['Prepare!']);
  });

  it('follows the true branch of branch_on_var when condition holds', () => {
    const steps = [
      step('set_variable', { opcodeName: 'setvar', varId: 0x40d0, value: 5 }),
      step('branch_on_var', {
        varId: 0x40d0,
        value: 3,
        operator: 'greaterorequal',
        targetRomPtr: 0x08123456,
      }),
      step('dialogue', { dialogueText: 'Should not show' }),
      step('raw', { opcode: 0x02 }),
    ];
    const r = simulateScript(steps);
    expect(r.stoppedReason).toBe('branch');
    expect(r.state.branchesEncountered).toHaveLength(1);
    expect(r.state.branchesEncountered[0]!.targetRomPtr).toBe(0x08123456);
    expect(r.state.dialoguesShown).toEqual([]);
  });

  it('skips the branch when condition is false', () => {
    const steps = [
      step('set_variable', { opcodeName: 'setvar', varId: 0x40d0, value: 1 }),
      step('branch_on_var', {
        varId: 0x40d0,
        value: 3,
        operator: 'greaterorequal',
        targetRomPtr: 0x08123456,
      }),
      step('dialogue', { dialogueText: 'Should show' }),
      step('raw', { opcode: 0x02 }),
    ];
    const r = simulateScript(steps);
    expect(r.stoppedReason).toBe('terminator');
    expect(r.state.dialoguesShown).toEqual(['Should show']);
  });

  it('routes initial flags + vars through the state', () => {
    const r = simulateScript(
      [step('raw', { opcode: 0x02 })],
      {
        initial: {
          flags: [0x100, 0x101],
          vars: [[0x40d0, 7]],
        },
      },
    );
    expect(r.state.flags.has(0x100)).toBe(true);
    expect(r.state.vars.get(0x40d0)).toBe(7);
  });

  it('records warps and stops', () => {
    const steps = [
      step('warp_player', {
        opcodeName: 'warp',
        destMapBank: 3,
        destMapNum: 0,
        x: 5,
        y: 7,
      }),
    ];
    const r = simulateScript(steps);
    expect(r.state.warpsTaken).toEqual([{ mapGroup: 3, mapNum: 0, x: 5, y: 7 }]);
  });

  it('records give_item', () => {
    const steps = [
      step('give_item', { itemId: 0x0d, quantity: 5 }),
      step('raw', { opcode: 0x02 }),
    ];
    const r = simulateScript(steps);
    expect(r.state.itemsGiven).toEqual([{ itemId: 0x0d, quantity: 5 }]);
  });

  it('halts on unknown opcodes when haltOnUnknown=true', () => {
    const steps = [
      step('raw', { opcode: 0xfe }), // not end/return
      step('raw', { opcode: 0x02 }),
    ];
    const r = simulateScript(steps, { haltOnUnknown: true });
    expect(r.stoppedReason).toBe('unknown');
    expect(r.state.unknownOps[0]!.opcode).toBe(0xfe);
  });
});
