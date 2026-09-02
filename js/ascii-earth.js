// ============================================================================
// ascii-earth.js — Tierra orbital en arte ASCII (proyección esférica real).
//
// Modela la Tierra como una esfera 3D interceptada por una cámara ortográfica.
// Todo (planeta, atmósfera, sol, rayos y estrellas) se dibuja con caracteres
// monoespaciados sobre un Canvas 2D, sin efectos CSS y sin nodos DOM masivos.
//
// Rendimiento "PC patata":
//   - Cuadrícula ASCII de baja resolución (~90 x ~57 celdas).
//   - Capa estática (estrellas + rayos + núcleo solar) pre-renderizada una vez
//     en un canvas offscreen; solo se redibuja el planeta giratorio.
//   - Proyección esférica directa; la matriz de celdas interiores se recalcula
//     únicamente al redimensionar la ventana.
//   - Límite de ~30 FPS con delta-time en requestAnimationFrame.
// ============================================================================

// Continentes del hemisferio occidental (Norteamérica, Centroamérica y el
// norte de Sudamérica). Cada fila es una latitud y cada rango [inicio, fin]
// son columnas de longitud (0..63) con tierra firme.
const LAND_W = 64;
const LAND_H = 32;

// Rango [startCol, endCol] inclusivo por fila. Fila 0 = polo norte.
const LAND_RANGES = [
  [],                                       // 0  ~87°N
  [],                                       // 1  ~81°N
  [[22, 28]],                               // 2  ~76°N  Groenlandia
  [[7, 19], [21, 28]],                      // 3  ~70°N  Groenlandia + ártico
  [[2, 20], [21, 27]],                      // 4  ~64°N  Alaska/Canadá/Groenlandia
  [[2, 19], [21, 26]],                      // 5  ~59°N
  [[3, 18]],                                // 6  ~53°N  Canadá
  [[3, 17]],                                // 7  ~48°N  Canadá/EE.UU.
  [[3, 16]],                                // 8  ~42°N  EE.UU.
  [[4, 15]],                                // 9  ~37°N  EE.UU.
  [[5, 15]],                                // 10 ~31°N  EE.UU./México
  [[6, 17]],                                // 11 ~25°N  México/Florida
  [[7, 15], [16, 17]],                      // 12 ~20°N  México/Cuba
  [[15, 18]],                               // 13 ~14°N  Centroamérica
  [[16, 18]],                               // 14 ~8°N   Panamá
  [[17, 20]],                               // 15 ~3°N   Colombia/Venezuela
  [[17, 22]],                               // 16 ~-3°N  Ecuador/Brasil
  [[17, 24]],                               // 17 ~-8°N  Brasil
  [[18, 25]],                               // 18 ~-14°N Brasil
  [[18, 25]],                               // 19 ~-20°N Brasil/Bolivia
  [[19, 25]],                               // 20 ~-25°N Brasil/Argentina
  [[19, 24]],                               // 21 ~-31°N Argentina/Chile
  [[19, 23]],                               // 22 ~-37°N Argentina
  [[19, 22]],                               // 23 ~-42°N Argentina
  [[19, 22]],                               // 24 ~-48°N Patagonia
  [[19, 21]],                               // 25 ~-53°N Patagonia
  [[19, 21]],                               // 26 ~-59°N extremo sur
  [],                                       // 27 ~-64°N
  [],                                       // 28 ~-70°N
  [],                                       // 29 ~-76°N
  [],                                       // 30 ~-81°N
  [],                                       // 31 ~-87°N
];

// Rampas de densidad: índice 0 = más tenue, 5 = más denso/brillante.
const LAND_CHARS = ['=', '+', '*', '%', '#', '@'];
const SEA_CHARS = [' ', ' ', ',', '.', ':', ':'];

// Paleta por nivel de iluminación (índice 0 = oscuro, 5 = brillante).
const LAND_COLORS = [
  '#3f4a38', '#5a6847', '#7c8252', '#a5a05a', '#cbc269', '#e9e4a8',
];
const SEA_COLORS = [
  '#071a30', '#0d3a5c', '#11629b', '#1f86c9', '#35b6e8', '#7cd7ff',
];

