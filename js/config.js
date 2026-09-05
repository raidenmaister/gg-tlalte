// ============================================================================
// config.js — Constantes globales y reglas del juego.
// ============================================================================

export const CONFIG = {
  // Versión oficial de la aplicación visible en menús
  VERSION: 'BETA v1.7.7',

  // Fallback opcional de API Key (cliente). La key real se define en
  // js/keys.js (window.GG_GOOGLE_MAPS_API_KEY), que se mantiene local y NO se
  // sube a GitHub. Si ambas quedan vacías, el visor la pedirá por prompt.
  GOOGLE_API_KEY: '',

  // Archivo con las ubicaciones jugables ({lat,lng,pano_id,date}).
  COORDINATES_URL: 'coordenadas_validas.json',

  // Prefijo para los IDs de PeerJS (evita colisiones en el cloud público).
  PEER_PREFIX: 'ggtlalte-v1-',

  // Servidores ICE para PeerJS. STUN descubre la IP pública; TURN retransmite
  // el tráfico cuando el NAT/firewall bloquea la conexión P2P directa (por
  // ejemplo, dos jugadores detrás del mismo router sin "hairpin NAT" o en redes móviles).
  // Si se define `window.GG_ICE_SERVERS` en js/keys.js, tendrá prioridad.
  ICE_SERVERS: (typeof window !== 'undefined' && Array.isArray(window.GG_ICE_SERVERS) && window.GG_ICE_SERVERS.length > 0)
    ? window.GG_ICE_SERVERS
    : [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Plantilla para TURN propio (coturn). Rellena con tu dominio o IP pública y credenciales:
        // {
        //   urls: [
        //     'turn:tu-servidor-coturn.com:3478?transport=udp',
        //     'turn:tu-servidor-coturn.com:3478?transport=tcp',
        //     'turns:tu-servidor-coturn.com:5349?transport=tcp',
        //   ],
        //   username: 'ggtlalte_user',
        //   credential: 'tu_password_seguro',
        // },
      ],

  // Caracteres y longitud del código de sala compartible.
  CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  CODE_LENGTH: 4,

  // --- Reglas de juego -------------------------------------------------------
  MAX_HP: 5000,             // Vida inicial de cada jugador.
  BASE_SCORE: 5000,         // Puntos máximos por ronda.
  SCORE_DISTANCE: 1.2,      // Constante de decaimiento para escala urbana/local (km).
  PERFECT_DISTANCE: 0.025,  // Distancia (km) considerada "perfecta" (25 m).
  MIN_LOCATION_SEPARATION_KM: 0.161, // Distancia mínima (km) entre TODOS los panos de la partida (161 m).

  SOLO_ROUNDS: 5,           // Rondas por defecto en modo solitario.
  DUEL_ROUNDS: 5,           // Rondas por defecto en multijugador.
  ROUND_DURATION: 60,       // Segundos por ronda (límite principal).
  OPPONENT_COUNTDOWN: 15,   // Segundos extra para el rival tras adivinar.

  // Modo solitario: nº de rondas y tiempo MÁXIMO para TODA la partida.
  SOLO_MODES: {
    5: { label: '5 rondas', rounds: 5, totalSeconds: 105 },
    7: { label: '7 rondas', rounds: 7, totalSeconds: 120 },
    10: { label: '10 rondas', rounds: 10, totalSeconds: 150 },
    15: { label: '15 rondas', rounds: 15, totalSeconds: 210 },
  },
  SOLO_BONUS_SECONDS_ZOOM_BLUR: 60, // +1 minuto para variantes zoom y borroso en solitario

  // Modo multijugador: nº de rondas disponibles y tamaño de sala.
  MULTI_ROUND_OPTIONS: [5, 7, 10, 15],
  ROOM_MAX_PLAYERS: 25,     // Tamaño máximo permitido de sala (hasta 25 jugadores).
  ROOM_MIN_PLAYERS: 2,      // Mínimo para iniciar partida.
  RESULT_DURATION: 9000,    // ms que se muestra el resumen de ronda.
  PREPARE_DURATION: 3,      // Segundos de "prepárate" antes de adivinar (duelo).
  NO_GUESS_BASE_PENALTY: 100, // Ronda 1: 100 pts
  NO_GUESS_STEP_PENALTY: 50,  // +50 pts cada ronda subsiguiente (150, 200, 250...)

  // Modos de juego principales
  GAME_MODES: {
    normal: { id: 'normal', name: 'Normal', desc: 'Mueve la vista 360° y haz zoom libremente.' },
    static: { id: 'static', name: 'Estático', desc: 'Vista fija: no puedes girar ni mover la cámara.' },
    temporal: { id: 'temporal', name: 'Temporal', desc: 'La imagen se oculta tras x segundos y se abre el minimapa.' },
  },
  // Variantes con Zoom Progresivo (Visión Túnel)
  GAME_VARIANTS: {
    normal_standard: { desc: 'Mueve la vista 360° y haz zoom libremente.' },
    normal_zoom: { desc: 'Giro 360° con visión inicial ultra-telescópica que se aleja con el tiempo. ¡Hasta 6,500 pts en zoom máximo!' },
    normal_blur: { desc: 'Giro 360° sin zoom manual. Inicia 100% borroso y se enfoca 20% en 5 fases. ¡Haz Perfect para curar HP y acumular rachas!' },
    static_standard: { desc: 'Cámara fija, sin rotación ni movimiento. Desafío puro de reconocimiento visual.' },
    static_zoom: { desc: 'Cámara fija con zoom ultra-telescópico inicial que se aleja con el tiempo. ¡Identifica el lugar antes de que retroceda!' },
    static_blur: { desc: 'Cámara fija sin rotación ni zoom. Inicia 100% borroso y se enfoca 20% en 5 fases. ¡Haz Perfect para curar HP y acumular rachas!' },
  },
  TEMPORAL_DURATIONS: [1, 2, 3, 5, 10],
  DEFAULT_TEMPORAL_SECONDS: 3,
  TUNNEL_DURATIONS: [2, 3, 5, 8, 10, 15],
  DEFAULT_TUNNEL_SECONDS: 3,
  TUNNEL_ZOOM_LEVELS: [4.2, 2.8, 1.4, 0.0],
  TUNNEL_MAX_SCORES: [5000, 5250, 5750, 6500],
  TUNNEL_DECAY_DISTANCES: [1.2, 1.4, 1.7, 2.1],

  // Modo Borroso Progresivo (Desenfocado)
  BLUR_DURATIONS: [2, 3, 5, 8, 10, 15],
  DEFAULT_BLUR_SECONDS: 3,
  BLUR_STEPS: 5,
  // Desenfocado en px: Fase 1 (100%), Fase 2 (80%), Fase 3 (60%), Fase 4 (40%), Fase 5 (20%), Final (0% nítido)
  BLUR_LEVELS: [24, 16, 10, 5.5, 2.5, 0],
  // Puntos máximos por adivinar en cada fase (Fase 1 al 100% otorga hasta 7,000 pts)
  BLUR_MAX_SCORES: [7000, 6400, 5900, 5500, 5200, 5000],
  BLUR_DECAY_DISTANCES: [2.2, 1.9, 1.6, 1.4, 1.3, 1.2],
  // Curación base en HP al lograr Perfect (<= 25m) en cada fase
  BLUR_BASE_HEALS: [1600, 1200, 900, 600, 300, 150],

  // 25 colores únicos y contrastantes para hasta 25 jugadores simultáneos
  PLAYER_COLORS: [
    '#38bdf8', // 1: Celeste brillante
    '#f87171', // 2: Rojo coral
    '#34d399', // 3: Verde esmeralda
    '#fbbf24', // 4: Ámbar / Oro
    '#a78bfa', // 5: Violeta pastel
    '#f472b6', // 6: Rosa fuerte
    '#2dd4bf', // 7: Turquesa
    '#fb923c', // 8: Naranja neón
    '#a3e635', // 9: Lima brillante
    '#818cf8', // 10: Índigo luminoso
    '#e879f9', // 11: Fucsia / Orquídea
    '#facc15', // 12: Amarillo intenso
    '#06b6d4', // 13: Cian
    '#ec4899', // 14: Magenta
    '#10b981', // 15: Menta
    '#f59e0b', // 16: Mandarina
    '#8b5cf6', // 17: Púrpura eléctrico
    '#14b8a6', // 18: Aqua
    '#ef4444', // 19: Rojo fuego
    '#84cc16', // 20: Verde cítrico
    '#6366f1', // 21: Azul eléctrico
    '#d946ef', // 22: Orquídea neón
    '#0ea5e9', // 23: Azul cielo
    '#f97316', // 24: Naranja fuego
    '#22c55e', // 25: Verde vivo
  ],

  // --- Mapa (Leaflet) --------------------------------------------------------
  TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  SATELLITE_TILE_URL: 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
  SATELLITE_SUBDOMAINS: ['mt0', 'mt1', 'mt2', 'mt3'],
  SATELLITE_ATTRIBUTION: '&copy; Google Maps',
  MAP_DEFAULT_CENTER: [21.7809, -103.3055],
  MAP_DEFAULT_ZOOM: 13,
};

/**
 * Penalización progresiva si el jugador no adivina:
 * Ronda 1: 100 pts, Ronda 2: 150 pts, Ronda 3: 200 pts, Ronda 4: 250 pts, etc.
 */
export function getNoGuessPenalty(round) {
  const r = Math.max(1, parseInt(round) || 1);
  return 100 + (r - 1) * 50;
}

/**
 * Multiplicador de daño según la ronda (sistema de duelo).
 * Ronda 1-2: x1.0 · Ronda 3: x1.5 · Ronda 4: x2.0 · Ronda 5-9: x3.0 · Ronda 10-14: x3.5 · Ronda 15+: x4.0
 */
export function damageMultiplier(round) {
  const r = Math.max(1, parseInt(round) || 1);
  if (r <= 2) return 1.0;
  if (r === 3) return 1.5;
  if (r === 4) return 2.0;
  if (r >= 5 && r <= 9) return 3.0;
  if (r >= 10 && r <= 14) return 3.5;
  return 4.0;
}

