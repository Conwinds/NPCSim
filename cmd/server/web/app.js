// Top-down surface viewer with a movable camera and a floating HUD.
//
// Server endpoint: /api/chunk?cx&cy&cz returns 32x32 surface snapshot (TopY + TopType).
// We stream multiple chunks around the camera as you pan/zoom.

const CW = 32;
const CD = 32;
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

function makeChunkImage(topY, topT) {
  // Pre-render into a 32x32 offscreen canvas (1px per tile), then scale via drawImage.
  const oc = document.createElement('canvas');
  oc.width = CW;
  oc.height = CD;
  const octx = oc.getContext('2d');
  octx.imageSmoothingEnabled = false;

  const img = octx.createImageData(CW, CD);
  const d = img.data;
  for (let z = 0; z < CD; z++) {
    for (let x = 0; x < CW; x++) {
      const i = x + z * CW;
      const h = topY[i];
      const t = topT[i];

      // Parse rgb(...) to bytes cheaply would be annoying; instead use a tiny
      // hand-coded palette-ish conversion here.
      // Keep it branchy but small: this runs only on chunk load, not per frame.
      let r = 0, g = 0, b = 0;
      if (t === 4) { r = 28; g = 68; b = clamp(120 + h * 3, 0, 255); }
      else if (t === 1) { r = clamp(30 + h * 3, 0, 255); g = clamp(108 + h * 2, 0, 255); b = 42; }
      else if (t === 2) { r = clamp(92 + h * 2, 0, 255); g = clamp(70 + h * 2, 0, 255); b = 40; }
      else if (t === 3) { r = g = b = clamp(78 + h * 3, 0, 255); }
      else { r = g = b = clamp(18 + h * 2, 0, 255); }

      const p = (i * 4);
      d[p + 0] = r;
      d[p + 1] = g;
      d[p + 2] = b;
      d[p + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
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

function screenToWorld(px, pz) {
  const cx = window.innerWidth * 0.5;
  const cz = window.innerHeight * 0.5;
  return {
    x: (px - cx) / camera.zoom + camera.x,
    z: (pz - cz) / camera.zoom + camera.z,
  };
}

function worldToScreen(wx, wz) {
  const cx = window.innerWidth * 0.5;
  const cz = window.innerHeight * 0.5;
  return {
    x: (wx - camera.x) * camera.zoom + cx,
    z: (wz - camera.z) * camera.zoom + cz,
  };
}

function updateHUD(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const pz = ev.clientY - rect.top;
  const w = screenToWorld(px, pz);

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
  const pz = ev.clientY - rect.top;
  const w = screenToWorld(px, pz);
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
  const pz = ev.clientY - rect.top;
  const w = screenToWorld(px, pz);
  dragStart = { x: w.x, z: w.z, camX: camera.x, camZ: camera.z };
});

window.addEventListener('mouseup', () => { isDragging = false; });

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const px = ev.clientX - rect.left;
  const pz = ev.clientY - rect.top;
  const before = screenToWorld(px, pz);

  // Exponential zoom: smooth and consistent.
  const factor = Math.pow(1.0018, -ev.deltaY);
  camera.zoom = clamp(camera.zoom * factor, ZOOM_MIN, ZOOM_MAX);

  const after = screenToWorld(px, pz);
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

  // Determine visible world bounds in tile space.
  const tl = screenToWorld(0, 0);
  const br = screenToWorld(window.innerWidth, window.innerHeight);
  const minX = Math.floor(Math.min(tl.x, br.x)) - 1;
  const maxX = Math.floor(Math.max(tl.x, br.x)) + 1;
  const minZ = Math.floor(Math.min(tl.z, br.z)) - 1;
  const maxZ = Math.floor(Math.max(tl.z, br.z)) + 1;

  const minCX = floorDiv(minX, CW);
  const maxCX = floorDiv(maxX, CW);
  const minCZ = floorDiv(minZ, CD);
  const maxCZ = floorDiv(maxZ, CD);

  // Request visible chunks and draw those that are already in cache.
  for (let cz = minCZ; cz <= maxCZ; cz++) {
    for (let cx = minCX; cx <= maxCX; cx++) {
      const k = key(cx, 0, cz);
      const entry = chunkCache.get(k);
      const wx0 = cx * CW;
      const wz0 = cz * CD;
      const s = worldToScreen(wx0, wz0);
      const px0 = s.x;
      const pz0 = s.z;
      const sizePx = CW * camera.zoom;

      if (entry) {
        entry.lastUsed = performance.now();
        ctx.drawImage(entry.imgCanvas, px0, pz0, sizePx, sizePx);

        // Subtle chunk border
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.strokeRect(px0, pz0, sizePx, sizePx);
      } else {
        // Placeholder while loading
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.strokeRect(px0, pz0, sizePx, sizePx);
        fetchChunk(cx, 0, cz).catch(() => {});
      }
    }
  }
}

// Start centered near origin and prefetch a small ring.
camera.x = 16;
camera.z = 16;
requestRedraw();