// Top-down surface viewer with a movable camera and a floating HUD.
//
// Server endpoint: /api/chunk?cx&cy&cz returns 32x32 surface snapshot (TopY + TopType).
// We stream multiple chunks around the camera as you pan/zoom.

const CW = 32;
const CD = 32;
// Isometric projection constants (fixed; zoom handled by camera.zoom).
// Tile diamond: TILE_W x TILE_H pixels at zoom=1.
const CH = 32;
const TILE_W = 16;
const TILE_H = 8;
const HALF_W = TILE_W * 0.5;
const HALF_H = TILE_H * 0.5;
const H_STEP = 4; // pixels per height level (TopY)

const CHUNK_SHIFT_X = (CD - 1) * HALF_W;
// Lift the whole chunk so the tallest columns stay within the offscreen canvas.
const CHUNK_SHIFT_Y = CH * H_STEP + TILE_H;

// Canvas size for a pre-rendered isometric chunk. Sized conservatively to fit cliffs.
// Width works out to (CW+CD)/2 * TILE_W for CW=CD=32 => 512px.
const CHUNK_CANVAS_W = ((CW + CD) * 0.5) * TILE_W;
// Height includes: base iso height + max wall drop + padding.
const CHUNK_CANVAS_H = ((CW + CD) * HALF_H) + (CH * H_STEP) + (CH * H_STEP) + (TILE_H * 2);
const BYTES_PER_CHUNK_SNAPSHOT = CW * CD * 2; // TopY + TopType

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });
ctx.imageSmoothingEnabled = false;

// HUD elements
const hudPointer = document.getElementById('hudPointer');
const hudChunk = document.getElementById('hudChunk');
const hudLocal = document.getElementById('hudLocal');
const hudTopY = document.getElementById('hudTopY');
const hudType = document.getElementById('hudType');

// Camera in world tile coordinates (x,z) with zoom in pixels per tile.
const camera = {
  x: 0.0,
  z: 0.0,
  zoom: 18.0, // px per tile
};

const ZOOM_MIN = 4;
const ZOOM_MAX = 80;

// Deterministic mapping to human-readable type names (keep tiny for now).
const TYPE_NAME = {
  0: 'air',
  1: 'grass',
  2: 'dirt',
  3: 'stone',
  4: 'water',
};

// Chunk cache: key -> { topY, topT, imgCanvas, lastUsed }
const chunkCache = new Map();
const inflight = new Map();

// Simple LRU-ish cap to avoid unbounded memory in the browser.
const MAX_CACHED_CHUNKS = 256;

function key(cx, cy, cz) { return `${cx},${cy},${cz}`; }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// floor division that behaves correctly for negatives.
function floorDiv(a, b) {
  const q = Math.trunc(a / b);
  const r = a % b;
  return (r !== 0 && ((r > 0) !== (b > 0))) ? q - 1 : q;
}

function mod(a, b) {
  const m = a % b;
  return m < 0 ? m + b : m;
}

// Draw loop (on-demand).
let redrawPending = false;
function requestRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  requestAnimationFrame(() => {
    redrawPending = false;
    draw();
  });
}


function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = false;
  requestRedraw();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function colorForType(t, h) {
  // Small palette; most richness later should come from shading/props.
  switch (t) {
    case 4: return `rgb(28, 68, ${120 + h * 3})`;             // water
    case 1: return `rgb(${30 + h * 3}, ${108 + h * 2}, 42)`;  // grass
    case 2: return `rgb(${92 + h * 2}, ${70 + h * 2}, 40)`;   // dirt
    case 3: return `rgb(${78 + h * 3}, ${78 + h * 3}, ${78 + h * 3})`; // stone
    default: return `rgb(${18 + h * 2}, ${18 + h * 2}, ${18 + h * 2})`;
  }
}

function shadeByte(v, f) { return clamp(Math.round(v * f), 0, 255); }

