// Top-down surface viewer (server-authoritative chunk snapshots)
// - Movable camera (pan + wheel/pinch zoom around cursor)
// - Strong depth cues from TopY (slope lighting + AO + contours + shoreline)
// - Chunk prefetch beyond viewport + request throttling
// - Mobile friendly (touch pan + pinch)
// - Debug HUD

const CW = 32;
const CD = 32;
const BYTES_PER_CHUNK_SNAPSHOT = CW * CD * 2;

// Zoom is "pixels per tile" in CSS pixels.
const ZOOM_MIN = 2.0;   // zoom out more (smaller tiles)
const ZOOM_MAX = 24.0;  // zoom in less (cap)

const TYPE_NAME = {
  0: 'air',
  1: 'grass',
  2: 'dirt',
  3: 'stone',
  4: 'water',
};

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d', { alpha: false });

let DPR = window.devicePixelRatio || 1;

// Camera in world-tile coordinates (x,z at screen center).
const camera = { x: 16, z: 16, zoom: 6.0 };

// Cache: key -> { topY, topT, imgCanvas, lastUsed }
const chunkCache = new Map();
const inflight = new Map();

// Request queue: array of {cx,cz,pri}. We keep it small by deduping with wanted.
let requestQueue = [];
const wanted = new Set();

const MAX_CACHED_CHUNKS = 512;
const MAX_INFLIGHT = 24;

// Prefetch extra ring beyond visible chunks (in chunk units, not pixels).
const MARGIN_CHUNKS = 3;

// Offscreen chunk raster: pixels per tile. 1 is fastest, 2 gives crisper detail at mid zoom.
const TILE_PIX = 2;

// ---------- math helpers ----------
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

// Floor division for negatives (matches Go floorDiv in backend).
function floorDiv(a, b) {
  const q = Math.trunc(a / b);
  const r = a % b;
  return (r !== 0 && ((r > 0) !== (b > 0))) ? q - 1 : q;
}
function mod(a, b) {
  const m = a % b;
  return m < 0 ? m + b : m;
}

function key(cx, cz) { return `${cx},${cz}`; }

// Snap camera so that drawing lands on device pixel grid (kills shimmer).
function snapCameraToPixels() {
  const s = camera.zoom * DPR;
  camera.x = Math.round(camera.x * s) / s;
  camera.z = Math.round(camera.z * s) / s;
}

// ---------- projection ----------
function worldToScreen(wx, wz) {
  const cx = window.innerWidth * 0.5;
  const cz = window.innerHeight * 0.5;
  return {
    x: (wx - camera.x) * camera.zoom + cx,
    y: (wz - camera.z) * camera.zoom + cz,
  };
}

function screenToWorld(sx, sy) {
  const cx = window.innerWidth * 0.5;
  const cz = window.innerHeight * 0.5;
  return {
    wx: (sx - cx) / camera.zoom + camera.x,
    wz: (sy - cz) / camera.zoom + camera.z,
  };
}