export class AsciiEarthBackground {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      throw new Error('Contenedor del fondo ASCII no encontrado: ' + containerId);
    }

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ascii-earth-canvas';
    this.container.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d');

    // Capa estática: espacio, estrellas, rayos y sol (se recalcula al resize).
    this.staticCanvas = document.createElement('canvas');
    this.staticCtx = this.staticCanvas.getContext('2d');

    this.rotation = -Math.PI / 2; // centra América al frente
    this.rotationSpeed = 0.05;    // rad/s

    this._running = false;
    this._raf = 0;
    this._last = 0;
    this._frameAccum = 0;
    this._fps = 30;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    this._resize();
    this._renderFrame();
  }

  start() {
    if (this._running) return;
    this._running = true;
    this.container.classList.remove('hidden');
    this._last = performance.now();
    this._frameAccum = 0;
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    this.container.classList.add('hidden');
  }

  _loop(now) {
    if (!this._running) return;

    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;

    this._frameAccum += dt;
    if (this._frameAccum >= 1 / this._fps) {
      this._frameAccum = 0;
      this.rotation += this.rotationSpeed * dt;
      if (this.rotation > Math.PI * 2) this.rotation -= Math.PI * 2;
      this._renderFrame();
    }

    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  /* ------------------------------------------------------------------ */
  /* Geometría                                                           */
  /* ------------------------------------------------------------------ */
  _resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.canvas.width = w;
    this.canvas.height = h;
    this.staticCanvas.width = w;
    this.staticCanvas.height = h;

    // Cuadrícula ASCII: celda entre 10 y 16 px según el tamaño de pantalla.
    this.cell = Math.max(10, Math.min(16, Math.round(Math.min(w, h) / 56)));
    this.cols = Math.ceil(w / this.cell);
    this.rows = Math.ceil(h / this.cell);

    this.ctx.font = `bold ${this.cell}px "Courier New", Consolas, monospace`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.staticCtx.font = this.ctx.font;
    this.staticCtx.textAlign = 'center';
    this.staticCtx.textBaseline = 'middle';

    // Esfera gigante desplazada fuera de la pantalla, abajo a la derecha.
    const cx = w * 0.75;
    const cy = h * 1.2;
    const R = Math.min(w, h) * 0.9;

    this.cx = cx;
    this.cy = cy;
    this.R = R;

    // Sol: clavado en el limbo (sobre el arco), a media-altura izquierda.
    // Dirección desde el centro hacia el sol en la pantalla.
    const dirx = -0.72;
    const diry = -0.62;
    const dl = Math.sqrt(dirx * dirx + diry * diry);
    const sunX = cx + R * (dirx / dl);
    const sunY = cy + R * (diry / dl);
    this.sunX = sunX;
    this.sunY = sunY;

    // Dirección de la luz (hacia el sol) en el espacio 3D de la esfera.
    // dx, dy se leen en la pantalla; z aporta una luz de relleno hacia la cámara.
    const ldx = sunX - cx;
    const ldy = sunY - cy;
    const lz = R * 0.22;
    const ll = Math.sqrt(ldx * ldx + ldy * ldy + lz * lz);
    this.lightX = ldx / ll;
    this.lightY = ldy / ll;
    this.lightZ = lz / ll;

    this._rebuildCells();
    this._rebuildStatic();
  }

  // Precalcula la posición y geometría de cada celda interior a la esfera.
  _rebuildCells() {
    const R = this.R;
    const cx = this.cx;
    const cy = this.cy;
    const cell = this.cell;
    const list = [];

    for (let row = 0; row < this.rows; row++) {
      const y = row * cell + cell / 2;
      const dy = y - cy;

      for (let col = 0; col < this.cols; col++) {
        const x = col * cell + cell / 2;
        const dx = x - cx;

        const d2 = dx * dx + dy * dy;
        if (d2 > R * R) continue;

        const d = Math.sqrt(d2);
        const z = Math.sqrt(Math.max(0, R * R - d2));
        list.push({ x, y, dx, dy, d, z });
      }
    }

    this.cells = list;
  }

  // Capa estática: espacio, estrellas, rayos y núcleo solar.
  _rebuildStatic() {
    const ctx = this.staticCtx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const cell = this.cell;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    this._drawStars(ctx);
    this._drawRays(ctx);
    this._drawSunCore(ctx);
  }

  _drawStars(ctx) {
    const count = Math.floor(this.cols * this.rows * 0.045);
    const chars = ['.', '*', '+'];
    ctx.fillStyle = '#b9c6ff';

    for (let i = 0; i < count; i++) {
      const col = Math.floor(Math.random() * this.cols);
      const row = Math.floor(Math.random() * this.rows);
      const x = col * this.cell + this.cell / 2;
      const y = row * this.cell + this.cell / 2;

      // Solo en el espacio exterior (fuera de la esfera).
      const dx = x - this.cx;
      const dy = y - this.cy;
      if (dx * dx + dy * dy <= this.R * this.R) continue;

      ctx.fillText(chars[(Math.random() * chars.length) | 0], x, y);
    }
  }

  _drawRays(ctx) {
    const sunX = this.sunX;
    const sunY = this.sunY;
    const R = this.R;
    const cx = this.cx;
    const cy = this.cy;
    const cell = this.cell;
    const w = this.canvas.width;
    const h = this.canvas.height;

    for (let row = 0; row < this.rows; row++) {
      const y = row * cell + cell / 2;
      for (let col = 0; col < this.cols; col++) {
        const x = col * cell + cell / 2;

        // Solo espacio exterior.
        const ddx = x - cx;
        const ddy = y - cy;
        if (ddx * ddx + ddy * ddy <= R * R) continue;

        const dsx = x - sunX;
        const dsy = y - sunY;
        const ds = Math.sqrt(dsx * dsx + dsy * dsy);
        if (ds < cell * 1.2) continue;
        if (ds > R * 0.85) continue;

        const theta = Math.atan2(dsy, dsx);
        // Patrón armónico que crea un abanico de rayos direccionales.
        const wave = Math.sin(8 * theta) + Math.sin(16 * theta);
        if (wave <= 0.35) continue;

        // Densidad inversa a la distancia al sol.
        const density = Math.max(0.25, 1 - ds / (R * 0.85));
        if (Math.random() > density * 0.75) continue;

        const c = this._rayChar(dsx, dsy);
        const bright = Math.min(1, density + 0.35);
        ctx.fillStyle = `rgba(255,238,190,${bright})`;
        ctx.fillText(c, x, y);
      }
    }
  }

  _rayChar(dx, dy) {
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    if (ax > ay * 2) return '-';
    if (ay > ax * 2) return '|';
    if (dx * dy > 0) return '\\';
    return '/';
  }

  _drawSunCore(ctx) {
    const sunX = this.sunX;
    const sunY = this.sunY;
    const cell = this.cell;
    const r = Math.max(2, Math.round(cell * 0.42));

    ctx.fillStyle = '#fff7e0';
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;

        let c;
        if (d < r * 0.4) c = '@';
        else if (d < r * 0.7) c = '0';
        else c = '#';

        ctx.fillText(c, sunX + dx * cell, sunY + dy * cell);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render del planeta (única pasada por celda interior)                */
  /* ------------------------------------------------------------------ */
  _renderFrame() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.staticCanvas, 0, 0);

    this._drawPlanet(ctx);
  }

  _drawPlanet(ctx) {
    const R = this.R;
    const rot = this.rotation;
    const lx = this.lightX;
    const ly = this.lightY;
    const lz = this.lightZ;
    const cell = this.cell;
    const atmoThickness = cell * 1.6;

    for (const p of this.cells) {
      const nx = p.dx / R;
      const ny = p.dy / R;
      const nz = p.z / R;

      // Limbo atmosférico: dispersión brillante en el borde.
      if (R - p.d < atmoThickness) {
        ctx.fillStyle = '#bfe6ff';
        ctx.fillText(((p.x + p.y) % 3 === 0) ? '#' : '*', p.x, p.y);
        continue;
      }

      // Iluminación difusa con luz ambiente.
      let light = nx * lx + ny * ly + nz * lz;
      light = 0.12 + 0.88 * Math.max(0, Math.min(1, light));
      const level = Math.min(5, Math.floor(light * 6));

      const lat = Math.asin(-ny);
      const lon = Math.atan2(nx, nz) + rot;

      const isLand = this._sampleLand(lat, lon);
      let c;
      let fill;

      if (isLand) {
        c = LAND_CHARS[level];
        fill = LAND_COLORS[level];
      } else {
        c = SEA_CHARS[level];
        fill = SEA_COLORS[level];
      }

      if (c === ' ') continue;
      ctx.fillStyle = fill;
      ctx.fillText(c, p.x, p.y);
    }
  }

  _sampleLand(lat, lon) {
    // Latitud -> fila (fila 0 = polo norte). Longitud -> columna envuelta.
    const u = (lon + Math.PI) / (Math.PI * 2);
    const col = ((Math.floor(u * LAND_W) % LAND_W) + LAND_W) % LAND_W;

    const v = (Math.PI / 2 - lat) / Math.PI; // 0 norte, 1 sur
    const row = Math.max(0, Math.min(LAND_H - 1, Math.floor(v * LAND_H)));

    const ranges = LAND_RANGES[row] || [];
    for (const [a, b] of ranges) {
      if (col >= a && col <= b) return true;
    }
    return false;
  }
}
