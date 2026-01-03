// internal/mathx/hash.go
// Purpose: fast deterministic hashing for seeds/noise.
// Keep portable and stable across versions (no use of rand).

package mathx

// --- Public methods ---

// Hash32 mixes 32-bit input into a well-distributed 32-bit output.
// This is a small, fast mix (inspired by Murmur finalizer-style avalanching).
func Hash32(x uint32) uint32 {
  x ^= x >> 16
  x *= 0x7feb352d
  x ^= x >> 15
  x *= 0x846ca68b
  x ^= x >> 16
  return x
}

// Hash3 returns a stable hash for 3D integer coordinates + seed.
func Hash3(seed uint32, x, y, z int32) uint32 {
  // Large odd constants help decorrelate axes.
  h := seed
  h ^= uint32(x) * 0x9e3779b1
  h ^= uint32(y) * 0x85ebca6b
  h ^= uint32(z) * 0xc2b2ae35
  return Hash32(h)
}

// Hash2 returns a stable hash for 2D integer coordinates + seed.
func Hash2(seed uint32, x, z int32) uint32 {
  h := seed
  h ^= uint32(x) * 0x9e3779b1
  h ^= uint32(z) * 0x85ebca6b
  return Hash32(h)
}
