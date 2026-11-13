// ============================================================================
// secure.js — Identidad del jugador y API de partidas validadas por el servidor.
//
// Cada dispositivo genera una clave secreta aleatoria ligada a su nombre. El
// servidor elige las ubicaciones, calcula los puntos y mide el tiempo: el
// navegador sólo envía la chincheta.
// ============================================================================

const API_URL = 'api.php';
const KEY_STORAGE = 'ggtlalte:playerKey';

function randomKey() {
  const bytes = new Uint8Array(24);
  (window.crypto || window.msCrypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const identity = {
  name: '',
  get key() {
    let k = null;
    try {
      k = localStorage.getItem(KEY_STORAGE);
    } catch (e) {}
    if (!k || !/^[a-f0-9]{32,64}$/.test(k)) {
      k = randomKey();
      try {
        localStorage.setItem(KEY_STORAGE, k);
      } catch (e) {}
    }
    return k;
  },
  resetKey() {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch (e) {}
  },
};

export async function apiCall(action, body = {}, { retries = 0 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${API_URL}?action=${encodeURIComponent(action)}&_t=${Date.now()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json && typeof json === 'object') return json;
      lastErr = new Error('Respuesta inválida del servidor');
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  return { ok: false, error: (lastErr && lastErr.message) || 'Sin conexión con el servidor', network: true };
}

function auth() {
  return { name: identity.name, key: identity.key };
}

export const secureApi = {
  login: () => apiCall('login', auth(), { retries: 1 }),
  siteInfo: () => apiCall('site-info', {}, { retries: 1 }),

  // Cuenta y perfil
  accountInfo: () => apiCall('account-info', auth()),
  setPassword: (password) => apiCall('account-set-password', { ...auth(), password }),
  recoveryCode: () => apiCall('account-recovery-code', auth()),
  logoutOthers: () => apiCall('account-logout-others', auth()),
  /** Inicia sesión en otro dispositivo: el servidor autoriza la clave nueva de este navegador. */
  accountLogin: async (name, { password = '', code = '' } = {}) => {
    // La clave nueva sólo se guarda si el servidor acepta el inicio de sesión.
    const key = randomKey();
    const res = await apiCall('account-login', { name, password, code, key });
    if (res && res.ok) {
      try {
        localStorage.setItem(KEY_STORAGE, key);
      } catch (e) {}
    }
    return res;
  },
  profile: (name) => apiCall('profile', { name }, { retries: 1 }),
  recordMulti: (result) => apiCall('profile-record-multi', { ...auth(), ...result }),

  // Reto diario
  dailyInfo: () => apiCall('daily-info', { name: identity.name }, { retries: 1 }),
  dailyLeaderboard: (date) => apiCall('daily-leaderboard', { date }, { retries: 1 }),
  register: (name) => apiCall('register-name', { name, key: identity.key }),

  soloStart: (opts) => apiCall('solo-start', { ...auth(), ...opts }, { retries: opts && opts.daily ? 0 : 1 }),
  soloRound: (token, round) => apiCall('solo-round', { token, round }, { retries: 2 }),
  soloGuess: (token, round, guess) => apiCall('solo-guess', {
    token,
    round,
    lat: guess ? guess.lat : null,
    lng: guess ? guess.lng : null,
    zoomStep: guess && guess.zoomStep != null ? guess.zoomStep : 1,
    blurPhase: guess && guess.blurPhase != null ? guess.blurPhase : 0,
  }, { retries: 3 }),
  soloFinish: (token, clientTimeMs) => apiCall('solo-finish', { token, clientTimeMs }, { retries: 2 }),

  roomSatStart: (rounds, players, sat = {}) => apiCall('room-sat-start', { ...auth(), rounds, players, satZoom: sat.zoom, satSource: sat.src, satCity: sat.city }, { retries: 1 }),
  satGuess: (token, round, guess) => apiCall('sat-guess', { ...auth(), token, round, lat: guess.lat, lng: guess.lng }, { retries: 2 }),
  satReveal: (token, round) => apiCall('sat-reveal', { ...auth(), token, round }, { retries: 4 }),

  satImageUrl: (token, round) => `${API_URL}?action=sat-image&t=${encodeURIComponent(token)}&r=${round}`,
};
