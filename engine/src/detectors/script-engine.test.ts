import { describe, expect, it } from 'vitest';
import { CoverageMap } from '../coverage/index.js';
import { GBA_ROM_BASE_ADDRESS } from '../pointers/index.js';
import { loadRomFromBytes } from '../rom/loader.js';
import {
  SCRIPT_ENGINE_DETECTOR_ID,
  scriptEngineDetector,
  type ScriptEngineReport,
} from './script-engine.js';

/** Plant an N-entry opcode table at `tableAt` with each pointer
 *  resolving to a Thumb push prologue. */
function plantTable(buf: Buffer, tableAt: number, n: number, handlersBase = 0x4000): void {
  const stride = 0x40;
  for (let i = 0; i < n; i++) {
    const handlerAt = handlersBase + i * stride;
    buf[handlerAt] = 0x00;
    buf[handlerAt + 1] = 0xb5;
    buf.writeUInt32LE((GBA_ROM_BASE_ADDRESS + handlerAt) >>> 0, tableAt + i * 4);
  }
}

describe('scriptEngineDetector', () => {
  it('has stable id, name, phase=6', () => {
    expect(scriptEngineDetector.id).toBe(SCRIPT_ENGINE_DETECTOR_ID);
    expect(scriptEngineDetector.phase).toBe(6);
    expect(scriptEngineDetector.name.length).toBeGreaterThan(0);
  });

  it('returns not_detected for an all-zero ROM', () => {
    const rom = loadRomFromBytes({ bytes: Buffer.alloc(0x10000) });
    const coverage = new CoverageMap(rom.byteLength);
    const result = scriptEngineDetector.detect(rom, coverage);
    expect(result.status).toBe('not_detected');
    if (result.status === 'not_detected') {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it('returns detected with a planted 64-opcode table', () => {
    const buf = Buffer.alloc(0x10000);
    plantTable(buf, 0x800, 64);
    const rom = loadRomFromBytes({ bytes: buf });
    const coverage = new CoverageMap(rom.byteLength);
    const result = scriptEngineDetector.detect(rom, coverage);
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      const data = result.data as ScriptEngineReport;
      expect(data.opcodeCount).toBe(64);
      expect(data.opcodeTable.tableStart).toBe(0x800);
    }
  });

  it('confidence scales with opcode count', () => {
    const buf = Buffer.alloc(0x40000);
    plantTable(buf, 0x800, 100, 0x4000);
    const rom = loadRomFromBytes({ bytes: buf });
    const coverage = new CoverageMap(rom.byteLength);
    const result = scriptEngineDetector.detect(rom, coverage);
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      // 100 opcodes → confidence 0.9
      expect(result.confidence).toBe(0.9);
    }
  });

  it('registers the opcode-table bytes as pointer_network coverage', () => {
    const buf = Buffer.alloc(0x10000);
    plantTable(buf, 0x800, 64);
    const rom = loadRomFromBytes({ bytes: buf });
    const coverage = new CoverageMap(rom.byteLength);
    scriptEngineDetector.detect(rom, coverage);
    const regions = coverage.report().regions.filter(
      (r) => r.kind === 'classified' && r.probableClass === 'pointer_network',
    );
    expect(regions.length).toBeGreaterThan(0);
    const tableRegion = regions.find((r) => r.start === 0x800);
    expect(tableRegion).toBeDefined();
    if (tableRegion) {
      expect(tableRegion.end).toBe(0x800 + 64 * 4);
    }
  });
});

describe('scriptEngineDetector - engineKind classification (P6-T6)', () => {
  it('classifies 64-opcode planted table as undersized', () => {
    const buf = Buffer.alloc(0x10000);
    plantTable(buf, 0x800, 64);
    const rom = loadRomFromBytes({ bytes: buf });
    const result = scriptEngineDetector.detect(rom, new CoverageMap(rom.byteLength));
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      const data = result.data as ScriptEngineReport;
      expect(data.engineKind).toBe('undersized');
    }
  });

  it('classifies 150-opcode planted table as vanilla-range', () => {
    const buf = Buffer.alloc(0x40000);
    plantTable(buf, 0x800, 150);
    const rom = loadRomFromBytes({ bytes: buf });
    const result = scriptEngineDetector.detect(rom, new CoverageMap(rom.byteLength));
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      const data = result.data as ScriptEngineReport;
      expect(data.engineKind).toBe('vanilla-range');
    }
  });

  it('classifies 250-opcode planted table as extended (CFRU-class)', () => {
    const buf = Buffer.alloc(0x40000);
    plantTable(buf, 0x800, 250);
    const rom = loadRomFromBytes({ bytes: buf });
    const result = scriptEngineDetector.detect(rom, new CoverageMap(rom.byteLength));
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      const data = result.data as ScriptEngineReport;
      expect(data.engineKind).toBe('extended');
    }
  });

  it('classifies 400-opcode planted table as heavily-extended', () => {
    const buf = Buffer.alloc(0x40000);
    plantTable(buf, 0x800, 400);
    const rom = loadRomFromBytes({ bytes: buf });
    const result = scriptEngineDetector.detect(rom, new CoverageMap(rom.byteLength));
    expect(result.status).toBe('detected');
    if (result.status === 'detected') {
      const data = result.data as ScriptEngineReport;
      expect(data.engineKind).toBe('heavily-extended');
    }
  });
});
