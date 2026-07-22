import { describe, it, expect } from 'vitest';
import {
  CoverageInvariantError,
  CoverageMap,
  OverlapError,
  assertMonotoneCoverage,
  formatCoverageLogLine,
} from './coverage.js';

const MB = 1024 * 1024;
const ROM_16MB = 16 * MB;

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

describe('CoverageMap constructor', () => {
  it('accepts a positive integer ROM size', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(c.romSize).toBe(ROM_16MB);
  });

  it('rejects zero or negative ROM size', () => {
    expect(() => new CoverageMap(0)).toThrow(CoverageInvariantError);
    expect(() => new CoverageMap(-1)).toThrow(CoverageInvariantError);
  });

  it('rejects non-integer ROM size', () => {
    expect(() => new CoverageMap(1.5)).toThrow(CoverageInvariantError);
    expect(() => new CoverageMap(Number.NaN)).toThrow(CoverageInvariantError);
  });
});

/* -------------------------------------------------------------------------- */
/* addClassified                                                              */
/* -------------------------------------------------------------------------- */

describe('addClassified', () => {
  it('adds a region and updates the report totals', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addClassified({
      start: 0,
      end: 0xc0,
      probableClass: 'header',
      score: 1.0,
      provenance: 'header-detector#it1',
    });
    const r = c.report();
    expect(r.classifiedBytes).toBe(0xc0);
    expect(r.unknownScoredBytes).toBe(0);
    expect(r.unaccountedBytes).toBe(ROM_16MB - 0xc0);
    expect(r.regionCount).toBe(1);
  });

  it('rejects negative start', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(() =>
      c.addClassified({
        start: -1,
        end: 0xc0,
        probableClass: 'header',
        score: 1,
        provenance: 'x',
      }),
    ).toThrow(CoverageInvariantError);
  });

  it('rejects end <= start', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(() =>
      c.addClassified({
        start: 0x100,
        end: 0x100,
        probableClass: 'header',
        score: 1,
        provenance: 'x',
      }),
    ).toThrow(CoverageInvariantError);
    expect(() =>
      c.addClassified({
        start: 0x100,
        end: 0x50,
        probableClass: 'header',
        score: 1,
        provenance: 'x',
      }),
    ).toThrow(CoverageInvariantError);
  });

  it('rejects end exceeding romSize', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(() =>
      c.addClassified({
        start: ROM_16MB - 10,
        end: ROM_16MB + 1,
        probableClass: 'header',
        score: 1,
        provenance: 'x',
      }),
    ).toThrow(CoverageInvariantError);
  });

  it('rejects score == 0 (zero confidence is not classified)', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(() =>
      c.addClassified({
        start: 0,
        end: 0xc0,
        probableClass: 'header',
        score: 0,
        provenance: 'x',
      }),
    ).toThrow(CoverageInvariantError);
  });

  it('rejects score outside [0,1]', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(() =>
      c.addClassified({
        start: 0,
        end: 0xc0,
        probableClass: 'header',
        score: 1.5,
        provenance: 'x',
      }),
    ).toThrow(CoverageInvariantError);
  });

  it('rejects empty provenance', () => {
    const c = new CoverageMap(ROM_16MB);
    expect(() =>
      c.addClassified({
        start: 0,
        end: 0xc0,
        probableClass: 'header',
        score: 1,
        provenance: '',
      }),
    ).toThrow(CoverageInvariantError);
  });

  it('refuses overlapping regions (no silent merging)', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addClassified({
      start: 0x100,
      end: 0x200,
      probableClass: 'table',
      score: 1,
      provenance: 'a',
    });
    expect(() =>
      c.addClassified({
        start: 0x180,
        end: 0x280,
        probableClass: 'script',
        score: 1,
        provenance: 'b',
      }),
    ).toThrow(OverlapError);
  });

  it('detects exact-edge overlaps (half-open semantics)', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addClassified({
      start: 0x100,
      end: 0x200,
      probableClass: 'table',
      score: 1,
      provenance: 'a',
    });
    // 0x0FF..0x101 overlaps because 0x100 is shared
    expect(() =>
      c.addClassified({
        start: 0x0ff,
        end: 0x101,
        probableClass: 'header',
        score: 1,
        provenance: 'b',
      }),
    ).toThrow(OverlapError);
    // Touching at the boundary [0x200, 0x300) is OK - half-open
    c.addClassified({
      start: 0x200,
      end: 0x300,
      probableClass: 'script',
      score: 1,
      provenance: 'c',
    });
    expect(c.report().regionCount).toBe(2);
  });

  it('keeps regions sorted by start in the report', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addClassified({ start: 0x300, end: 0x400, probableClass: 'a', score: 1, provenance: 'p' });
    c.addClassified({ start: 0x000, end: 0x100, probableClass: 'b', score: 1, provenance: 'p' });
    c.addClassified({ start: 0x100, end: 0x200, probableClass: 'c', score: 1, provenance: 'p' });
    const starts = c.report().regions.map((r) => r.start);
    expect(starts).toEqual([0x000, 0x100, 0x300]);
  });
});

