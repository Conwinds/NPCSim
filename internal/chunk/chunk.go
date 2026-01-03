// internal/chunk/chunk.go
// Purpose: chunk data layout (SoA), constants, and core indexing helpers.
//
// Important: pick ONE pack/index scheme and never change after persistence/networking.
// This project uses 32^3 chunks, so we exploit power-of-two shifts for branchless indexing:
//   idx = x | (z<<5) | (y<<10)

package chunk

// --- Constants ---

const (
  CW = 32
  CH = 32
  CD = 32

  // 32 = 2^5
  shiftZ = 5
  // 32*32 = 1024 = 2^10
  shiftY = 10
  mask5  = 31

  N = CW * CH * CD // 32768
)

// --- Types ---

type ChunkCoord struct{ X, Y, Z int32 }

// Chunk is the authoritative storage for a 32x32x32 region.
//
// Dense arrays are always present (fast); "sidecars" are sparse and optional.
type Chunk struct {
  C ChunkCoord

  // Dense voxel data (SoA)
  Type [N]uint8
  Meta [N]uint8

  // Derived cache: top-most solid block per (x,z) column.
  // This is only a convenience for early UI/pathing; invalidate on edits later.
  TopY    [CW * CD]uint8
  TopType [CW * CD]uint8
  TopValid bool

  // Sparse sidecars
  Props       []PropInstance
  BlockEntity map[uint16]uint32 // packedPos/idx -> entityID
}

type PropInstance struct {
  Kind uint16
  X, Y, Z uint8 // local 0..31
  Seed uint32
}

// --- Constructors ---

func New(c ChunkCoord) *Chunk {
  ch := &Chunk{C: c}
  // Type/Meta are zero-initialized (air).
  return ch
}

// --- Public methods ---

// Pack converts local (x,y,z) (0..31) to a packed position.
// Because our pack matches the linear index, packedPos == idx.
func Pack(x, y, z uint8) uint16 {
  return uint16(x) | (uint16(z) << shiftZ) | (uint16(y) << shiftY)
}

func Unpack(p uint16) (x, y, z uint8) {
  x = uint8(p & mask5)
  z = uint8((p >> shiftZ) & mask5)
  y = uint8((p >> shiftY) & mask5)
  return
}

// Idx returns the linear index into Type/Meta.
func Idx(x, y, z uint8) int { return int(Pack(x, y, z)) }

// IdxFromPacked returns the linear index for a packed position.
func IdxFromPacked(p uint16) int { return int(p) }

// RebuildTopCache recomputes TopY/TopType for the chunk.
// Cost: CW*CD*CH = 32768 checks (tiny for 32^3).
func (c *Chunk) RebuildTopCache() {
  for z := 0; z < CD; z++ {
    for x := 0; x < CW; x++ {
      col := x + z*CW
      // scan from top down
      topY := uint8(0)
      topT := uint8(0)
      found := false
      for y := CH - 1; y >= 0; y-- {
        idx := Idx(uint8(x), uint8(y), uint8(z))
        t := c.Type[idx]
        if t != 0 {
          topY = uint8(y)
          topT = t
          found = true
          break
        }
        if y == 0 {
          break
        }
      }
      if !found {
        topY, topT = 0, 0
      }
      c.TopY[col] = topY
      c.TopType[col] = topT
    }
  }
  c.TopValid = true
}
