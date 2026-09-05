// ============================================================================
// utils.js — Utilidades puras: matemáticas geográficas, puntuación, RNG, DOM.
// ============================================================================

import { CONFIG, damageMultiplier } from './config.js?v=1.7.7';

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

/**
 * Curva de puntuación para el Modo Zoom Progresivo (Visión Túnel).
 * Si se adivina con zoom máximo (paso 4) y muy cerca (<= 25m), otorga bonificación
 * que supera los 5,000 pts (hasta 6,500 pts).
 * A mayor distancia resta puntos progresivamente, pero con menor penalización
 * a quien arriesgó con zoom alto respecto a quien esperó a la vista normal.
 * @param {number} distanceKm Distancia de la conjetura en km.
 * @param {number} zoomStep Nivel de zoom en el momento del guess (1 a 4).
 */
export function scoreForDistanceTunnel(distanceKm, zoomStep = 1) {
  const step = clamp(Math.round(zoomStep || 1), 1, 4);
  const maxScores = CONFIG.TUNNEL_MAX_SCORES || [5000, 5250, 5750, 6500];
  const decayDistances = CONFIG.TUNNEL_DECAY_DISTANCES || [1.2, 1.4, 1.7, 2.1];

  const maxScore = maxScores[step - 1] || CONFIG.BASE_SCORE;
  const decayKm = decayDistances[step - 1] || CONFIG.SCORE_DISTANCE;

  if (distanceKm <= CONFIG.PERFECT_DISTANCE) {
    return maxScore;
  }
  const raw = maxScore * Math.exp(-distanceKm / decayKm);
  return clamp(Math.floor(raw), 0, maxScore);
}

/**
 * Curva de puntuación para el Modo Borroso (Desenfocado Progresivo).
 * Si se adivina en la Fase 1 (100% borroso) a <= 25m (Perfect), otorga hasta 7,000 pts.
 * En fases posteriores (80%, 60%, 40%, 20%, 0%) otorga puntuación escalada.
 * Si excede los 25m decae exponencialmente según la distancia.
 * @param {number} distanceKm Distancia de la conjetura en km.
 * @param {number} blurPhase Fase de desenfoque (1 = 100%, 2 = 80%, 3 = 60%, 4 = 40%, 5 = 20%, 0 = nítido).
 */
export function scoreForDistanceBlur(distanceKm, blurPhase = 1) {
  const maxScores = CONFIG.BLUR_MAX_SCORES || [7000, 6400, 5900, 5500, 5200, 5000];
  const decayDistances = CONFIG.BLUR_DECAY_DISTANCES || [2.2, 1.9, 1.6, 1.4, 1.3, 1.2];

  let idx = 5; // Por defecto nítido (5,000 pts)
  if (blurPhase >= 1 && blurPhase <= 5) {
    idx = blurPhase - 1;
  } else if (blurPhase === 0) {
    idx = 5;
  }

  const maxScore = maxScores[idx] || CONFIG.BASE_SCORE;
  const decayKm = decayDistances[idx] || CONFIG.SCORE_DISTANCE;

  if (distanceKm <= CONFIG.PERFECT_DISTANCE) {
    return maxScore;
  }
  const raw = maxScore * Math.exp(-distanceKm / decayKm);
  return clamp(Math.floor(raw), 0, maxScore);
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
 * Devuelve n índices únicos donde CADA ubicación dista al menos
 * minDistanceKm (por defecto 161 metros = 0.161 km) de TODAS las demás ubicaciones
 * ya seleccionadas en la partida (no solo de la inmediatamente anterior).
 * Evita que se repitan zonas o calles cercanas a lo largo de las 5, 7, 10 o 15 rondas.
 */
export function pickSeparatedIndices(coordenadas, count, minDistanceKm = 0.161, rng = Math.random) {
  if (!Array.isArray(coordenadas) || coordenadas.length === 0) return [];
  const total = coordenadas.length;
  if (count >= total) {
    return pickIndices(total, count, rng);
  }

  // Intentos para encontrar una combinación donde el 100% de los pares disten >= minDistanceKm
  for (let attempt = 0; attempt < 10; attempt++) {
    const selected = [];
    const used = new Set();

    const first = Math.floor(rng() * total);
    selected.push(first);
    used.add(first);

    let completed = true;
    for (let i = 1; i < count; i++) {
      const candidates = [];
      for (let idx = 0; idx < total; idx++) {
        if (used.has(idx)) continue;
        const c = coordenadas[idx];
        let valid = true;
        for (let s = 0; s < selected.length; s++) {
          const selCoord = coordenadas[selected[s]];
          if (haversineKm(selCoord.lat, selCoord.lng, c.lat, c.lng) < minDistanceKm) {
            valid = false;
            break;
          }
        }
        if (valid) {
          candidates.push(idx);
        }
      }

      if (candidates.length === 0) {
        completed = false;
        break;
      }

      const nextIdx = candidates[Math.floor(rng() * candidates.length)];
      selected.push(nextIdx);
      used.add(nextIdx);
    }

    if (completed && selected.length === count) {
      return selected;
    }
  }

  // Fallback de máxima dispersión (si el catálogo es muy reducido o denso):
  // Selección voraz maximizando la distancia mínima respecto a todos los ya elegidos
  const selected = [];
  const used = new Set();
  const first = Math.floor(rng() * total);
  selected.push(first);
  used.add(first);

  while (selected.length < count) {
    let bestIdx = -1;
    let maxMinDist = -1;
    for (let idx = 0; idx < total; idx++) {
      if (used.has(idx)) continue;
      const c = coordenadas[idx];
      let minDist = Infinity;
      for (let s = 0; s < selected.length; s++) {
        const selCoord = coordenadas[selected[s]];
        const d = haversineKm(selCoord.lat, selCoord.lng, c.lat, c.lng);
        if (d < minDist) minDist = d;
      }
      if (minDist > maxMinDist) {
        maxMinDist = minDist;
        bestIdx = idx;
      }
    }
    if (bestIdx === -1) break;
    selected.push(bestIdx);
    used.add(bestIdx);
  }

  return selected;
}

/**
 * Interpola puntos a lo largo de una línea geodésica (círculo máximo) entre
 * dos coordenadas. Útil para dibujar polilíneas curvas reales en el mapa.
 */
export function greatCirclePoints(lat1, lon1, lat2, lon2, segments = 64) {
  const toDeg = (r) => (r * 180) / Math.PI;
  const phi1 = toRad(lat1);
  const lambda1 = toRad(lon1);
  const phi2 = toRad(lat2);
  const lambda2 = toRad(lon2);

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((phi2 - phi1) / 2) ** 2 +
          Math.cos(phi1) * Math.cos(phi2) * Math.sin((lambda2 - lambda1) / 2) ** 2
      )
    );

  const points = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    let phi, lambda;
    if (d < 1e-9) {
      // Distancia casi nula: interpolación lineal.
      phi = phi1 + (phi2 - phi1) * f;
      lambda = lambda1 + (lambda2 - lambda1) * f;
    } else {
      const A = Math.sin((1 - f) * d) / Math.sin(d);
      const B = Math.sin(f * d) / Math.sin(d);
      const x =
        A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
      const y =
        A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
      const z = A * Math.sin(phi1) + B * Math.sin(phi2);
      phi = Math.atan2(z, Math.sqrt(x * x + y * y));
      lambda = Math.atan2(y, x);
    }
    points.push([toDeg(phi), toDeg(lambda)]);
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