// ---------- rendering ----------
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
  DPR = window.devicePixelRatio || 1;

  canvas.style.width = window.innerWidth + 'px';
  canvas.style.height = window.innerHeight + 'px';

  canvas.width = Math.floor(window.innerWidth * DPR);
  canvas.height = Math.floor(window.innerHeight * DPR);

  // Use CSS pixel coordinates for all math; the transform maps to device pixels.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;

  scheduleWanted();
  requestRedraw();
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Create an offscreen chunk image with shading baked in.
function makeChunkImage(topY, topT) {
  const w = CW * TILE_PIX;
  const h = CD * TILE_PIX;

  const oc = document.createElement('canvas');
  oc.width = w;
  oc.height = h;
  const octx = oc.getContext('2d', { alpha: false });
  octx.imageSmoothingEnabled = false;

  const img = octx.createImageData(w, h);
  const d = img.data;

  // Lighting controls (tweakable)
  const SUNx = -0.55, SUNy = 0.85, SUNz = -0.25;
  const SUNlen = Math.hypot(SUNx, SUNy, SUNz);
  const NY = 10; // vertical scale; higher = flatter lighting

  function hAt(x, z) {
    if (x < 0) x = 0; else if (x >= CW) x = CW - 1;
    if (z < 0) z = 0; else if (z >= CD) z = CD - 1;
    return topY[x + z * CW];
  }
  function tAt(x, z) {
    if (x < 0) x = 0; else if (x >= CW) x = CW - 1;
    if (z < 0) z = 0; else if (z >= CD) z = CD - 1;
    return topT[x + z * CW];
  }

  for (let z = 0; z < CD; z++) {
    for (let x = 0; x < CW; x++) {
      const i = x + z * CW;
      const h0 = topY[i];
      const t = topT[i];

      // Base material color (cheap, runs once per chunk)
      let r = 0, g = 0, b = 0;
      if (t === 4) { r = 28; g = 68; b = clamp(120 + h0 * 3, 0, 255); } // water
      else if (t === 1) { r = clamp(30 + h0 * 3, 0, 255); g = clamp(108 + h0 * 2, 0, 255); b = 42; } // grass
      else if (t === 2) { r = clamp(92 + h0 * 2, 0, 255); g = clamp(70 + h0 * 2, 0, 255); b = 40; } // dirt
      else if (t === 3) { r = g = b = clamp(78 + h0 * 3, 0, 255); } // stone
      else { r = g = b = clamp(18 + h0 * 2, 0, 255); }

      // Slope lighting
      const hL = hAt(x - 1, z), hR = hAt(x + 1, z);
      const hU = hAt(x, z - 1), hD = hAt(x, z + 1);
      const dx = (hR - hL);
      const dz = (hD - hU);
      const nx = -dx, ny = NY, nz = -dz;

      const nLen = Math.hypot(nx, ny, nz) || 1;
      let dot = (nx * SUNx + ny * SUNy + nz * SUNz) / (nLen * SUNlen);

      let shade = clamp(0.65 + 0.65 * dot, 0.35, 1.25);

      // Ambient occlusion: darker if surrounded by higher terrain
      let occ = 0;
      const n1 = hAt(x - 1, z) - h0; if (n1 > 0) occ += clamp(n1 * 0.06, 0, 0.18);
      const n2 = hAt(x + 1, z) - h0; if (n2 > 0) occ += clamp(n2 * 0.06, 0, 0.18);
      const n3 = hAt(x, z - 1) - h0; if (n3 > 0) occ += clamp(n3 * 0.06, 0, 0.18);
      const n4 = hAt(x, z + 1) - h0; if (n4 > 0) occ += clamp(n4 * 0.06, 0, 0.18);
      shade *= (1.0 - clamp(occ, 0, 0.35));

      // Contours every 4 levels (subtle)
      if ((h0 & 3) === 0) shade *= 0.92;

      // Water: flatter + shoreline pop
      if (t === 4) {
        shade = clamp(0.75 + 0.45 * dot, 0.55, 1.20);
        if (tAt(x - 1, z) !== 4 || tAt(x + 1, z) !== 4 || tAt(x, z - 1) !== 4 || tAt(x, z + 1) !== 4) {
          shade *= 1.10;
        }
      }

      r = clamp(r * shade, 0, 255) | 0;
      g = clamp(g * shade, 0, 255) | 0;
      b = clamp(b * shade, 0, 255) | 0;

      // Write TILE_PIX x TILE_PIX pixels for this tile
      const x0 = x * TILE_PIX;
      const z0 = z * TILE_PIX;
      for (let tz = 0; tz < TILE_PIX; tz++) {
        for (let tx = 0; tx < TILE_PIX; tx++) {
          const p = ((x0 + tx) + (z0 + tz) * w) * 4;
          d[p + 0] = r;
          d[p + 1] = g;
          d[p + 2] = b;
          d[p + 3] = 255;
        }
      }
    }
  }

  octx.putImageData(img, 0, 0);
  return oc;
}

function enforceCacheCap() {
  if (chunkCache.size <= MAX_CACHED_CHUNKS) return;
  // Evict least recently used.
  let oldestK = null;
  let oldestT = Infinity;
  for (const [k, v] of chunkCache) {
    if (v.lastUsed < oldestT) {
      oldestT = v.lastUsed;
      oldestK = k;
    }
  }
  if (oldestK) chunkCache.delete(oldestK);
}