function makeChunkImage(topY, topT) {
  // Pre-render an isometric chunk into an offscreen canvas (server authoritative).
  // This runs only on chunk load, so polygon drawing is fine.

  const oc = document.createElement('canvas');
  oc.width = CHUNK_CANVAS_W | 0;
  oc.height = CHUNK_CANVAS_H | 0;
  const octx = oc.getContext('2d', { alpha: true });
  octx.imageSmoothingEnabled = false;

  // Transparent background; main canvas clears each frame.
  octx.clearRect(0, 0, oc.width, oc.height);

  // Draw back-to-front: increasing (x+z).
  for (let s = 0; s <= (CW - 1) + (CD - 1); s++) {
    for (let x = 0; x < CW; x++) {
      const z = s - x;
      if (z < 0 || z >= CD) continue;

      const i = x + z * CW;
      const h = topY[i];
      const t = topT[i];

      // Neighbor heights for visible cliff faces (avoid chunk-border artifacts by clamping to self).
      const hSouth = (z + 1 < CD) ? topY[i + CW] : h;
      const hEast  = (x + 1 < CW) ? topY[i + 1] : h;

      const wallL = Math.max(0, h - hSouth) * H_STEP; // towards +z
      const wallR = Math.max(0, h - hEast)  * H_STEP; // towards +x

      // Base color (same mapping as before; runs only at chunk load).
      let r = 0, g = 0, b = 0;
      if (t === 4) { r = 28; g = 68; b = clamp(120 + h * 3, 0, 255); }           // water
      else if (t === 1) { r = clamp(30 + h * 3, 0, 255); g = clamp(108 + h * 2, 0, 255); b = 42; } // grass
      else if (t === 2) { r = clamp(92 + h * 2, 0, 255); g = clamp(70 + h * 2, 0, 255); b = 40; }  // dirt
      else if (t === 3) { r = g = b = clamp(78 + h * 3, 0, 255); }                                  // rock
      else { r = g = b = clamp(18 + h * 2, 0, 255); }                                                // fallback

      // Iso top center (integer coordinates -> crisp).
      const cx = (CHUNK_SHIFT_X + (x - z) * HALF_W) | 0;
      const cy = (CHUNK_SHIFT_Y + (x + z) * HALF_H - h * H_STEP) | 0;

      // Points of the top diamond.
      const nx = cx,           ny = cy - HALF_H;
      const ex = cx + HALF_W,  ey = cy;
      const sx = cx,           sy = cy + HALF_H;
      const wx = cx - HALF_W,  wy = cy;

      // Side bottoms (can differ per face).
      const syL = sy + wallL;
      const wyL = wy + wallL;

      const syR = sy + wallR;
      const eyR = ey + wallR;

      // Left face (towards +z): W-S edge dropped by wallL.
      if (wallL > 0) {
        octx.fillStyle = `rgb(${shadeByte(r, 0.70)},${shadeByte(g, 0.70)},${shadeByte(b, 0.70)})`;
        octx.beginPath();
        octx.moveTo(wx, wy);
        octx.lineTo(sx, sy);
        octx.lineTo(sx, syL);
        octx.lineTo(wx, wyL);
        octx.closePath();
        octx.fill();
      }

      // Right face (towards +x): E-S edge dropped by wallR.
      if (wallR > 0) {
        octx.fillStyle = `rgb(${shadeByte(r, 0.58)},${shadeByte(g, 0.58)},${shadeByte(b, 0.58)})`;
        octx.beginPath();
        octx.moveTo(ex, ey);
        octx.lineTo(sx, sy);
        octx.lineTo(sx, syR);
        octx.lineTo(ex, eyR);
        octx.closePath();
        octx.fill();
      }

      // Top face (slightly lighter).
      octx.fillStyle = `rgb(${shadeByte(r, 1.06)},${shadeByte(g, 1.06)},${shadeByte(b, 1.06)})`;
      octx.beginPath();
      octx.moveTo(nx, ny);
      octx.lineTo(ex, ey);
      octx.lineTo(sx, sy);
      octx.lineTo(wx, wy);
      octx.closePath();
      octx.fill();

      // Subtle edge lines for readability.
      octx.strokeStyle = 'rgba(0,0,0,0.18)';
      octx.beginPath();
      octx.moveTo(nx, ny);
      octx.lineTo(ex, ey);
      octx.lineTo(sx, sy);
      octx.lineTo(wx, wy);
      octx.closePath();
      octx.stroke();
    }
  }

  return oc;
}
async function fetchChunk(cx, cy, cz) {
  const k = key(cx, cy, cz);
  if (chunkCache.has(k)) return chunkCache.get(k);
  if (inflight.has(k)) return inflight.get(k);

  const p = (async () => {
    const res = await fetch(`/api/chunk?cx=${cx}&cy=${cy}&cz=${cz}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== BYTES_PER_CHUNK_SNAPSHOT) {
      throw new Error(`Bad payload: ${buf.length}`);
    }

    const topY = buf.slice(0, CW * CD);
    const topT = buf.slice(CW * CD);
    const imgCanvas = makeChunkImage(topY, topT);
    const entry = { topY, topT, imgCanvas, lastUsed: performance.now() };
    chunkCache.set(k, entry);
    inflight.delete(k);

    enforceCacheCap();
    requestRedraw();
    return entry;
  })().catch((err) => {
    inflight.delete(k);
    // Keep a tiny negative cache entry? Not yet; let it retry.
    console.warn('chunk fetch failed', k, err);
    requestRedraw();
    throw err;
  });

  inflight.set(k, p);
  return p;
}

function enforceCacheCap() {
  if (chunkCache.size <= MAX_CACHED_CHUNKS) return;

  // Evict oldest.
  let oldestK = null;
  let oldestT = Infinity;
  for (const [k, v] of chunkCache.entries()) {
    if (v.lastUsed < oldestT) {
      oldestT = v.lastUsed;
      oldestK = k;
    }
  }
  if (oldestK) chunkCache.delete(oldestK);
}

function screenToWorld(px, py) {
  // Inverse of worldToScreen for the ground plane (y ignored for picking/HUD).
  const cx = window.innerWidth * 0.5;
  const cy = window.innerHeight * 0.5;

  // Convert screen -> iso-space (pre-zoom, camera-centered).
  const camIsoX = (camera.x - camera.z) * HALF_W;
  const camIsoY = (camera.x + camera.z) * HALF_H;

  const isoX = (px - cx) / camera.zoom + camIsoX;
  const isoY = (py - cy) / camera.zoom + camIsoY;

  const a = isoX / HALF_W;
  const b = isoY / HALF_H;

  return {
    x: (a + b) * 0.5,
    z: (b - a) * 0.5,
  };
}


function worldToScreen(wx, wz, h = 0) {
  const cx = window.innerWidth * 0.5;
  const cy = window.innerHeight * 0.5;

  const camIsoX = (camera.x - camera.z) * HALF_W;
  const camIsoY = (camera.x + camera.z) * HALF_H;

  const isoX = (wx - wz) * HALF_W;
  const isoY = (wx + wz) * HALF_H - h * H_STEP;

  return {
    x: (isoX - camIsoX) * camera.zoom + cx,
    y: (isoY - camIsoY) * camera.zoom + cy,
  };
}


function updateHUD(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const w = screenToWorld(px, py);

  const wx = Math.floor(w.x);
  const wz = Math.floor(w.z);
  const ccx = floorDiv(wx, CW);
  const ccz = floorDiv(wz, CD);
  const lx = mod(wx, CW);
  const lz = mod(wz, CD);
  const i = lx + lz * CW;

  hudPointer.textContent = `wx=${wx} wz=${wz}`;
  hudChunk.textContent = `cx=${ccx} cy=0 cz=${ccz}`;
  hudLocal.textContent = `x=${lx} z=${lz}`;

  const k = key(ccx, 0, ccz);
  const entry = chunkCache.get(k);
  if (entry) {
    entry.lastUsed = performance.now();
    const h = entry.topY[i];
    const t = entry.topT[i];
    hudTopY.textContent = `${h}`;
    hudType.textContent = `${t} (${TYPE_NAME[t] ?? 'unknown'})`;
  } else {
    hudTopY.textContent = '…';
    hudType.textContent = 'loading…';
    // Fire-and-forget fetch for hover chunk.
    fetchChunk(ccx, 0, ccz).catch(() => {});
  }
}

// Camera controls: drag-to-pan, wheel-to-zoom (zoom around pointer).
let isDragging = false;
let dragStart = { x: 0, z: 0, camX: 0, camZ: 0 };

canvas.addEventListener('mousemove', (ev) => {
  updateHUD(ev);
  if (!isDragging) return;
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const w = screenToWorld(px, py);
  const dx = w.x - dragStart.x;
  const dz = w.z - dragStart.z;
  camera.x = dragStart.camX - dx;
  camera.z = dragStart.camZ - dz;
  requestRedraw();
});

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return; // left only
  isDragging = true;
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const w = screenToWorld(px, py);
  dragStart = { x: w.x, z: w.z, camX: camera.x, camZ: camera.z };
});

window.addEventListener('mouseup', () => { isDragging = false; });

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const py = ev.clientY - rect.top;
  const before = screenToWorld(px, py);

  // Exponential zoom: smooth and consistent.
  const factor = Math.pow(1.0018, -ev.deltaY);
  camera.zoom = clamp(camera.zoom * factor, ZOOM_MIN, ZOOM_MAX);

  const after = screenToWorld(px, py);
  // Keep the world point under the cursor fixed while zooming.
  camera.x += (before.x - after.x);
  camera.z += (before.z - after.z);

  requestRedraw();
});

// Optional: disable context menu (keeps right click available later).
window.addEventListener('contextmenu', (e) => e.preventDefault());

function draw() {
  // Background
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  // Screen center and camera position in iso-space (used for chunk blitting).
  const cxScr = window.innerWidth * 0.5;
  const cyScr = window.innerHeight * 0.5;
  const camIsoX = (camera.x - camera.z) * HALF_W;
  const camIsoY = (camera.x + camera.z) * HALF_H;


  // Determine visible world bounds in tile space (approx) by inverting the 4 screen corners.
  const p0 = screenToWorld(0, 0);
  const p1 = screenToWorld(window.innerWidth, 0);
  const p2 = screenToWorld(0, window.innerHeight);
  const p3 = screenToWorld(window.innerWidth, window.innerHeight);

  const minX = Math.floor(Math.min(p0.x, p1.x, p2.x, p3.x)) - 2;
  const maxX = Math.floor(Math.max(p0.x, p1.x, p2.x, p3.x)) + 2;
  const minZ = Math.floor(Math.min(p0.z, p1.z, p2.z, p3.z)) - 2;
  const maxZ = Math.floor(Math.max(p0.z, p1.z, p2.z, p3.z)) + 2;

  const minCX = floorDiv(minX, CW);
  const maxCX = floorDiv(maxX, CW);
  const minCZ = floorDiv(minZ, CD);
  const maxCZ = floorDiv(maxZ, CD);

  // Draw far -> near by chunk diagonal (cx+cz). This avoids overlap glitches in iso.
  const minS = minCX + minCZ;
  const maxS = maxCX + maxCZ;

  for (let s = minS; s <= maxS; s++) {
    for (let cz = minCZ; cz <= maxCZ; cz++) {
      const cx = s - cz;
      if (cx < minCX || cx > maxCX) continue;

      const k = key(cx, 0, cz);
      const entry = chunkCache.get(k);

      const wx0 = cx * CW;
      const wz0 = cz * CD;

      // Iso-space top-left where the chunk canvas should be drawn.
      const isoX0 = (wx0 - wz0) * HALF_W - CHUNK_SHIFT_X;
      const isoY0 = (wx0 + wz0) * HALF_H - CHUNK_SHIFT_Y;

      // Avoid recomputing camera iso here: use worldToScreen on a dummy and derive cx/cy each call is expensive.
      // We'll compute screen position directly from iso coords.

      const px0 = Math.round((isoX0 - camIsoX) * camera.zoom + cxScr);
      const py0 = Math.round((isoY0 - camIsoY) * camera.zoom + cyScr);

      const dw = Math.round(CHUNK_CANVAS_W * camera.zoom);
      const dh = Math.round(CHUNK_CANVAS_H * camera.zoom);

      if (entry) {
        entry.lastUsed = performance.now();
        ctx.drawImage(entry.imgCanvas, px0, py0, dw, dh);
      } else {
        // Placeholder while loading: request chunk (no drawing)
        fetchChunk(cx, 0, cz).catch(() => {});
      }
    }
  }
}


// Start centered near origin and prefetch a small ring.
camera.x = 16;
camera.z = 16;
requestRedraw();