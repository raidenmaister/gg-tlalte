// ============================================================================
// utils.js — Utilidades puras: matemáticas geográficas, puntuación, RNG, DOM.
// ============================================================================

import { CONFIG, damageMultiplier } from './config.js';

/** Selector corto para querySelector. */
export function $(sel, root = document) {
  return root.querySelector(sel);
}

/** Selector corto para querySelectorAll (devuelve Array). */
export function $$(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

/** Redondea/limita un número entre min y max. */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** Convierte grados a radianes. */
const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Fórmula de Haversine. Devuelve la distancia en kilómetros entre dos puntos.
 *   d = 2r·arcsin( sqrt( sin²(Δφ/2) + cos(φ1)·cos(φ2)·sin²(Δλ/2) ) )
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // radio medio de la Tierra (km)
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Curva de puntuación tipo GeoGuessr.
 *   Puntos = floor( 5000 · e^(-distancia_km / 2000) )
 * Entre 0 y 25 m se considera perfecto (5000 pts).
 */
export function scoreForDistance(distanceKm) {
  if (distanceKm <= CONFIG.PERFECT_DISTANCE) return CONFIG.BASE_SCORE;
  const raw = CONFIG.BASE_SCORE * Math.exp(-distanceKm / CONFIG.SCORE_DISTANCE);
  return clamp(Math.floor(raw), 0, CONFIG.BASE_SCORE);
}

/** Daño infligido por la diferencia de puntos multiplicada por el multiplicador. */
export function computeDamage(winnerScore, loserScore, round) {
  const diff = Math.max(0, winnerScore - loserScore);
  return Math.round(diff * damageMultiplier(round));
}

/** Generador pseudoaleatorio determinista (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Baraja un array con un RNG dado (copia, no muta el original). */
export function shuffle(array, rng = Math.random) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Devuelve n índices únicos dentro de [0, length). */
export function pickIndices(length, count, rng = Math.random) {
  const idx = Array.from({ length }, (_, i) => i);
  return shuffle(idx, rng).slice(0, count);
}

/**
 * Interpola puntos a lo largo de una línea geodésica (círculo máximo) entre
 * dos coordenadas. Útil para dibujar polilíneas curvas reales en el mapa.
 */
export function greatCirclePoints(lat1, lon1, lat2, lon2, segments = 64) {
  const toDeg = (r) => (r * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const λ1 = toRad(lon1);
  const φ2 = toRad(lat2);
  const λ2 = toRad(lon2);

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((φ2 - φ1) / 2) ** 2 +
          Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
      )
    );

  const points = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    let φ, λ;
    if (d < 1e-9) {
      // Distancia casi nula: interpolación lineal.
      φ = φ1 + (φ2 - φ1) * f;
      λ = λ1 + (λ2 - λ1) * f;
    } else {
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x =
        A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
      const y =
        A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
      const z = A * Math.sin(φ1) + B * Math.sin(φ2);
      φ = Math.atan2(z, Math.sqrt(x * x + y * y));
      λ = Math.atan2(y, x);
    }
    points.push([toDeg(φ), toDeg(λ)]);
  }
  return points;
}

/** Formatea una distancia en km de forma legible. */
export function formatKm(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** Formatea un número con separador de miles. */
export function formatNumber(n) {
  return Math.round(n).toLocaleString('es-MX');
}

/** Genera un código de sala aleatorio con los caracteres permitidos. */
export function generateCode(length = CONFIG.CODE_LENGTH) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CONFIG.CODE_CHARS[Math.floor(Math.random() * CONFIG.CODE_CHARS.length)];
  }
  return code;
}
