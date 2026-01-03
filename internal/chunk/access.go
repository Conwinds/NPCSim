// internal/chunk/access.go
// Purpose: tiny Get/Set helpers operating on packed positions or linear indices.
// Keep these inline-friendly.

package chunk

// --- Public methods ---

func (c *Chunk) GetTypeIdx(idx int) uint8 { return c.Type[idx] }
func (c *Chunk) GetMetaIdx(idx int) uint8 { return c.Meta[idx] }

func (c *Chunk) SetTypeIdx(idx int, t uint8) {
  c.Type[idx] = t
  c.TopValid = false
}

func (c *Chunk) SetMetaIdx(idx int, m uint8) {
  c.Meta[idx] = m
}

func (c *Chunk) Get(p uint16) (t, m uint8) {
  i := IdxFromPacked(p)
  return c.Type[i], c.Meta[i]
}

func (c *Chunk) Set(p uint16, t, m uint8) {
  i := IdxFromPacked(p)
  c.Type[i] = t
  c.Meta[i] = m
  c.TopValid = false
}
