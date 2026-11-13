/**
 * GG-TLALTE — Reloj común sincronizado con el servidor.
 *
 * Cada dispositivo estima la diferencia entre su reloj y el del servidor (estilo NTP):
 * se mide varias veces la hora del servidor y se queda con la muestra de menor latencia,
 * cuyo error máximo es la mitad de su tiempo de ida y vuelta. Con eso, todos los jugadores
 * comparten la misma línea de tiempo y pueden revelar la imagen en el mismo instante,
 * sin importar cuánto tarde en llegarles cada mensaje.
 */
const API_URL = 'api.php';

let offset = 0;          // horaServidor - horaLocal (ms)
let bestRtt = Infinity;  // ida y vuelta de la mejor muestra
let synced = false;
let running = null;

async function sample() {
  const t0 = Date.now();
  const res = await fetch(`${API_URL}?action=time&_t=${t0}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: '{"action":"time"}',
  });
  const data = await res.json();
  const t1 = Date.now();
  if (!data || !data.ok || typeof data.t !== 'number') return;
  const rtt = t1 - t0;
  if (rtt < 0 || rtt > 10000) return;
  if (rtt < bestRtt) {
    bestRtt = rtt;
    offset = data.t - (t0 + t1) / 2;
    synced = true;
  }
}

/**
 * Sincroniza el reloj. `samples` mediciones; `fresh` descarta la sincronización anterior.
 * Nunca lanza error: si el servidor no responde, se usa el reloj del dispositivo.
 */
export function syncClock(samples = 5, fresh = false) {
  if (running) return running;
  if (fresh) {
    bestRtt = Infinity;
  }
  running = (async () => {
    for (let i = 0; i < samples; i++) {
      try { await sample(); } catch (e) { /* sin conexión: se reintenta en la siguiente ronda */ }
    }
    running = null;
    return synced;
  })();
  return running;
}

/** Hora actual en la línea de tiempo del servidor (ms). */
export const serverNow = () => Date.now() + offset;

export const isClockSynced = () => synced;

/** Precisión estimada (ms): la mitad del mejor tiempo de ida y vuelta. */
export const clockError = () => (synced ? Math.round(bestRtt / 2) : null);

/**
 * Convierte una hora absoluta del servidor en milisegundos de espera locales.
 * Si alguno de los dos relojes no está sincronizado usa `fallbackMs` (tiempo relativo).
 * El resultado se limita a [0, maxMs] para que un reloj desajustado nunca congele la partida.
 */
export function msUntil(serverTime, remoteSynced, fallbackMs, maxMs) {
  let ms;
  if (serverTime && remoteSynced && synced) ms = serverTime - serverNow();
  else ms = fallbackMs;
  if (!Number.isFinite(ms)) ms = fallbackMs || 0;
  return Math.max(0, Math.min(ms, maxMs));
}
