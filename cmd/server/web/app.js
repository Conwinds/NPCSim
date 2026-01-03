// Minimal top-down chunk surface viewer.
// Fetches /api/chunk and draws a 32x32 grid.

const CW = 32;
const CD = 32;

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

const cxIn = document.getElementById('cx');
const cyIn = document.getElementById('cy');
const czIn = document.getElementById('cz');
const loadBtn = document.getElementById('load');
const statusEl = document.getElementById('status');

let scale = 14;
canvas.width = CW * scale;
canvas.height = CD * scale;

function colorForType(t, h) {
  // Keep this intentionally small. More visual richness later comes from shading.
  // 0 air (shouldn't appear on surface), 1 grass, 2 dirt, 3 stone, 4 water.
  switch (t) {
    case 4: return `rgb(30, 70, ${120 + h*3})`;   // water
    case 1: return `rgb(${30 + h*3}, ${110 + h*2}, 40)`; // grass
    case 2: return `rgb(${90 + h*2}, ${70 + h*2}, 40)`;  // dirt
    case 3: return `rgb(${80 + h*3}, ${80 + h*3}, ${80 + h*3})`; // stone
    default: return `rgb(${20 + h*2}, ${20 + h*2}, ${20 + h*2})`;
  }
}

function drawSurface(topY, topT) {
  // redraw size in case scale changed
  canvas.width = CW * scale;
  canvas.height = CD * scale;

  for (let z = 0; z < CD; z++) {
    for (let x = 0; x < CW; x++) {
      const i = x + z*CW;
      const h = topY[i];
      const t = topT[i];
      ctx.fillStyle = colorForType(t, h);
      ctx.fillRect(x*scale, z*scale, scale, scale);
    }
  }
}

async function loadChunk() {
  const cx = Number(cxIn.value) | 0;
  const cy = Number(cyIn.value) | 0;
  const cz = Number(czIn.value) | 0;

  statusEl.textContent = 'Loading...';
  const res = await fetch(`/api/chunk?cx=${cx}&cy=${cy}&cz=${cz}`);
  if (!res.ok) {
    statusEl.textContent = `HTTP ${res.status}`;
    return;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length !== CW*CD*2) {
    statusEl.textContent = `Bad payload: ${buf.length}`;
    return;
  }

  const topY = buf.slice(0, CW*CD);
  const topT = buf.slice(CW*CD);
  drawSurface(topY, topT);
  statusEl.textContent = `Chunk (${cx},${cy},${cz})`;

  // hover readout
  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / scale);
    const z = Math.floor((ev.clientY - rect.top) / scale);
    if (x < 0 || x >= CW || z < 0 || z >= CD) return;
    const i = x + z*CW;
    statusEl.textContent = `Chunk (${cx},${cy},${cz})  local x=${x} z=${z}  topY=${topY[i]}  type=${topT[i]}`;
  };
}

loadBtn.onclick = () => loadChunk();

// mouse wheel zoom
canvas.onwheel = (ev) => {
  ev.preventDefault();
  const dir = Math.sign(ev.deltaY);
  scale = Math.min(40, Math.max(4, scale - dir));
  loadChunk();
};

loadChunk();
