// ============================================================================
// utils.js — Utilidades puras: matemáticas geográficas, puntuación, RNG, DOM.
// ============================================================================

import { CONFIG, damageMultiplier } from './config.js?v=1.5.2';

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

/** Sanitiza cadenas para inserción segura en HTML. */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
 * Devuelve n índices únicos donde cada ubicación consecutiva dista al menos
 * minDistanceKm (por defecto 161 metros = 0.161 km) de la anterior.
 */
export function pickSeparatedIndices(coordenadas, count, minDistanceKm = 0.161, rng = Math.random) {
  if (!Array.isArray(coordenadas) || coordenadas.length === 0) return [];
  const total = coordenadas.length;
  if (count >= total) {
    return pickIndices(total, count, rng);
  }

  const selected = [];
  const used = new Set();

  let currentIdx = Math.floor(rng() * total);
  selected.push(currentIdx);
  used.add(currentIdx);

  for (let i = 1; i < count; i++) {
    const prev = coordenadas[currentIdx];
    const candidates = [];
    for (let idx = 0; idx < total; idx++) {
      if (used.has(idx)) continue;
      const c = coordenadas[idx];
      const dist = haversineKm(prev.lat, prev.lng, c.lat, c.lng);
      if (dist >= minDistanceKm) {
        candidates.push(idx);
      }
    }

    let nextIdx;
    if (candidates.length > 0) {
      nextIdx = candidates[Math.floor(rng() * candidates.length)];
    } else {
      // Fallback: si no hay candidatos a >= 161m, toma cualquiera no usado
      const remaining = [];
      for (let idx = 0; idx < total; idx++) {
        if (!used.has(idx)) remaining.push(idx);
      }
      if (remaining.length === 0) break;
      nextIdx = remaining[Math.floor(rng() * remaining.length)];
    }

    currentIdx = nextIdx;
    selected.push(currentIdx);
    used.add(currentIdx);
  }

  return selected;
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

/**
 * Detecta si el dispositivo del usuario tiene hardware de recursos limitados ("PC ultra patata")
 * analizando núcleos de CPU, memoria de dispositivo y renderer WebGL.
 * @returns {boolean}
 */
export function detectPotatoMode() {
  let isPotato = false;
  try {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4;
    let isLowEndGpu = false;

    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();
        if (
          renderer.includes('intel') ||
          renderer.includes('hd graphics') ||
          renderer.includes('uhd graphics') ||
          renderer.includes('swiftshader') ||
          renderer.includes('basic render') ||
          renderer.includes('llvmpipe') ||
          renderer.includes('mesa') ||
          renderer.includes('mali') ||
          renderer.includes('adreno')
        ) {
          isLowEndGpu = true;
        }
      }
    }

    if (cores <= 4 || memory <= 4 || isLowEndGpu) {
      isPotato = true;
    }
  } catch (e) {}

  if (typeof document !== 'undefined' && document.body) {
    if (isPotato) {
      document.body.classList.add('is-potato');
    }
  }

  return isPotato;
}
