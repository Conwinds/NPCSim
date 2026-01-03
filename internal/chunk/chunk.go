// internal/chunk/chunk.go
// Purpose: chunk data layout (SoA), constants, and core indexing helpers.
//
// Important: pick ONE index/packscheme and never change after persistence/networking.

package chunk

// --- Imports ---
//
// TODO

// --- Constants ---
//
// TODO: CW/CH/CD = 32
// TODO: SHIFT constants for bit-pack indexing
// TODO: N = CW*CH*CD

// --- Types ---
//
// TODO: ChunkCoord (X,Y,Z in chunk-space)
// TODO: Chunk struct: Type[ N ]uint8, Meta[ N ]uint8
// TODO: Sidecars: Props, BlockEntities mapping (idx->entityID)

// --- Constructors ---
//
// TODO: New(coord)

// --- Public methods ---
//
// TODO: Pack(x,y,z) -> uint16
// TODO: Unpack(p) -> x,y,z
// TODO: Idx(x,y,z) -> int
// TODO: Local bounds checks (optional)

// --- Private helpers ---
//
// TODO
