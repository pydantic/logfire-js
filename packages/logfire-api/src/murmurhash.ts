/**
 * MurmurHash3 x64 128-bit implementation.
 * Based on the original by Austin Appleby, public domain.
 * Returns a 32-character hex string.
 */
export function murmurhash3x64128(str: string): string {
  const c1 = 0x87c37b91114253d5n
  const c2 = 0x4cf5ad432745937fn

  let h1 = 0n
  let h2 = 0n

  const bytes = new TextEncoder().encode(str)
  const len = bytes.length
  const nblocks = Math.floor(len / 16)

  const mask64 = 0xffffffffffffffffn

  const rotl64 = (x: bigint, r: number): bigint => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & mask64

  const fmix64 = (k: bigint): bigint => {
    let h = k
    h ^= h >> 33n
    h = (h * 0xff51afd7ed558ccdn) & mask64
    h ^= h >> 33n
    h = (h * 0xc4ceb9fe1a85ec53n) & mask64
    h ^= h >> 33n
    return h
  }

  const getByte = (i: number): number => bytes[i] ?? 0

  const getBlock64 = (i: number): bigint => {
    const idx = i * 8
    let val = 0n
    for (let j = 0; j < 8; j++) {
      val |= BigInt(getByte(idx + j)) << BigInt(j * 8)
    }
    return val
  }

  for (let i = 0; i < nblocks; i++) {
    let k1 = getBlock64(i * 2)
    let k2 = getBlock64(i * 2 + 1)

    k1 = (k1 * c1) & mask64
    k1 = rotl64(k1, 31)
    k1 = (k1 * c2) & mask64
    h1 ^= k1

    h1 = rotl64(h1, 27)
    h1 = (h1 + h2) & mask64
    h1 = (h1 * 5n + 0x52dce729n) & mask64

    k2 = (k2 * c2) & mask64
    k2 = rotl64(k2, 33)
    k2 = (k2 * c1) & mask64
    h2 ^= k2

    h2 = rotl64(h2, 31)
    h2 = (h2 + h1) & mask64
    h2 = (h2 * 5n + 0x38495ab5n) & mask64
  }

  let k1 = 0n
  let k2 = 0n

  const tail = nblocks * 16
  const remainder = len & 15

  if (remainder >= 15) k2 ^= BigInt(getByte(tail + 14)) << 48n
  if (remainder >= 14) k2 ^= BigInt(getByte(tail + 13)) << 40n
  if (remainder >= 13) k2 ^= BigInt(getByte(tail + 12)) << 32n
  if (remainder >= 12) k2 ^= BigInt(getByte(tail + 11)) << 24n
  if (remainder >= 11) k2 ^= BigInt(getByte(tail + 10)) << 16n
  if (remainder >= 10) k2 ^= BigInt(getByte(tail + 9)) << 8n
  if (remainder >= 9) {
    k2 ^= BigInt(getByte(tail + 8))
    k2 = (k2 * c2) & mask64
    k2 = rotl64(k2, 33)
    k2 = (k2 * c1) & mask64
    h2 ^= k2
  }

  if (remainder >= 8) k1 ^= BigInt(getByte(tail + 7)) << 56n
  if (remainder >= 7) k1 ^= BigInt(getByte(tail + 6)) << 48n
  if (remainder >= 6) k1 ^= BigInt(getByte(tail + 5)) << 40n
  if (remainder >= 5) k1 ^= BigInt(getByte(tail + 4)) << 32n
  if (remainder >= 4) k1 ^= BigInt(getByte(tail + 3)) << 24n
  if (remainder >= 3) k1 ^= BigInt(getByte(tail + 2)) << 16n
  if (remainder >= 2) k1 ^= BigInt(getByte(tail + 1)) << 8n
  if (remainder >= 1) {
    k1 ^= BigInt(getByte(tail))
    k1 = (k1 * c1) & mask64
    k1 = rotl64(k1, 31)
    k1 = (k1 * c2) & mask64
    h1 ^= k1
  }

  h1 ^= BigInt(len)
  h2 ^= BigInt(len)

  h1 = (h1 + h2) & mask64
  h2 = (h2 + h1) & mask64

  h1 = fmix64(h1)
  h2 = fmix64(h2)

  h1 = (h1 + h2) & mask64
  h2 = (h2 + h1) & mask64

  const hex1 = h1.toString(16).padStart(16, '0')
  const hex2 = h2.toString(16).padStart(16, '0')
  return hex1 + hex2
}
