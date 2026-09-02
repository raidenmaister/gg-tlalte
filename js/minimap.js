// ============================================================================
// minimap.js — Minimapa interactivo Leaflet para adivinar y revelar.
// ============================================================================

import { CONFIG } from './config.js';
import { greatCirclePoints } from './utils.js';

const MARKER = {
  real: { color: '#16a34a', size: 34, label: 'Ubicación real' },
  mine: { color: '#2563eb', size: 32, label: 'Tu marcador' },
  opp:  { color: '#dc2626', size: 32, label: 'Marcador del rival' },
};

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function makePin({ lat, lng, color, size, label }) {
  // La punta del pin (teardrop rotado -45°) queda a size*1.2071 del borde superior.
  const tipY = size * 1.2071;
  const icon = L.divIcon({
    className: 'gg-pin',
    html: `<div class="gg-pin__pin" style="--pin-color:${color}; width:${size}px; height:${size}px;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, tipY],
    popupAnchor: [0, -tipY + 4],
  });
  return L.marker([lat, lng], { icon }).bindPopup(label);
}

/** Pin de la ubicación real con etiqueta visible para distinguirlo. */
function makeRealPin({ lat, lng, color, size, label }) {
  const tipY = size * 1.2071;
  const labelH = 22;
  const icon = L.divIcon({
    className: 'gg-player-pin gg-real-pin',
    html: `<div class="gg-player-pin__label gg-real-pin__label">${escapeHtml(label)}</div>
      <div class="gg-pin__pin" style="--pin-color:${color}; width:${size}px; height:${size}px;"></div>`,
    iconSize: [size, tipY + labelH],
    iconAnchor: [size / 2, tipY + labelH],
  });
  return L.marker([lat, lng], { icon, interactive: false });
}

/** Pin de jugador con el nombre siempre visible encima de la chincheta. */
function makePlayerPin({ lat, lng, color, size, label }) {
  const tipY = size * 1.2071;
  const labelH = 24;
  const icon = L.divIcon({
    className: 'gg-player-pin',
    html: `<div class="gg-player-pin__label" style="--pin-color:${color}; border-color:${color}; color:${color};">${escapeHtml(label)}</div>
      <div class="gg-pin__pin" style="--pin-color:${color}; width:${size}px; height:${size}px;"></div>`,
    iconSize: [size, tipY + labelH],
    iconAnchor: [size / 2, tipY + labelH],
  });
  return L.marker([lat, lng], { icon, interactive: false });
}

export class Minimap {
  /**
   * @param {string} containerId ID del div del mapa.
   * @param {object} callbacks { onPick(lat,lng), onReady }
   */
  constructor(containerId, callbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks;
    this.map = null;
    this.pickMarker = null;
    this.revealLayer = null;
    this.pick = null;          // {lat, lng}
    this.interactive = false;  // si acepta clics para adivinar
  }

  init() {
    if (typeof L === 'undefined') {
      throw new Error('Leaflet no está disponible. Revisa la carga del CDN.');
    }
    const el = document.getElementById(this.containerId);
    this.map = L.map(el, {
      center: CONFIG.MAP_DEFAULT_CENTER,
      zoom: CONFIG.MAP_DEFAULT_ZOOM,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 11,
      maxZoom: 19,
    });

    L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      maxZoom: 19,
      subdomains: 'abc',
    }).addTo(this.map);

    this.revealLayer = L.layerGroup().addTo(this.map);

    this.map.on('click', (e) => {
      if (!this.interactive) return;
      const { lat, lng } = e.latlng;
      this.setPick(lat, lng);
      if (this.callbacks.onPick) this.callbacks.onPick(lat, lng);
    });

    if (this.callbacks.onReady) this.callbacks.onReady();
    return this.map;
  }

  /** Activa/desactiva la recogida de clics (modo adivinar). */
  setInteractive(active) {
    this.interactive = active;
    this.map.getContainer().style.cursor = active ? 'crosshair' : '';
  }

  /** Coloca (o mueve) el marcador del jugador. */
  setPick(lat, lng) {
    this.pick = { lat, lng };
    if (!this.pickMarker) {
      this.pickMarker = makePin({
        lat,
        lng,
        color: MARKER.mine.color,
        size: MARKER.mine.size,
        label: MARKER.mine.label,
      }).addTo(this.map);
    } else {
      this.pickMarker.setLatLng([lat, lng]);
    }
  }

  /** Devuelve la posición elegida o null. */
  getPick() {
    return this.pick ? { ...this.pick } : null;
  }

  /** Limpia marcadores y líneas (sin tocar el centro del mapa). */
  clear() {
    this.pick = null;
    if (this.pickMarker) {
      this.map.removeLayer(this.pickMarker);
      this.pickMarker = null;
    }
    this.revealLayer.clearLayers();
  }

  /** Prepara el mapa para una nueva ronda (limpia y restablece vista). */
  reset() {
    this.clear();
    this.map.setView(CONFIG.MAP_DEFAULT_CENTER, CONFIG.MAP_DEFAULT_ZOOM, {
      animate: false,
    });
  }

  /** Revela la respuesta multijugador: ubicación real + pin por jugador. */
  revealMulti(players, real) {
    this.clear();
    const bounds = [];
    real = real || null;
    const colors = CONFIG.PLAYER_COLORS || [
      '#38bdf8', '#f87171', '#34d399', '#fbbf24',
      '#a78bfa', '#f472b6', '#2dd4bf', '#fb923c',
      '#a3e635', '#818cf8', '#e879f9', '#facc15'
    ];

    if (real) {
      this.revealLayer.addLayer(
        makeRealPin({ lat: real.lat, lng: real.lng, ...MARKER.real })
      );
      bounds.push([real.lat, real.lng]);
    }

    (players || []).forEach((p, i) => {
      if (!p.guess) return;
      const color = colors[i % colors.length];
      this.revealLayer.addLayer(
        makePlayerPin({ lat: p.guess.lat, lng: p.guess.lng, color, size: 30, label: p.name })
      );
      bounds.push([p.guess.lat, p.guess.lng]);
      if (real) {
        const pts = greatCirclePoints(real.lat, real.lng, p.guess.lat, p.guess.lng, 96);
        this.revealLayer.addLayer(
          L.polyline(pts, { color, weight: 3, opacity: 0.9, dashArray: '6 8' })
        );
      }
    });

    if (bounds.length) this._fitBounds(bounds);
  }

  /** Revela la respuesta: ubicación real + guesses + líneas geodésicas. */
  reveal({ real, mine, opp }) {
    this.clear();
    const bounds = [];

    if (real) {
      this.revealLayer.addLayer(
        makeRealPin({ lat: real.lat, lng: real.lng, ...MARKER.real })
      );
      bounds.push([real.lat, real.lng]);
    }
    if (mine) {
      this.revealLayer.addLayer(
        makePin({ lat: mine.lat, lng: mine.lng, ...MARKER.mine })
      );
      bounds.push([mine.lat, mine.lng]);
    }
    if (opp) {
      this.revealLayer.addLayer(
        makePin({ lat: opp.lat, lng: opp.lng, ...MARKER.opp })
      );
      bounds.push([opp.lat, opp.lng]);
    }

    const drawLine = (from, to, color, dash) => {
      if (!from || !to) return;
      const pts = greatCirclePoints(from.lat, from.lng, to.lat, to.lng, 96);
      this.revealLayer.addLayer(
        L.polyline(pts, {
          color,
          weight: 3,
          opacity: 0.9,
          dashArray: dash || null,
        })
      );
    };

    if (real) {
      drawLine(real, mine, '#2563eb', '6 8');
      drawLine(real, opp, '#dc2626', '6 8');
    }

    if (bounds.length) {
      this._fitBounds(bounds);
    }
  }

  _fitBounds(bounds) {
    // Deja que el DOM asiente el tamaño final (sin transición de width/height)
    // y refresca el tamaño antes de encuadrar para evitar tiles en blanco.
    requestAnimationFrame(() => {
      if (!this.map) return;
      this.map.invalidateSize();
      this.map.fitBounds(L.latLngBounds(bounds), {
        padding: [60, 60],
        maxZoom: 16,
        animate: false,
      });
    });
  }

  /** Recalcula el tamaño tras mostrar/redimensionar el contenedor. */
  refreshSize() {
    if (this.map) this.map.invalidateSize();
  }

  /** Pone el minimapa a pantalla completa (modo revelado). */
  setFullscreen(active) {
    if (!this.map) return;
    // #minimap -> .minimap-panel -> .minimap-wrap
    const wrap = this.map.getContainer().parentElement.parentElement;
    if (wrap) wrap.classList.toggle('fullscreen', active);
    if (active) {
      requestAnimationFrame(() => this.refreshSize());
    }
  }
}
