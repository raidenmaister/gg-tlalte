// ============================================================================
// config.js — Constantes globales y reglas del juego.
// ============================================================================

export const CONFIG = {
  // Fallback opcional de API Key (cliente). La key real se define en
  // js/keys.js (window.GG_GOOGLE_MAPS_API_KEY), que se mantiene local y NO se
  // sube a GitHub. Si ambas quedan vacías, el visor la pedirá por prompt.
  GOOGLE_API_KEY: '',

  // Archivo con las ubicaciones jugables ({lat,lng,pano_id,date}).
  COORDINATES_URL: 'coordenadas_validas.json',

  // Prefijo para los IDs de PeerJS (evita colisiones en el cloud público).
  PEER_PREFIX: 'ggtlalte-v1-',

  // Caracteres y longitud del código de sala compartible.
  CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  CODE_LENGTH: 4,

  // --- Reglas de juego -------------------------------------------------------
  MAX_HP: 5000,             // Vida inicial de cada jugador.
  BASE_SCORE: 5000,         // Puntos máximos por ronda.
  SCORE_DISTANCE: 2000,     // Constante de decaimiento exponencial (km).
  PERFECT_DISTANCE: 0.025,  // Distancia (km) considerada "perfecta" (25 m).

  SOLO_ROUNDS: 5,           // Rondas por defecto en modo solitario.
  DUEL_ROUNDS: 5,           // Rondas por defecto en multijugador.
  ROUND_DURATION: 60,       // Segundos por ronda (límite principal).
  OPPONENT_COUNTDOWN: 15,   // Segundos extra para el rival tras adivinar.

  // Modo solitario: nº de rondas y tiempo MÁXIMO para TODA la partida.
  SOLO_MODES: {
    5: { label: '5 rondas', rounds: 5, totalSeconds: 105 },
    7: { label: '7 rondas', rounds: 7, totalSeconds: 120 },
    10: { label: '10 rondas', rounds: 10, totalSeconds: 150 },
  },

  // Modo multijugador: nº de rondas disponibles y tamaño de sala.
  MULTI_ROUND_OPTIONS: [5, 7, 10],
  ROOM_MAX_PLAYERS: 12,     // Tamaño máximo permitido de sala.
  ROOM_MIN_PLAYERS: 2,      // Mínimo para iniciar partida.
  RESULT_DURATION: 9000,    // ms que se muestra el resumen de ronda.
  PREPARE_DURATION: 3,      // Segundos de "prepárate" antes de adivinar (duelo).

  // --- Mapa (Leaflet) --------------------------------------------------------
  TILE_URL: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  TILE_ATTRIBUTION:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  MAP_DEFAULT_CENTER: [21.7809, -103.3055],
  MAP_DEFAULT_ZOOM: 13,
};

/**
 * Multiplicador de daño según la ronda (sistema de duelo).
 * Ronda 1-2: x1.0 · Ronda 3: x1.5 · Ronda 4: x2.0 · Ronda 5+: x3.0
 */
export function damageMultiplier(round) {
  if (round <= 2) return 1.0;
  if (round === 3) return 1.5;
  if (round === 4) return 2.0;
  return 3.0;
}
