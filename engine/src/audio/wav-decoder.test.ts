import { describe, it, expect } from 'vitest';
import { decodeWav, resamplePcm, WavDecodeError } from './wav-decoder.js';

/** Build a synthetic WAV: 8 or 16 bit, 1 or 2 channels, with N samples. */
function buildWav(opts: {
  bitDepth: 8 | 16;
  channels: 1 | 2;
  sampleRate: number;
  samples: number[][]; // [sample][channel]
}): Uint8Array {
  const bytesPerSample = opts.bitDepth === 8 ? 1 : 2;
  const dataLen = opts.samples.length * opts.channels * bytesPerSample;
  const totalLen = 44 + dataLen;
  const buf = new Uint8Array(totalLen);
  // RIFF header
  buf[0] = 0x52; buf[1] = 0x49; buf[2] = 0x46; buf[3] = 0x46; // 'RIFF'
  const riffSize = totalLen - 8;
  buf[4] = riffSize & 0xff;
  buf[5] = (riffSize >>> 8) & 0xff;
  buf[6] = (riffSize >>> 16) & 0xff;
  buf[7] = (riffSize >>> 24) & 0xff;
  buf[8] = 0x57; buf[9] = 0x41; buf[10] = 0x56; buf[11] = 0x45; // 'WAVE'
  // fmt chunk
  buf[12] = 0x66; buf[13] = 0x6d; buf[14] = 0x74; buf[15] = 0x20; // 'fmt '
  buf[16] = 16; buf[17] = 0; buf[18] = 0; buf[19] = 0; // size 16
  buf[20] = 1; buf[21] = 0; // format PCM
  buf[22] = opts.channels; buf[23] = 0;
  buf[24] = opts.sampleRate & 0xff;
  buf[25] = (opts.sampleRate >>> 8) & 0xff;
  buf[26] = (opts.sampleRate >>> 16) & 0xff;
  buf[27] = (opts.sampleRate >>> 24) & 0xff;
  const byteRate = opts.sampleRate * opts.channels * bytesPerSample;
  buf[28] = byteRate & 0xff;
  buf[29] = (byteRate >>> 8) & 0xff;
  buf[30] = (byteRate >>> 16) & 0xff;
  buf[31] = (byteRate >>> 24) & 0xff;
  buf[32] = opts.channels * bytesPerSample;
  buf[33] = 0;
  buf[34] = opts.bitDepth;
  buf[35] = 0;
  // data chunk
  buf[36] = 0x64; buf[37] = 0x61; buf[38] = 0x74; buf[39] = 0x61; // 'data'
  buf[40] = dataLen & 0xff;
  buf[41] = (dataLen >>> 8) & 0xff;
  buf[42] = (dataLen >>> 16) & 0xff;
  buf[43] = (dataLen >>> 24) & 0xff;
  // samples
  let off = 44;
  for (const frame of opts.samples) {
    for (let c = 0; c < opts.channels; c++) {
      const s = frame[c]!;
      if (opts.bitDepth === 8) {
        // unsigned 0..255
        buf[off++] = (s + 0x80) & 0xff;
      } else {
        buf[off++] = s & 0xff;
        buf[off++] = (s >>> 8) & 0xff;
      }
    }
  }
  return buf;
}

describe('decodeWav', () => {
  it('decodes 8-bit mono', () => {
    const wav = buildWav({
      bitDepth: 8,
      channels: 1,
      sampleRate: 8000,
      samples: [[10], [-20], [0], [127]],
    });
    const r = decodeWav(wav);
    expect(r.sampleRate).toBe(8000);
    expect(r.sourceChannels).toBe(1);
    expect(r.sourceBitDepth).toBe(8);
    expect(Array.from(r.pcmSigned8)).toEqual([10, -20, 0, 127]);
  });

  it('decodes 16-bit mono and downsamples to 8-bit', () => {
    const wav = buildWav({
      bitDepth: 16,
      channels: 1,
      sampleRate: 22050,
      samples: [[0x2000], [-0x4000]],
    });
    const r = decodeWav(wav);
    expect(r.sourceBitDepth).toBe(16);
    // 0x2000 >> 8 = 0x20 = 32; -0x4000 >> 8 = -0x40 = -64
    expect(Array.from(r.pcmSigned8)).toEqual([32, -64]);
  });

  it('downmixes 16-bit stereo to mono', () => {
    const wav = buildWav({
      bitDepth: 16,
      channels: 2,
      sampleRate: 8000,
      samples: [[0x2000, 0x1000], [0, -0x2000]],
    });
    const r = decodeWav(wav);
    expect(r.sourceChannels).toBe(2);
    // Frame 0: (0x2000 + 0x1000) / 2 = 0x1800; >> 8 = 24
    // Average of (32, 16) = 24; frame 1: avg(0, -32) = -16
    expect(Array.from(r.pcmSigned8)).toEqual([24, -16]);
  });

  it('rejects non-RIFF input', () => {
    expect(() => decodeWav(new Uint8Array(100))).toThrow(WavDecodeError);
  });

  it('rejects non-PCM format', () => {
    const wav = buildWav({
      bitDepth: 8,
      channels: 1,
      sampleRate: 8000,
      samples: [[0]],
    });
    wav[20] = 2; // pretend format is ADPCM
    expect(() => decodeWav(wav)).toThrow(/format 2/);
  });

  it('rejects unsupported bit depth', () => {
    const wav = buildWav({
      bitDepth: 8,
      channels: 1,
      sampleRate: 8000,
      samples: [[0]],
    });
    wav[34] = 24; // pretend 24-bit
    expect(() => decodeWav(wav)).toThrow(/bit depth 24/);
  });
});

describe('resamplePcm', () => {
  it('is identity when source rate equals target rate', () => {
    const pcm = new Int8Array([1, 2, 3, 4]);
    expect(resamplePcm(pcm, 8000, 8000)).toBe(pcm);
  });
  it('downsamples 16 KHz to 8 KHz to half the length', () => {
    const pcm = new Int8Array([10, 20, 30, 40, 50, 60, 70, 80]);
    const out = resamplePcm(pcm, 16000, 8000);
    expect(out.length).toBe(4);
  });
  it('upsamples 8 KHz to 16 KHz to double the length', () => {
    const pcm = new Int8Array([10, 20, 30, 40]);
    const out = resamplePcm(pcm, 8000, 16000);
    expect(out.length).toBe(8);
  });
});
