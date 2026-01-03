// internal/gen/pipeline.go
// Purpose: deterministic generation pipeline; ordered passes.
// For now: base terrain + water + simple surface materials.

package gen

import (
  "math"

  "github.com/Conwinds/NPCSim/internal/chunk"
)

// --- Constants ---

const (
  // Keep IDs tiny and stable. 0 must be air.
  BlockAir  = uint8(0)
  BlockGrass= uint8(1)
  BlockDirt = uint8(2)
  BlockStone= uint8(3)
  BlockWater= uint8(4)

  seaLevel = 12 // global Y level where water fills up to
)

// --- Types ---

type Context struct {
  Seed uint32
}

// --- Public methods ---

func GenerateChunk(coord chunk.ChunkCoord, ctx Context) *chunk.Chunk {
  ch := chunk.New(coord)

  // World-space base Y for this vertical chunk.
  baseY := int32(coord.Y) * chunk.CH

  // Pass 1: terrain solids
  for z := uint8(0); z < chunk.CD; z++ {
    wz := int32(coord.Z)*chunk.CD + int32(z)
    for x := uint8(0); x < chunk.CW; x++ {
      wx := int32(coord.X)*chunk.CW + int32(x)

      // Height in global block coords.
      h := terrainHeight(wx, wz, ctx.Seed)

      // Fill this chunk's y-range.
      for y := uint8(0); y < chunk.CH; y++ {
        gy := baseY + int32(y)
        idx := chunk.Idx(x, y, z)

        if gy > h {
          ch.Type[idx] = BlockAir
          continue
        }

        // Simple stratification: top grass, under dirt, then stone.
        depth := h - gy
        switch {
        case depth == 0:
          ch.Type[idx] = BlockGrass
        case depth <= 3:
          ch.Type[idx] = BlockDirt
        default:
          ch.Type[idx] = BlockStone
        }
      }

      // Pass 2: water fill (only for columns below sea level)
      if h < seaLevel {
        for gy := h + 1; gy <= seaLevel; gy++ {
          // Only if that global y falls inside this chunk.
          if gy < baseY || gy >= baseY+chunk.CH {
            continue
          }
          y := uint8(gy - baseY)
          idx := chunk.Idx(x, y, z)
          ch.Type[idx] = BlockWater
        }
      }
    }
  }

  ch.RebuildTopCache()
  return ch
}

// --- Private helpers ---

func clampI32(v, lo, hi int32) int32 {
  if v < lo {
    return lo
  }
  if v > hi {
    return hi
  }
  return v
}

// terrainHeight returns a global Y height for the column at (wx,wz).
// Output is intentionally constrained for early visualization.
func terrainHeight(wx, wz int32, seed uint32) int32 {
  // fBm-ish: 3 octaves of value noise.
  n0 := noise2D(wx, wz, seed, 32)
  n1 := noise2D(wx, wz, seed^0xA53A, 16)
  n2 := noise2D(wx, wz, seed^0xC3E1, 8)

  n := (n0*0.55 + n1*0.30 + n2*0.15)

  // Map to a height range that sits nicely within a single 32-high chunk.
  h := int32(math.Round(6 + n*20)) // ~6..26
  return clampI32(h, 1, 30)
}
