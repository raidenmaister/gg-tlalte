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

// Continentes reales del planeta Tierra (proyección cilíndrica equidistante exacta, 96x48)
// Cada fila corresponde a una latitud (-90° a +90°) con rangos [colInicio, colFin] reales.
const LAND_W = 96;
const LAND_H = 48;

const LAND_RANGES = [
  [], // 0 (88°N)
  [], // 1 (84°N)
  [[22, 28], [30, 43], [60, 61], [73, 73]], // 2 (81°N) Groenlandia, archipiélago ártico, Siberia
  [[16, 16], [22, 22], [24, 26], [29, 42], [52, 52], [75, 76]], // 3 (77°N)
  [[15, 17], [19, 19], [21, 25], [27, 27], [33, 41], [62, 62], [69, 79], [81, 81]], // 4 (73°N)
  [[4, 10], [12, 15], [17, 21], [23, 23], [25, 25], [28, 29], [34, 40], [53, 56], [64, 64], [66, 66], [68, 95]], // 5 (69°N) Alaska, Canadá norte, Escandinavia, Rusia
  [[0, 1], [3, 24], [28, 29], [34, 37], [42, 43], [51, 53], [55, 56], [59, 95]], // 6 (66°N)
  [[4, 22], [27, 28], [35, 36], [49, 52], [54, 90], [92, 94]], // 7 (62°N)
  [[6, 6], [12, 22], [27, 30], [51, 51], [55, 85], [90, 90]], // 8 (58°N) Canadá, Reino Unido, Báltico, Rusia
  [[13, 25], [27, 32], [47, 47], [50, 50], [52, 84], [90, 90]], // 9 (54°N)
  [[14, 31], [47, 84]], // 10 (51°N) EE.UU. norte, Europa central, Asia central
  [[15, 30], [47, 84]], // 11 (47°N)
  [[15, 28], [46, 48], [51, 51], [53, 54], [59, 60], [62, 83], [85, 86]], // 12 (43°N) EE.UU., Mediterráneo, Japón norte
  [[15, 27], [45, 47], [50, 50], [52, 53], [55, 60], [62, 81], [85, 85]], // 13 (39°N) España, Italia, Turquía, China
  [[16, 27], [46, 46], [48, 50], [58, 79], [82, 82], [84, 84]], // 14 (36°N)
  [[17, 25], [45, 51], [53, 54], [57, 79]], // 15 (32°N) Norte de África, Medio Oriente, China
  [[18, 21], [26, 26], [45, 60], [62, 79]], // 16 (28°N) México, Florida, Sahara, India norte
  [[19, 21], [44, 56], [58, 62], [66, 79]], // 17 (24°N) México, Golfo, India
  [[20, 21], [24, 24], [27, 27], [44, 57], [59, 63], [67, 70], [73, 75]], // 18 (21°N) Cuba, Sudeste Asiático
  [[21, 23], [44, 57], [59, 61], [68, 69], [73, 76], [80, 80]], // 19 (17°N) Centroamérica, Filipinas
  [[25, 25], [44, 58], [68, 68], [74, 76]], // 20 (13°N)
  [[28, 31], [44, 60], [68, 69], [79, 79], [81, 81]], // 21 (9°N) Colombia, Venezuela, África central
  [[27, 33], [45, 47], [49, 60], [79, 79]], // 22 (6°N)
  [[27, 34], [51, 59], [74, 75], [78, 78]], // 23 (2°N)
  [[26, 35], [50, 58], [75, 75], [77, 78], [83, 83]], // 24 (2°S) Ecuador, Amazonas, Indonesia
  [[26, 38], [51, 57], [85, 86]], // 25 (6°S) Brasil, Congo
  [[27, 38], [51, 58], [87, 87]], // 26 (9°S)
  [[28, 37], [51, 58], [83, 83]], // 27 (13°S) Perú, Bolivia, Angola
  [[29, 37], [51, 57], [60, 60], [81, 84], [86, 86]], // 28 (17°S) Madagascar, Australia norte
  [[29, 36], [52, 56], [60, 60], [79, 87]], // 29 (21°S)
  [[29, 34], [52, 56], [60, 60], [78, 88]], // 30 (24°S) Australia
  [[29, 34], [52, 56], [78, 88]], // 31 (28°S) Sudáfrica, Australia
  [[29, 33], [53, 55], [79, 81], [83, 88]], // 32 (32°S) Chile, Argentina, Australia sur
  [[29, 32], [85, 87], [94, 94]], // 33 (36°S) Nueva Zelanda
  [[28, 30], [94, 94]], // 34 (39°S)
  [[29, 30], [93, 93]], // 35 (43°S)
  [[28, 29]], // 36 (47°S) Patagonia
  [[28, 29]], // 37 (51°S)
  [[29, 29]], // 38 (54°S) Tierra del Fuego
  [], // 39 (58°S)
  [], // 40 (62°S)
  [], // 41 (66°S)
  [[30, 30], [57, 57], [59, 66], [69, 89]], // 42 (69°S) Península Antártica y costa
  [[20, 21], [24, 24], [29, 31], [44, 92]], // 43 (73°S) Antártida
  [[8, 26], [40, 91]], // 44 (77°S) Antártida
  [[9, 28], [31, 31], [34, 35], [40, 90]], // 45 (81°S) Antártida
  [[0, 0], [2, 2], [8, 94]], // 46 (84°S) Antártida
  [[0, 95]], // 47 (88°S) Polo Sur (continente antártico)
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

import { detectPotatoMode } from './utils.js?v=1.5.0';

export class AsciiEarthBackground {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      throw new Error('Contenedor del fondo ASCII no encontrado: ' + containerId);
    }

    this.isPotato = detectPotatoMode();

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
    // Si es PC patata, limita a 20 FPS para fluidez total sin saturar la CPU
    this._fps = this.isPotato ? 20 : 30;

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

    // Cuadrícula ASCII: adaptada si el hardware es muy modesto para aligerar la CPU
    const divisor = this.isPotato ? 44 : 56;
    const minCell = this.isPotato ? 12 : 10;
    const maxCell = this.isPotato ? 18 : 16;
    this.cell = Math.max(minCell, Math.min(maxCell, Math.round(Math.min(w, h) / divisor)));
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
    // Densidad adaptada según hardware
    const starDensity = this.isPotato ? 0.018 : 0.035;
    const count = Math.floor(this.cols * this.rows * starDensity);
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