async function fetchChunk(cx, cz) {
  const k = key(cx, cz);
  if (chunkCache.has(k)) return chunkCache.get(k);
  if (inflight.has(k)) return inflight.get(k);

  const p = (async () => {
    const res = await fetch(`/api/chunk?cx=${cx}&cy=0&cz=${cz}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length !== BYTES_PER_CHUNK_SNAPSHOT) throw new Error(`Bad payload: ${buf.length}`);

    const topY = buf.slice(0, CW * CD);
    const topT = buf.slice(CW * CD);

    const imgCanvas = makeChunkImage(topY, topT);
    const entry = { cx, cz, topY, topT, imgCanvas, lastUsed: performance.now() };
    chunkCache.set(k, entry);
    inflight.delete(k);
    enforceCacheCap();
    requestRedraw();
    return entry;
  })().catch((err) => {
    inflight.delete(k);
    console.warn('chunk fetch failed', k, err);
    throw err;
  });

  inflight.set(k, p);
  return p;
}

// ---------- chunk scheduling ----------
function scheduleWanted() {
  wanted.clear();

  // Determine visible bounds in world tiles by inverting corners.
  const w = window.innerWidth;
  const h = window.innerHeight;

  const corners = [
    screenToWorld(0, 0),
    screenToWorld(w, 0),
    screenToWorld(0, h),
    screenToWorld(w, h),
  ];
  let minWx = Infinity, maxWx = -Infinity, minWz = Infinity, maxWz = -Infinity;
  for (const c of corners) {
    if (c.wx < minWx) minWx = c.wx;
    if (c.wx > maxWx) maxWx = c.wx;
    if (c.wz < minWz) minWz = c.wz;
    if (c.wz > maxWz) maxWz = c.wz;
  }

  let cx0 = floorDiv(Math.floor(minWx), CW) - MARGIN_CHUNKS;
  let cx1 = floorDiv(Math.floor(maxWx), CW) + MARGIN_CHUNKS;
  let cz0 = floorDiv(Math.floor(minWz), CD) - MARGIN_CHUNKS;
  let cz1 = floorDiv(Math.floor(maxWz), CD) + MARGIN_CHUNKS;

  // Build priority queue (closest first).
  requestQueue = [];
  const camCx = floorDiv(Math.floor(camera.x), CW);
  const camCz = floorDiv(Math.floor(camera.z), CD);

  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const k = key(cx, cz);
      wanted.add(k);
      if (chunkCache.has(k) || inflight.has(k)) continue;

      const dx = cx - camCx;
      const dz = cz - camCz;
      const pri = dx * dx + dz * dz;
      requestQueue.push({ cx, cz, pri });
    }
  }

  requestQueue.sort((a, b) => a.pri - b.pri);
}

// Pump requests up to MAX_INFLIGHT.
function pumpRequests() {
  while (inflight.size < MAX_INFLIGHT && requestQueue.length > 0) {
    const { cx, cz } = requestQueue.shift();
    fetchChunk(cx, cz).catch(() => {});
  }
}

// ---------- input ----------
let dragging = false;
let dragStart = null;

canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  dragging = true;
  dragStart = { x: ev.clientX, y: ev.clientY, camX: camera.x, camZ: camera.z };
});

window.addEventListener('mouseup', () => {
  dragging = false;
  dragStart = null;
});

window.addEventListener('mousemove', (ev) => {
  updateHUD(ev);

  if (!dragging || !dragStart) return;
  const dx = (ev.clientX - dragStart.x) / camera.zoom;
  const dz = (ev.clientY - dragStart.y) / camera.zoom;
  camera.x = dragStart.camX - dx;
  camera.z = dragStart.camZ - dz;
  snapCameraToPixels();
  scheduleWanted();
  pumpRequests();
  requestRedraw();
});

canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();

  const rect = canvas.getBoundingClientRect();
  const sx = ev.clientX - rect.left;
  const sy = ev.clientY - rect.top;

  const before = screenToWorld(sx, sy);

  const factor = Math.pow(1.0015, -ev.deltaY);
  camera.zoom = clamp(camera.zoom * factor, ZOOM_MIN, ZOOM_MAX);

  const after = screenToWorld(sx, sy);
  camera.x += (before.wx - after.wx);
  camera.z += (before.wz - after.wz);

  snapCameraToPixels();
  scheduleWanted();
  pumpRequests();
  requestRedraw();
}, { passive: false });

// Mobile: touch pan + pinch zoom
let touchMode = 0; // 0 none, 1 pan, 2 pinch
let t0 = null;
let pinchStartDist = 0;
let pinchStartZoom = 1;
let pinchAnchorWorld = null;

function touchDist(a, b) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}
function touchCenter(a, b) {
  return { x: (a.clientX + b.clientX) * 0.5, y: (a.clientY + b.clientY) * 0.5 };
}

canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (e.touches.length === 1) {
    touchMode = 1;
    const t = e.touches[0];
    t0 = { x: t.clientX, y: t.clientY, camX: camera.x, camZ: camera.z };
  } else if (e.touches.length === 2) {
    touchMode = 2;
    const a = e.touches[0], b = e.touches[1];
    pinchStartDist = touchDist(a, b);
    pinchStartZoom = camera.zoom;
    const c = touchCenter(a, b);
    pinchAnchorWorld = screenToWorld(c.x, c.y);
  }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (touchMode === 1 && e.touches.length === 1 && t0) {
    const t = e.touches[0];
    const dx = (t.clientX - t0.x) / camera.zoom;
    const dz = (t.clientY - t0.y) / camera.zoom;
    camera.x = t0.camX - dx;
    camera.z = t0.camZ - dz;
    snapCameraToPixels();
    scheduleWanted();
    pumpRequests();
    requestRedraw();
    updateHUD({ clientX: t.clientX, clientY: t.clientY });
  } else if (touchMode === 2 && e.touches.length === 2 && pinchAnchorWorld) {
    const a = e.touches[0], b = e.touches[1];
    const c = touchCenter(a, b);
    const dist = touchDist(a, b);

    let newZoom = pinchStartZoom * (dist / pinchStartDist);
    newZoom = clamp(newZoom, ZOOM_MIN, ZOOM_MAX);

    const before = pinchAnchorWorld;
    camera.zoom = newZoom;

    const after = screenToWorld(c.x, c.y);
    camera.x += (before.wx - after.wx);
    camera.z += (before.wz - after.wz);

    snapCameraToPixels();
    scheduleWanted();
    pumpRequests();
    requestRedraw();
    updateHUD({ clientX: c.x, clientY: c.y });
  }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) {
    touchMode = 0;
    t0 = null;
    pinchAnchorWorld = null;
  } else if (e.touches.length === 1) {
    touchMode = 1;
    const t = e.touches[0];
    t0 = { x: t.clientX, y: t.clientY, camX: camera.x, camZ: camera.z };
  }
}, { passive: false });

window.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- HUD ----------
const hudPointer = document.getElementById('hudPointer');
const hudChunk   = document.getElementById('hudChunk');
const hudLocal   = document.getElementById('hudLocal');
const hudTopY    = document.getElementById('hudTopY');
const hudType    = document.getElementById('hudType');

const hudZoom    = document.getElementById('hudZoom');
const hudChunks  = document.getElementById('hudChunks');
const hudInflight= document.getElementById('hudInflight');
const hudQueue   = document.getElementById('hudQueue');
const hudFPS     = document.getElementById('hudFPS');

let lastPointer = { x: window.innerWidth*0.5, y: window.innerHeight*0.5 };

function updateHUD(ev) {
  const rect = canvas.getBoundingClientRect();
  const px = (ev.clientX - rect.left);
  const py = (ev.clientY - rect.top);
  lastPointer = { x: px, y: py };

  const w = screenToWorld(px, py);

  const wxi = Math.floor(w.wx);
  const wzi = Math.floor(w.wz);

  const ccx = floorDiv(wxi, CW);
  const ccz = floorDiv(wzi, CD);
  const lx = mod(wxi, CW);
  const lz = mod(wzi, CD);

  hudPointer.textContent = `wx=${wxi} wz=${wzi}`;
  hudChunk.textContent   = `cx=${ccx} cz=${ccz}`;
  hudLocal.textContent   = `x=${lx} z=${lz}`;

  const k = key(ccx, ccz);
  const entry = chunkCache.get(k);
  if (entry) {
    entry.lastUsed = performance.now();
    const i = lx + lz * CW;
    const h = entry.topY[i];
    const t = entry.topT[i];
    hudTopY.textContent = `${h}`;
    hudType.textContent = `${t} (${TYPE_NAME[t] ?? 'unknown'})`;
  } else {
    hudTopY.textContent = '…';
    hudType.textContent = 'loading…';
    // Ensure hover chunk loads quickly.
    if (!inflight.has(k)) {
      requestQueue.unshift({ cx: ccx, cz: ccz, pri: -1 });
      pumpRequests();
    }
  }
}

// FPS
let fps = 0, _last = performance.now(), _acc = 0, _n = 0;
function trackFPS() {
  const now = performance.now();
  const dt = now - _last; _last = now;
  _acc += dt; _n++;
  if (_acc >= 500) {
    fps = 1000 / (_acc / _n);
    _acc = 0; _n = 0;
  }
}

// ---------- main draw ----------
function draw() {
  trackFPS();

  // Keep chunk requests flowing even when not interacting.
  scheduleWanted();
  pumpRequests();

  // Background
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  // Determine draw range in chunks (use wanted set bounds)
  // (We recompute bounds again here cheaply to avoid iterating wanted.)
  const w = window.innerWidth;
  const h = window.innerHeight;
  const corners = [screenToWorld(0,0), screenToWorld(w,0), screenToWorld(0,h), screenToWorld(w,h)];
  let minWx = Infinity, maxWx = -Infinity, minWz = Infinity, maxWz = -Infinity;
  for (const c of corners) {
    if (c.wx < minWx) minWx = c.wx;
    if (c.wx > maxWx) maxWx = c.wx;
    if (c.wz < minWz) minWz = c.wz;
    if (c.wz > maxWz) maxWz = c.wz;
  }
  let cx0 = floorDiv(Math.floor(minWx), CW) - MARGIN_CHUNKS;
  let cx1 = floorDiv(Math.floor(maxWx), CW) + MARGIN_CHUNKS;
  let cz0 = floorDiv(Math.floor(minWz), CD) - MARGIN_CHUNKS;
  let cz1 = floorDiv(Math.floor(maxWz), CD) + MARGIN_CHUNKS;

  // Draw chunks. (cz outer loop gives stable traversal)
  for (let cz = cz0; cz <= cz1; cz++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const k = key(cx, cz);
      const entry = chunkCache.get(k);
      if (!entry) continue;

      entry.lastUsed = performance.now();

      // world-space chunk bounds
      const wx0 = cx * CW;
      const wz0 = cz * CD;
      const wx1 = wx0 + CW;
      const wz1 = wz0 + CD;

      // convert BOTH corners to screen, then round edges
      const a = worldToScreen(wx0, wz0);
      const b = worldToScreen(wx1, wz1);

      const x0 = Math.round(a.x);
      const y0 = Math.round(a.z);
      const x1 = Math.round(b.x);
      const y1 = Math.round(b.z);

      const w = x1 - x0;
      const h = y1 - y0;

      // draw using edge-derived size (prevents gaps)
      ctx.drawImage(chunkImg, x0, y0, w + 1, h + 1);


      // Optional chunk grid at higher zoom (debug)
      if (camera.zoom >= 8) {
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.strokeRect(px0, py0, sizePxW, sizePxH);
      }
    }
  }

  // HUD extra debug
  if (hudZoom) hudZoom.textContent = `${camera.zoom.toFixed(2)} (dpr ${DPR.toFixed(2)})`;
  if (hudChunks) hudChunks.textContent = `${chunkCache.size} / ${MAX_CACHED_CHUNKS}`;
  if (hudInflight) hudInflight.textContent = `${inflight.size} / ${MAX_INFLIGHT}`;
  if (hudQueue) hudQueue.textContent = `${requestQueue.length}`;
  if (hudFPS) hudFPS.textContent = `${fps.toFixed(0)}`;

  // Keep HUD values alive even without mouse move
  updateHUD({ clientX: lastPointer.x, clientY: lastPointer.y });
}

// Initial prefetch
scheduleWanted();
pumpRequests();
requestRedraw();