/* -------------------------------------------------------------------------- */
/* addUnknownScored                                                           */
/* -------------------------------------------------------------------------- */

describe('addUnknownScored', () => {
  it('accepts score = 0 (genuine "I have no idea" is honest)', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addUnknownScored({
      start: 0x800000,
      end: 0x801000,
      probableClass: 'unknown',
      score: 0,
      provenance: 'phase-3-finalize',
    });
    expect(c.report().unknownScoredBytes).toBe(0x1000);
  });

  it('also rejects overlaps with classified regions', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addClassified({
      start: 0x100,
      end: 0x200,
      probableClass: 'table',
      score: 1,
      provenance: 'a',
    });
    expect(() =>
      c.addUnknownScored({
        start: 0x150,
        end: 0x250,
        probableClass: 'unknown',
        score: 0.4,
        provenance: 'b',
      }),
    ).toThrow(OverlapError);
  });
});

/* -------------------------------------------------------------------------- */
/* findUnaccountedGaps + blanketUnaccountedAsUnknown                          */
/* -------------------------------------------------------------------------- */

describe('findUnaccountedGaps', () => {
  it('returns one full-ROM gap when empty', () => {
    const c = new CoverageMap(0x1000);
    expect(c.findUnaccountedGaps()).toEqual([{ start: 0, end: 0x1000 }]);
  });

  it('returns head/middle/tail gaps around classified regions', () => {
    const c = new CoverageMap(0x1000);
    c.addClassified({
      start: 0x100,
      end: 0x200,
      probableClass: 'a',
      score: 1,
      provenance: 'p',
    });
    c.addClassified({
      start: 0x400,
      end: 0x500,
      probableClass: 'b',
      score: 1,
      provenance: 'p',
    });
    expect(c.findUnaccountedGaps()).toEqual([
      { start: 0x000, end: 0x100 },
      { start: 0x200, end: 0x400 },
      { start: 0x500, end: 0x1000 },
    ]);
  });

  it('returns no gaps when ROM is fully classified', () => {
    const c = new CoverageMap(0x200);
    c.addClassified({ start: 0, end: 0x100, probableClass: 'a', score: 1, provenance: 'p' });
    c.addClassified({ start: 0x100, end: 0x200, probableClass: 'b', score: 1, provenance: 'p' });
    expect(c.findUnaccountedGaps()).toEqual([]);
  });
});

