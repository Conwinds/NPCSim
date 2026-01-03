// internal/gen/pipeline.go
// Purpose: deterministic generation pipeline; ordered passes:
// terrain -> carve -> water -> surface classify -> props -> ores.
//
// Generation should be pure-ish: chunk coord + global seed -> same output.

package gen

// --- Imports ---
//
// TODO

// --- Types ---
//
// TODO: Context (seed, world params)
// TODO: Pass interface { Name() string; Run(...) error }

// --- Public methods ---
//
// TODO: GenerateChunk(coord) -> chunk.Chunk
// TODO: DefaultPipeline() []Pass

// --- Private helpers ---
//
// TODO: pass ordering, shared scratch buffers
