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

    this.rotation = -Math.PI / 2; // centra América al frente
    this.rotationSpeed = 0.05;    // rad/s

    this.stars = [];
    this._running = false;
    this._raf = 0;
    this._last = 0;
    this._frameAccum = 0;
    this._fps = 30;

    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);

    this._resize();
    this._renderFrame(performance.now());
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
      this._renderFrame(now);
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

    // Cuadrícula ASCII: celda entre 10 y 16 px según el tamaño de pantalla.
    this.cell = Math.max(10, Math.min(16, Math.round(Math.min(w, h) / 56)));
    this.cols = Math.ceil(w / this.cell);
    this.rows = Math.ceil(h / this.cell);

    this.ctx.font = `bold ${this.cell}px "Courier New", Consolas, monospace`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';

    // Esfera gigante desplazada hacia abajo a la derecha.
    const cx = w * 0.75;
    const cy = h * 1.2;
    const R = Math.min(w, h) * 0.9;

    this.cx = cx;
    this.cy = cy;
    this.R = R;

    // Dirección de la luz en 3D para iluminar el globo terráqueo de forma natural
    const ldx = -0.55;
    const ldy = -0.45;
    const lz = 0.70;
    const ll = Math.sqrt(ldx * ldx + ldy * ldy + lz * lz);
    this.lightX = ldx / ll;
    this.lightY = ldy / ll;
    this.lightZ = lz / ll;

    this._rebuildCells();
    this._buildStars();
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

  // Genera estrellas ASCII parpadeantes en el espacio profundo
  _buildStars() {
    // Densidad moderada y limpia
    const count = Math.floor(this.cols * this.rows * 0.035);
    const stars = [];

    // Colores sutiles y elegantes (blanco y luz estelar suave)
    const starColors = ['#ffffff', '#c8d6ff'];

    const charSets = [
      ['.', '*'],
      ['·', '+'],
      ['.', '·'],
      ['+', '*'],
    ];

    for (let i = 0; i < count; i++) {
      const col = Math.floor(Math.random() * this.cols);
      const row = Math.floor(Math.random() * this.rows);
      const x = col * this.cell + this.cell / 2;
      const y = row * this.cell + this.cell / 2;

      // Solo en el espacio exterior (fuera de la Tierra)
      const dx = x - this.cx;
      const dy = y - this.cy;
      if (dx * dx + dy * dy <= this.R * this.R) continue;

      stars.push({
        x,
        y,
        chars: charSets[Math.floor(Math.random() * charSets.length)],
        color: starColors[Math.floor(Math.random() * starColors.length)],
        speed: 0.35 + Math.random() * 0.65, // velocidad de titileo suave y pausada
        phase: Math.random() * Math.PI * 2,
        baseAlpha: 0.3 + Math.random() * 0.6,
      });
    }

    this.stars = stars;
  }

  // Dibuja las estrellas ASCII con animación de parpadeo armónico
  _drawStars(ctx, timeSec) {
    if (!this.stars || this.stars.length === 0) return;

    for (let i = 0; i < this.stars.length; i++) {
      const s = this.stars[i];
      // Ciclo senoidal de parpadeo suave
      const wave = 0.5 + 0.5 * Math.sin(timeSec * s.speed + s.phase);

      // Variación del carácter según la intensidad de brillo
      const charIdx = Math.min(s.chars.length - 1, Math.floor(wave * s.chars.length));
      const char = s.chars[charIdx];

      const alpha = Math.max(0.12, s.baseAlpha * (0.2 + 0.8 * wave));

      ctx.globalAlpha = alpha;
      ctx.fillStyle = s.color;
      ctx.fillText(char, s.x, s.y);
    }
    ctx.globalAlpha = 1.0;
  }

  /* ------------------------------------------------------------------ */
  /* Render del cuadro (estrellas parpadeantes + planeta)                */
  /* ------------------------------------------------------------------ */
  _renderFrame(now = 0) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Fondo oscuro espacial profundo
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, w, h);

    // 1. Estrellas parpadeantes en el espacio
    this._drawStars(ctx, now * 0.001);

    // 2. Planeta Tierra girando en 3D
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
