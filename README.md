# NPC Sim — Server-first voxel world skeleton (2026-01-03)

This is a **project skeleton** (folders + files + commented in-file structure).
No gameplay logic is implemented yet.

## Intended layout
- `cmd/server/`            — entrypoint that wires components together
- `internal/chunk/`        — chunk storage + indexing + serialization + cache
- `internal/gen/`          — deterministic generation pipeline (server-authoritative)
- `internal/world/`        — world state + tick loop + chunk lifecycle
- `internal/entity/`       — NPCs + machines as block-entities (sparse)
- `internal/net/`          — protocol + transport + delta batching
- `internal/sim/`          — simulations (fluids/lighting/path overlays)
- `internal/mathx/`        — small math/hash helpers (avoid “god utils”)

## In-file structure convention
Each `.go` file follows this order:
1. Package + purpose comment
2. Imports
3. Constants
4. Types
5. Constructors
6. Public methods
7. Private helpers
8. Tests live in `*_test.go`

Fill in module name / go.mod when you’re ready.