describe('blanketUnaccountedAsUnknown', () => {
  it('reduces unaccountedBytes to zero', () => {
    const c = new CoverageMap(0x1000);
    c.addClassified({ start: 0x100, end: 0x200, probableClass: 'a', score: 1, provenance: 'p' });
    expect(c.report().unaccountedBytes).toBe(0x1000 - 0x100);
    c.blanketUnaccountedAsUnknown({
      probableClass: 'unknown',
      score: 0,
      provenance: 'phase-3-finalize',
      note: 'auto-blanketed unaccounted regions at phase-3 exit gate',
    });
    expect(c.report().unaccountedBytes).toBe(0);
  });

  it('returns the regions it added', () => {
    const c = new CoverageMap(0x300);
    c.addClassified({ start: 0x100, end: 0x200, probableClass: 'a', score: 1, provenance: 'p' });
    const added = c.blanketUnaccountedAsUnknown({
      probableClass: 'unknown',
      score: 0.1,
      provenance: 'p',
    });
    expect(added.map((r) => [r.start, r.end])).toEqual([
      [0x000, 0x100],
      [0x200, 0x300],
    ]);
  });

  it('returns empty array when no gaps exist', () => {
    const c = new CoverageMap(0x100);
    c.addClassified({ start: 0, end: 0x100, probableClass: 'a', score: 1, provenance: 'p' });
    const added = c.blanketUnaccountedAsUnknown({
      probableClass: 'unknown',
      score: 0,
      provenance: 'p',
    });
    expect(added).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* report() math                                                              */
/* -------------------------------------------------------------------------- */

describe('report() math', () => {
  it('reports correct classified/unknown/unaccounted percentages', () => {
    const c = new CoverageMap(1000);
    c.addClassified({ start: 0, end: 250, probableClass: 'a', score: 1, provenance: 'p' });
    c.addUnknownScored({ start: 250, end: 500, probableClass: 'unknown', score: 0.3, provenance: 'p' });
    const r = c.report();
    expect(r.classifiedBytes).toBe(250);
    expect(r.unknownScoredBytes).toBe(250);
    expect(r.unaccountedBytes).toBe(500);
    expect(r.classifiedPct).toBe(25);
    expect(r.unknownScoredPct).toBe(25);
    expect(r.unaccountedPct).toBe(50);
  });

  it('rounds percentages to two decimals', () => {
    const c = new CoverageMap(3);
    c.addClassified({ start: 0, end: 1, probableClass: 'a', score: 1, provenance: 'p' });
    const r = c.report();
    expect(r.classifiedPct).toBe(33.33);
    expect(r.unaccountedPct).toBe(66.67);
  });

  it('report is frozen (no late mutation)', () => {
    const c = new CoverageMap(0x100);
    const r = c.report();
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.regions)).toBe(true);
  });

  it('reports correct totals for the full ROM, summing to romSize', () => {
    const c = new CoverageMap(ROM_16MB);
    c.addClassified({ start: 0, end: 0xc0, probableClass: 'header', score: 1, provenance: 'p' });
    c.addClassified({ start: 0x245ee0, end: 0x248064, probableClass: 'table', score: 0.9, provenance: 'p' });
    const r = c.report();
    expect(r.classifiedBytes + r.unknownScoredBytes + r.unaccountedBytes).toBe(ROM_16MB);
  });
});

/* -------------------------------------------------------------------------- */
/* assertMonotoneCoverage                                                     */
/* -------------------------------------------------------------------------- */

describe('assertMonotoneCoverage', () => {
  function makeReport(romSize: number, classified: number, unknown: number) {
    const c = new CoverageMap(romSize);
    if (classified > 0) {
      c.addClassified({ start: 0, end: classified, probableClass: 'a', score: 1, provenance: 'p' });
    }
    if (unknown > 0) {
      c.addUnknownScored({
        start: classified,
        end: classified + unknown,
        probableClass: 'unknown',
        score: 0.2,
        provenance: 'p',
      });
    }
    return c.report();
  }

  it('returns null when coverage increases', () => {
    const prev = makeReport(1000, 100, 100);
    const curr = makeReport(1000, 200, 200);
    expect(assertMonotoneCoverage(prev, curr)).toBeNull();
  });

  it('returns null when coverage holds steady', () => {
    const prev = makeReport(1000, 200, 100);
    const curr = makeReport(1000, 200, 100);
    expect(assertMonotoneCoverage(prev, curr)).toBeNull();
  });

  it('returns null when an unknown_scored region is RECLASSIFIED to classified (accounted total holds)', () => {
    const prev = makeReport(1000, 100, 200);
    const curr = makeReport(1000, 300, 0);
    expect(assertMonotoneCoverage(prev, curr)).toBeNull();
  });

  it('returns a regression description when accounted-for bytes decrease', () => {
    const prev = makeReport(1000, 200, 200);
    const curr = makeReport(1000, 100, 100);
    const reg = assertMonotoneCoverage(prev, curr);
    expect(reg).not.toBeNull();
    expect(reg!.deltaBytes).toBe(-200);
    expect(reg!.reason).toContain('regressed');
  });

  it('flags a romSize mismatch as a different-ROM regression', () => {
    const prev = makeReport(1000, 500, 0);
    const curr = makeReport(2000, 1000, 0);
    const reg = assertMonotoneCoverage(prev, curr);
    expect(reg).not.toBeNull();
    expect(reg!.reason).toContain('romSize changed');
  });
});

/* -------------------------------------------------------------------------- */
/* formatCoverageLogLine                                                      */
/* -------------------------------------------------------------------------- */

describe('formatCoverageLogLine', () => {
  it('emits the §9.7 spec line format', () => {
    const c = new CoverageMap(1000);
    c.addClassified({ start: 0, end: 250, probableClass: 'a', score: 1, provenance: 'p' });
    c.addUnknownScored({ start: 250, end: 500, probableClass: 'unknown', score: 0.3, provenance: 'p' });
    const line = formatCoverageLogLine({
      utcIso: '2026-05-16T15:48:00Z',
      romClass: 'vanilla',
      report: c.report(),
    });
    expect(line).toBe(
      '- 2026-05-16T15:48:00Z vanilla classified=25.00% scoredUnknown=25.00% unaccounted=50.00%',
    );
  });

  it('rejects empty UTC or romClass', () => {
    const c = new CoverageMap(100);
    const r = c.report();
    expect(() =>
      formatCoverageLogLine({ utcIso: '', romClass: 'vanilla', report: r }),
    ).toThrow(CoverageInvariantError);
    expect(() =>
      formatCoverageLogLine({ utcIso: '2026-05-16T15:48:00Z', romClass: '', report: r }),
    ).toThrow(CoverageInvariantError);
  });

  it('always shows two decimal places even for whole numbers', () => {
    const c = new CoverageMap(100);
    c.addClassified({ start: 0, end: 100, probableClass: 'a', score: 1, provenance: 'p' });
    const line = formatCoverageLogLine({
      utcIso: '2026-05-16T15:48:00Z',
      romClass: 'vanilla',
      report: c.report(),
    });
    expect(line).toContain('classified=100.00%');
    expect(line).toContain('unaccounted=0.00%');
  });
});
