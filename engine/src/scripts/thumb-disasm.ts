/**
 * Minimal Thumb-1 instruction decoder - just enough to identify BL
 * (branch-and-link, 32-bit / two-halfword) instructions and decode
 * their absolute target addresses.
 *
 * Thumb-1 BL encoding (ARMv4T per ARM7TDMI reference manual, used by
 * every Gen-3 GBA cart):
 *
 *   halfword 1 (offset 0x00, 16 bits, little-endian):
 *     1111 0SHH HHHH HHHH
 *     ↑      ↑
 *     prefix sign+upper-11-bits-of-offset
 *
 *   halfword 2 (offset 0x02, 16 bits, little-endian):
 *     1111 1LLL LLLL LLLL
 *     ↑      ↑
 *     prefix lower-11-bits-of-offset
 *
 * The 22-bit signed offset (bits S || HHHH..HHHH || LLL..LLLL || 0)
 * is sign-extended to 32 bits and added to (BL_address + 4) to yield
 * the target address.
 *
 * BLX (Thumb→ARM call) uses the same hw1 format but hw2 = `1110 1LLL
 * LLLL LLLL` (top 5 bits = 11101 instead of 11111). The Gen-3 script
 * engine is pure Thumb so we ignore BLX for now.
 *
 * Other Thumb-2 BL forms (ARMv6T2+) don't exist on ARM7TDMI/GBA.
 *
 * PD 5: hardware-spec-invariant. Works on every Gen-3 cart regardless
 * of compiler / hack.
 */

/** Size of a Thumb-1 BL instruction (2 halfwords = 4 bytes). */
export const THUMB_BL_INSTRUCTION_SIZE_BYTES = 4;

export interface ThumbBL {
  /** Absolute file offset of the BL's target. */
  readonly targetOffset: number;
  /** File offset of the BL instruction's first byte (= input `offset`). */
  readonly instructionOffset: number;
  /** Size in bytes of the BL instruction (always 4). */
  readonly instructionByteLength: number;
}

/**
 * Try to decode a Thumb-1 BL at `offset` in `bytes`. Returns the
 * decoded BL on success, null when:
 *   - `offset + 4 > bytes.length` (insufficient bytes)
 *   - hw1 prefix is not `0b11110` (top 5 bits)
 *   - hw2 prefix is not `0b11111` (top 5 bits) - BLX is rejected
 *   - resulting `targetOffset` falls outside `[0, bytes.length)`
 */
export function tryDecodeThumbBL(bytes: Uint8Array, offset: number): ThumbBL | null {
  if (offset < 0 || offset + THUMB_BL_INSTRUCTION_SIZE_BYTES > bytes.length) {
    return null;
  }
  const hw1 = readUint16Le(bytes, offset);
  const hw2 = readUint16Le(bytes, offset + 2);
  // hw1 high-5-bits must be 11110 → 0xF000..0xF7FF
  if ((hw1 & 0xf800) !== 0xf000) return null;
  // hw2 high-5-bits must be 11111 → 0xF800..0xFFFF (BL, not BLX)
  if ((hw2 & 0xf800) !== 0xf800) return null;

  // Per ARMv4T BL encoding, hw1[10..0] holds the upper 11 bits of the
  // signed offset (bits 22..12 of the 23-bit signed offset, where bit
  // 22 is the sign bit = hw1[10]). hw2[10..0] holds bits 11..1 (bit 0
  // is implicit 0 since Thumb is 2-byte aligned).
  const upper11 = hw1 & 0x7ff; // 11 bits - bit 10 of this is the sign
  const lower11 = hw2 & 0x7ff; // 11 bits

  // Compose 23-bit offset and sign-extend at bit 22.
  let off23 = (upper11 << 12) | (lower11 << 1);
  if ((upper11 & 0x400) !== 0) {
    // Sign bit set (bit 22 of off23 set) → sign-extend to 32 bits.
    off23 |= 0xff800000;
  }
  const signedOff = off23 | 0;

  // BL target = (instructionAddress + 4) + signedOff, where
  // instructionAddress = absolute address of hw1. In a file-offset
  // context we use the same arithmetic.
  const targetOffset = (offset + 4 + signedOff) | 0;
  if (targetOffset < 0 || targetOffset >= bytes.length) return null;

  return Object.freeze({
    targetOffset,
    instructionOffset: offset,
    instructionByteLength: THUMB_BL_INSTRUCTION_SIZE_BYTES,
  });
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8)) >>> 0;
}
