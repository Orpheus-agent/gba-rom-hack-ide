import { describe, it, expect } from 'vitest';
import {
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
  type Detection,
} from './result.js';

/* -------------------------------------------------------------------------- */
/* Confidence                                                                 */
/* -------------------------------------------------------------------------- */

describe('Confidence', () => {
  it('accepts numbers in [0,1] inclusive', () => {
    expect(isConfidence(0)).toBe(true);
    expect(isConfidence(0.5)).toBe(true);
    expect(isConfidence(1)).toBe(true);
  });

  it('rejects numbers outside [0,1]', () => {
    expect(isConfidence(-0.0001)).toBe(false);
    expect(isConfidence(1.0001)).toBe(false);
    expect(isConfidence(2)).toBe(false);
    expect(isConfidence(-1)).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(isConfidence(Number.NaN)).toBe(false);
    expect(isConfidence(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isConfidence(Number.NEGATIVE_INFINITY)).toBe(false);
  });

  it('asConfidence throws DetectionInvariantError on out-of-range input', () => {
    expect(() => asConfidence(-0.1)).toThrow(DetectionInvariantError);
    expect(() => asConfidence(1.5)).toThrow(DetectionInvariantError);
    expect(() => asConfidence(Number.NaN)).toThrow(DetectionInvariantError);
  });

  it('asConfidence returns the value unchanged when valid', () => {
    expect(asConfidence(0.42)).toBe(0.42);
    expect(asConfidence(0)).toBe(0);
    expect(asConfidence(1)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

describe('Evidence', () => {
  it('constructs a valid evidence item', () => {
    const e = makeEvidence({
      kind: 'signature',
      summary: 'matched CFRU/v2 signature',
      weight: 0.8,
      detail: { signatureId: 'CFRU/v2', matchAt: 0x800000 },
    });
    expect(e.kind).toBe('signature');
    expect(e.summary).toBe('matched CFRU/v2 signature');
    expect(e.weight).toBe(0.8);
    expect(e.detail).toEqual({ signatureId: 'CFRU/v2', matchAt: 0x800000 });
  });

  it('freezes the constructed evidence (immutable)', () => {
    const e = makeEvidence({ kind: 'heuristic', summary: 'stride=4', weight: 0.5 });
    expect(Object.isFrozen(e)).toBe(true);
  });

  it('rejects out-of-range weight', () => {
    expect(() =>
      makeEvidence({ kind: 'heuristic', summary: 's', weight: -0.1 }),
    ).toThrow(DetectionInvariantError);
    expect(() =>
      makeEvidence({ kind: 'heuristic', summary: 's', weight: 1.5 }),
    ).toThrow(DetectionInvariantError);
  });

  it('rejects empty/whitespace summary (PD 1 + PD 2 guard)', () => {
    expect(() =>
      makeEvidence({ kind: 'heuristic', summary: '', weight: 0.5 }),
    ).toThrow(DetectionInvariantError);
    expect(() =>
      makeEvidence({ kind: 'heuristic', summary: '   ', weight: 0.5 }),
    ).toThrow(DetectionInvariantError);
  });

  it('omits detail when not supplied (exactOptionalPropertyTypes contract)', () => {
    const e = makeEvidence({ kind: 'heuristic', summary: 'stride=4', weight: 0.5 });
    expect('detail' in e).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* makeDetected                                                               */
/* -------------------------------------------------------------------------- */

describe('makeDetected', () => {
  const ev = makeEvidence({ kind: 'signature', summary: 'test', weight: 1.0 });

  it('constructs a valid detected result with non-empty data', () => {
    const r = makeDetected({
      confidence: 0.95,
      evidence: [ev],
      data: { speciesCount: 411, baseGame: 'BPRE' },
    });
    expect(r.status).toBe('detected');
    expect(r.confidence).toBe(0.95);
    expect(r.evidence).toHaveLength(1);
    expect(r.data).toEqual({ speciesCount: 411, baseGame: 'BPRE' });
  });

  it('refuses empty array as data (the headline PD 1 case)', () => {
    expect(() =>
      makeDetected({ confidence: 0.9, evidence: [ev], data: [] }),
    ).toThrow(EmptySuccessError);
  });

  it('refuses empty object as data', () => {
    expect(() =>
      makeDetected({ confidence: 0.9, evidence: [ev], data: {} }),
    ).toThrow(EmptySuccessError);
  });

  it('refuses null/undefined data', () => {
    expect(() =>
      makeDetected({ confidence: 0.9, evidence: [ev], data: null }),
    ).toThrow(EmptySuccessError);
    expect(() =>
      makeDetected({ confidence: 0.9, evidence: [ev], data: undefined }),
    ).toThrow(EmptySuccessError);
  });

  it('refuses zero-evidence detected result', () => {
    expect(() =>
      makeDetected({ confidence: 0.9, evidence: [], data: { ok: true } }),
    ).toThrow(EmptySuccessError);
  });

  it('refuses out-of-range confidence', () => {
    expect(() =>
      makeDetected({ confidence: 1.5, evidence: [ev], data: { ok: true } }),
    ).toThrow(DetectionInvariantError);
  });

  it('accepts primitive data (non-empty number/string)', () => {
    const r = makeDetected({ confidence: 0.7, evidence: [ev], data: 42 });
    expect(r.data).toBe(42);
    const r2 = makeDetected({ confidence: 0.7, evidence: [ev], data: 'BPRE' });
    expect(r2.data).toBe('BPRE');
  });

  it('accepts a populated array as data', () => {
    const r = makeDetected({
      confidence: 0.7,
      evidence: [ev],
      data: ['BULBASAUR', 'IVYSAUR', 'VENUSAUR'],
    });
    expect((r.data as string[]).length).toBe(3);
  });

  it('freezes the result and its evidence array', () => {
    const r = makeDetected({ confidence: 0.7, evidence: [ev], data: { ok: true } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.evidence)).toBe(true);
  });

  it('TypeScript discriminant: `data` is present on detected branch', () => {
    const r: Detection<{ ok: true }> = makeDetected({
      confidence: 0.9,
      evidence: [ev],
      data: { ok: true },
    });
    if (r.status === 'detected') {
      expect(r.data.ok).toBe(true);
    } else {
      throw new Error('discriminant narrowing broken');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* makePartial                                                                */
/* -------------------------------------------------------------------------- */

describe('makePartial', () => {
  const ev = makeEvidence({ kind: 'heuristic', summary: 'stride=11', weight: 0.6 });

  it('constructs a valid partial result with reason + non-empty data', () => {
    const r = makePartial({
      confidence: 0.6,
      evidence: [ev],
      data: { decoded: ['BULBASAUR', 'IVYSAUR'] },
      partialReason: 'only 2 of 411 species entries had readable text',
    });
    expect(r.status).toBe('partial');
    expect(r.partialReason).toBe('only 2 of 411 species entries had readable text');
  });

  it('refuses empty data even with a valid partialReason', () => {
    expect(() =>
      makePartial({
        confidence: 0.6,
        evidence: [ev],
        data: {},
        partialReason: 'nothing reconstructed',
      }),
    ).toThrow(EmptySuccessError);
  });

  it('refuses empty/whitespace partialReason', () => {
    expect(() =>
      makePartial({
        confidence: 0.6,
        evidence: [ev],
        data: { ok: true },
        partialReason: '',
      }),
    ).toThrow(DetectionInvariantError);
    expect(() =>
      makePartial({
        confidence: 0.6,
        evidence: [ev],
        data: { ok: true },
        partialReason: '   ',
      }),
    ).toThrow(DetectionInvariantError);
  });

  it('refuses zero-evidence partial result', () => {
    expect(() =>
      makePartial({
        confidence: 0.6,
        evidence: [],
        data: { ok: true },
        partialReason: 'incomplete',
      }),
    ).toThrow(EmptySuccessError);
  });
});

/* -------------------------------------------------------------------------- */
/* makeNotDetected                                                            */
/* -------------------------------------------------------------------------- */

describe('makeNotDetected', () => {
  const ev = makeEvidence({
    kind: 'signature',
    summary: 'no CFRU magic found in 0x000000..0x800000',
    weight: 0.9,
  });

  it('constructs a valid not_detected result with reason', () => {
    const r = makeNotDetected({
      confidence: 0.85,
      evidence: [ev],
      reason: 'CFRU signature absent and pointer-table shape does not match CFRU',
    });
    expect(r.status).toBe('not_detected');
    expect(r.reason).toContain('CFRU signature absent');
  });

  it('requires a non-empty reason', () => {
    expect(() =>
      makeNotDetected({ confidence: 0.8, evidence: [ev], reason: '' }),
    ).toThrow(DetectionInvariantError);
  });

  it('requires at least one evidence item (so callers explain what was searched)', () => {
    expect(() =>
      makeNotDetected({ confidence: 0.8, evidence: [], reason: 'absent' }),
    ).toThrow(DetectionInvariantError);
  });

  it('does NOT carry a data field (discriminant guarantee)', () => {
    const r = makeNotDetected({
      confidence: 0.8,
      evidence: [ev],
      reason: 'absent',
    });
    expect('data' in r).toBe(false);
  });

  it('TypeScript discriminant: not_detected branch has reason but not data', () => {
    const r: Detection<{ x: number }> = makeNotDetected({
      confidence: 0.8,
      evidence: [ev],
      reason: 'absent',
    });
    if (r.status === 'not_detected') {
      expect(r.reason).toBe('absent');
    } else {
      throw new Error('discriminant narrowing broken');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* isEmptyValue                                                               */
/* -------------------------------------------------------------------------- */

describe('isEmptyValue', () => {
  it('treats null/undefined as empty', () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
  });

  it('treats [] and {} as empty', () => {
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue({})).toBe(true);
  });

  it('treats Map() and Set() as empty', () => {
    expect(isEmptyValue(new Map())).toBe(true);
    expect(isEmptyValue(new Set())).toBe(true);
  });

  it('does NOT treat populated values as empty', () => {
    expect(isEmptyValue([0])).toBe(false);
    expect(isEmptyValue({ x: 0 })).toBe(false);
    expect(isEmptyValue(new Map([['k', 'v']]))).toBe(false);
    expect(isEmptyValue(new Set([1]))).toBe(false);
  });

  it('does NOT treat primitives as empty (concrete data is concrete)', () => {
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue('')).toBe(false); // strings are primitive; detector should partial+reason for "" if needed
    expect(isEmptyValue(false)).toBe(false);
    expect(isEmptyValue(0n)).toBe(false);
  });

  it('does NOT treat Buffers / typed arrays as empty if populated', () => {
    expect(isEmptyValue(Buffer.from([0, 1]))).toBe(false);
    expect(isEmptyValue(new Uint8Array([1]))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* assertNoEmptySuccess (boundary guard)                                      */
/* -------------------------------------------------------------------------- */

describe('assertNoEmptySuccess', () => {
  const ev = makeEvidence({ kind: 'signature', summary: 'x', weight: 1 });

  it('passes a well-formed detected result through unchanged', () => {
    const r = makeDetected({ confidence: 0.9, evidence: [ev], data: { ok: true } });
    expect(assertNoEmptySuccess(r)).toBe(r);
  });

  it('throws on a hand-rolled detected result with empty data', () => {
    // Bypass the constructor to simulate a malformed plugin response.
    const bogus = {
      status: 'detected' as const,
      confidence: 0.9 as number,
      evidence: [ev],
      data: [] as unknown[],
    } as unknown as Detection<unknown[]>;
    expect(() => assertNoEmptySuccess(bogus)).toThrow(EmptySuccessError);
  });

  it('throws on a hand-rolled detected result with zero evidence', () => {
    const bogus = {
      status: 'detected' as const,
      confidence: 0.9 as number,
      evidence: [],
      data: { ok: true },
    } as unknown as Detection<{ ok: true }>;
    expect(() => assertNoEmptySuccess(bogus)).toThrow(DetectionInvariantError);
  });

  it('throws on a hand-rolled result with invalid confidence', () => {
    const bogus = {
      status: 'detected' as const,
      confidence: 2 as number,
      evidence: [ev],
      data: { ok: true },
    } as unknown as Detection<{ ok: true }>;
    expect(() => assertNoEmptySuccess(bogus)).toThrow(DetectionInvariantError);
  });

  it('passes a not_detected result (data absence is legal there)', () => {
    const r = makeNotDetected({ confidence: 0.7, evidence: [ev], reason: 'absent' });
    expect(assertNoEmptySuccess(r)).toBe(r);
  });
});
