// internal/world/world.go
// Purpose: authoritative world state. Owns chunk storage and exposes safe APIs.

package world

import (
  "sync"

  "github.com/Conwinds/NPCSim/internal/chunk"
  "github.com/Conwinds/NPCSim/internal/gen"
)

// --- Types ---

type World struct {
  seed uint32
  mu    sync.RWMutex
  chunks map[chunk.ChunkCoord]*chunk.Chunk
}

// --- Constructors ---

func NewWorld(seed uint32) *World {
  return &World{
    seed: seed,
    chunks: make(map[chunk.ChunkCoord]*chunk.Chunk, 256),
  }
}

// --- Public API ---

func (w *World) GetOrCreateChunk(c chunk.ChunkCoord) *chunk.Chunk {
  w.mu.RLock()
  ch := w.chunks[c]
  w.mu.RUnlock()
  if ch != nil {
    if !ch.TopValid {
      // Rebuild derived cache on demand.
      w.mu.RLock() // chunk itself isn't protected; this is fine for now (single-writer design later)
      ch.RebuildTopCache()
      w.mu.RUnlock()
    }
    return ch
  }

  // Create under write lock.
  w.mu.Lock()
  // Re-check in case of race.
  if ch = w.chunks[c]; ch == nil {
    ch = gen.GenerateChunk(c, gen.Context{Seed: w.seed})
    w.chunks[c] = ch
  }
  w.mu.Unlock()
  return ch
}
