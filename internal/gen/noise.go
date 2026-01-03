// internal/gen/noise.go
// Purpose: deterministic value noise (seam-safe) sampled in world coordinates.

package gen

import "github.com/Conwinds/NPCSim/internal/mathx"

// --- Private helpers ---

// noise2D returns smooth-ish value noise in range [0,1] at integer world coords.
// `cell` controls the coarseness: larger cell = bigger features.
func noise2D(wx, wz int32, seed uint32, cell int32) float64 {
  // Identify the lattice cell.
  x0 := (wx / cell) * cell
  z0 := (wz / cell) * cell
  x1 := x0 + cell
  z1 := z0 + cell

  // Fraction within cell [0,1).
  fx := float64(wx-x0) / float64(cell)
  fz := float64(wz-z0) / float64(cell)

  // Fade for smoother interpolation.
  u := fade(fx)
  v := fade(fz)

  // Corner values.
  v00 := hash01(seed, x0, z0)
  v10 := hash01(seed, x1, z0)
  v01 := hash01(seed, x0, z1)
  v11 := hash01(seed, x1, z1)

  a := lerp(v00, v10, u)
  b := lerp(v01, v11, u)
  return lerp(a, b, v)
}

func hash01(seed uint32, x, z int32) float64 {
  h := mathx.Hash2(seed, x, z)
  // Map uint32 -> [0,1]. Use 24 MSBs for stable float precision.
  return float64(h>>8) / float64(1<<24)
}

func lerp(a, b, t float64) float64 { return a + (b-a)*t }

func fade(t float64) float64 {
  // Perlin's 6t^5 - 15t^4 + 10t^3
  return t * t * t * (t*(t*6-15) + 10)
}


