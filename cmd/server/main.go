// cmd/server/main.go
// Purpose: process entrypoint. Wires a minimal world generator + HTTP server + tiny UI.
//
// In-file structure:
// 1) Package + purpose comment
// 2) Imports
// 3) Constants
// 4) Types
// 5) Constructors
// 6) Public methods
// 7) Private helpers

package main

import (
  "embed"
  "fmt"
  "io"
  "io/fs"
  "log"
  "net/http"
  "strconv"

  "github.com/Conwinds/NPCSim/internal/chunk"
  "github.com/Conwinds/NPCSim/internal/world"
)

// --- Constants ---

const (
  listenAddr = ":8080"
  worldSeed  = uint32(1337)
)

// --- Embedded web UI ---

//go:embed web/*
var webFS embed.FS

func main() {
  w := world.NewWorld(worldSeed)

  // Static UI.
  sub, err := fs.Sub(webFS, "web")
  if err != nil {
    log.Fatalf("embed subfs: %v", err)
  }
  http.Handle("/", http.FileServer(http.FS(sub)))

  // Minimal API: top-down surface snapshot (2KB/chunk).
  http.HandleFunc("/api/chunk", func(rw http.ResponseWriter, r *http.Request) {
    cx := qI32(r, "cx", 0)
    cy := qI32(r, "cy", 0)
    cz := qI32(r, "cz", 0)

    c := w.GetOrCreateChunk(chunk.ChunkCoord{X: cx, Y: cy, Z: cz})

    rw.Header().Set("Content-Type", "application/octet-stream")
    rw.Header().Set("Cache-Control", "no-store")

    // Layout: [1024] TopY (0..31), then [1024] TopType.
    buf := make([]byte, chunk.CW*chunk.CD*2)
    copy(buf[:chunk.CW*chunk.CD], c.TopY[:])
    copy(buf[chunk.CW*chunk.CD:], c.TopType[:])
    _, _ = rw.Write(buf)
  })

  // Tiny health endpoint.
  http.HandleFunc("/api/ping", func(rw http.ResponseWriter, _ *http.Request) {
    rw.Header().Set("Content-Type", "text/plain; charset=utf-8")
    _, _ = io.WriteString(rw, "pong\n")
  })

  fmt.Printf("NPCSim server running on http://localhost%s\n", listenAddr)
  log.Fatal(http.ListenAndServe(listenAddr, nil))
}

// --- Helpers ---

func qI32(r *http.Request, key string, def int32) int32 {
  s := r.URL.Query().Get(key)
  if s == "" {
    return def
  }
  v, err := strconv.ParseInt(s, 10, 32)
  if err != nil {
    return def
  }
  return int32(v)
}
