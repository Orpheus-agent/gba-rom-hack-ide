/**
 * Minimal WAV decoder (Phase 3.37 + 3.38).
 *
 * Decodes the most common WAV variant: RIFF/WAVE, fmt chunk type 1
 * (uncompressed PCM), 8-bit or 16-bit, mono or stereo. Returns 8-bit
 * SIGNED PCM samples at the source's sample rate, downmixed to mono
 * if input is stereo.
 *
 * Used by sound-effect + cry imports (the GBA engine wants 8-bit
 * signed PCM at 8 KHz to 22 KHz typically). The caller resamples to
 * the target rate via a follow-up call to `resamplePcm`.
 *
 * Out of scope (the tool-layer will surface a 'not supported' error
 * for these):
 *   - WAV format > 8 channels
 *   - WAV format types other than 1 (PCM) - ADPCM / float / etc.
 *   - 24-bit / 32-bit PCM (rare in practice for GBA cries).
 */

export class WavDecodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`WavDecodeError[${code}]: ${message}`);
    this.name = 'WavDecodeError';
    this.code = code;
  }
}

export interface DecodedWav {
  /** 8-bit signed PCM samples (mono). */
  readonly pcmSigned8: Int8Array;
  /** Sample rate the source recorded at. */
  readonly sampleRate: number;
  /** Channel count of the source (1 or 2; output is always mono). */
  readonly sourceChannels: number;
  /** Bit depth of the source (8 or 16). */
  readonly sourceBitDepth: number;
}

export function decodeWav(bytes: Uint8Array): DecodedWav {
  if (bytes.length < 44) throw new WavDecodeError('too_short', 'WAV must be ≥ 44 bytes');
  // RIFF header
  if (
    bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46
  ) {
    throw new WavDecodeError('not_riff', 'not a RIFF file');
  }
  if (
    bytes[8] !== 0x57 || bytes[9] !== 0x41 || bytes[10] !== 0x56 || bytes[11] !== 0x45
  ) {
    throw new WavDecodeError('not_wave', 'RIFF type isn\'t WAVE');
  }
  // Walk chunks. We need `fmt ` + `data`.
  let cursor = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let format = 0;
  let dataOff = -1;
  let dataLen = 0;
  while (cursor + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[cursor]!, bytes[cursor + 1]!, bytes[cursor + 2]!, bytes[cursor + 3]!);
    const size = readU32Le(bytes, cursor + 4);
    cursor += 8;
    if (cursor + size > bytes.length) break;
    if (id === 'fmt ') {
      format = readU16Le(bytes, cursor);
      channels = readU16Le(bytes, cursor + 2);
      sampleRate = readU32Le(bytes, cursor + 4);
      // bytesPerSec, blockAlign skipped
      bitDepth = readU16Le(bytes, cursor + 14);
    } else if (id === 'data') {
      dataOff = cursor;
      dataLen = size;
    }
    cursor += size + (size & 1); // chunks are 2-byte aligned
  }
  if (sampleRate === 0 || channels === 0 || bitDepth === 0) {
    throw new WavDecodeError('missing_fmt', 'no fmt chunk found');
  }
  if (format !== 1) {
    throw new WavDecodeError('unsupported_format', `format ${String(format)} (only PCM = 1 is supported)`);
  }
  if (bitDepth !== 8 && bitDepth !== 16) {
    throw new WavDecodeError('unsupported_bit_depth', `bit depth ${String(bitDepth)} (only 8 / 16 supported)`);
  }
  if (channels !== 1 && channels !== 2) {
    throw new WavDecodeError('unsupported_channels', `channels ${String(channels)} (only mono/stereo supported)`);
  }
  if (dataOff < 0) {
    throw new WavDecodeError('missing_data', 'no data chunk found');
  }

  // Decode samples → 8-bit signed mono.
  const bytesPerSample = bitDepth === 8 ? 1 : 2;
  const totalSourceSamples = dataLen / (bytesPerSample * channels);
  const out = new Int8Array(totalSourceSamples);
  for (let i = 0; i < totalSourceSamples; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const sampleOff = dataOff + (i * channels + c) * bytesPerSample;
      let raw: number;
      if (bitDepth === 8) {
        // 8-bit WAV is UNSIGNED (0..255 = -128..127).
        raw = (bytes[sampleOff]! - 0x80) | 0;
      } else {
        // 16-bit WAV is SIGNED LE.
        const lo = bytes[sampleOff]!;
        const hi = bytes[sampleOff + 1]!;
        let v = lo | (hi << 8);
        if (v >= 0x8000) v -= 0x10000;
        raw = (v >> 8); // downsample to 8-bit
      }
      sum += raw;
    }
    const avg = Math.round(sum / channels);
    out[i] = Math.max(-128, Math.min(127, avg));
  }
  return Object.freeze({
    pcmSigned8: out,
    sampleRate,
    sourceChannels: channels,
    sourceBitDepth: bitDepth,
  });
}

/** Linearly resample a signed-8 PCM stream from sourceRate to
 *  targetRate. Quick + dirty linear interpolation; quality is fine
 *  for short cries + SFX (the GBA's audio chip lowpasses everything
 *  anyway). */
export function resamplePcm(
  pcm: Int8Array,
  sourceRate: number,
  targetRate: number,
): Int8Array {
  if (sourceRate === targetRate) return pcm;
  const ratio = sourceRate / targetRate;
  const outLength = Math.floor(pcm.length / ratio);
  const out = new Int8Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcIdx = i * ratio;
    const i0 = Math.floor(srcIdx);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    const frac = srcIdx - i0;
    out[i] = Math.round(pcm[i0]! * (1 - frac) + pcm[i1]! * frac);
  }
  return out;
}

function readU16Le(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}

function readU32Le(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}
