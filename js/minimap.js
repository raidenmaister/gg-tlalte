// ============================================================================
// minimap.js — Minimapa interactivo Leaflet para adivinar y revelar.
// ============================================================================

import { CONFIG } from './config.js?v=1.7.7';
import { greatCirclePoints } from './utils.js?v=1.7.7';

const MARKER = {
  real: { color: '#f59e0b', size: 42, label: '📍 Ubicación real' },
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

function makePinIcon({ color, size }) {
  const tipY = size * 1.2071;
  return L.divIcon({
    className: 'gg-pin',
    html: `<div class="gg-pin__pin" style="--pin-color:${color}; width:${size}px; height:${size}px;"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, tipY],
    popupAnchor: [0, -tipY + 4],
  });
}

function makePin({ lat, lng, color, size, label }) {
  const icon = makePinIcon({ color, size });
  return L.marker([lat, lng], { icon }).bindPopup(label);
}

/** Pin de la ubicación real con etiqueta visible para distinguirlo, color dorado y mayor tamaño. */
function makeRealPin({ lat, lng, color, size, label }) {
  const tipY = size * 1.2071;
  const labelH = 24;
  const icon = L.divIcon({
    className: 'gg-player-pin gg-real-pin',
    html: `<div class="gg-player-pin__label gg-real-pin__label">${escapeHtml(label)}</div>
      <div class="gg-pin__pin" style="--pin-color:${color}; width:${size}px; height:${size}px;"></div>`,
    iconSize: [size, tipY + labelH],
    iconAnchor: [size / 2, tipY + labelH],
  });
  return L.marker([lat, lng], { icon, interactive: false, zIndexOffset: 1000 });
}

/** Pin de jugador con el nombre y puntos perdidos siempre visibles encima de la chincheta. */
function makePlayerPin({ lat, lng, color, size, label, damage }) {
  const tipY = size * 1.2071;
  const labelH = 28;
  const hasDamage = typeof damage === 'number';
  const dmgBadge = hasDamage
    ? (damage > 0
        ? `<span class="gg-player-pin__dmg hit">-${damage} pts</span>`
        : `<span class="gg-player-pin__dmg safe">⭐ 0 pts</span>`)
    : '';

  const icon = L.divIcon({
    className: 'gg-player-pin',
    html: `<div class="gg-player-pin__label" style="--pin-color:${color}; border-color:${color}; color:${color};">
        <span class="gg-player-pin__name">${escapeHtml(label)}</span>
        ${dmgBadge}
      </div>
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
    this.interactive = true;   // por defecto interactivo durante el juego
    this.myColor = null;       // Color asignado al jugador en la partida
    this.streetLayer = null;
    this.satelliteLayer = null;
    this.currentLayerType = 'streets';
  }

  setMyColor(color) {
    this.myColor = color;
  }

  init() {
    if (typeof L === 'undefined') {
      throw new Error('Leaflet no está disponible. Revisa la carga del CDN.');
    }
    const el = document.getElementById(this.containerId);
    // Bounding box de Tlaltenango y alrededores para evitar que el mapa se aleje o se pierda
    const TLALTE_BOUNDS = L.latLngBounds(
      [21.65, -103.45], // Sur-Oeste
      [21.90, -103.15]  // Nor-Este
    );

    this.map = L.map(el, {
      center: CONFIG.MAP_DEFAULT_CENTER,
      zoom: CONFIG.MAP_DEFAULT_ZOOM,
      zoomControl: true,
      attributionControl: true,
      worldCopyJump: false,
      minZoom: 12,
      maxZoom: 19,
      maxBounds: TLALTE_BOUNDS,
      maxBoundsViscosity: 0.85,
    });

    this.streetLayer = L.tileLayer(CONFIG.TILE_URL, {
      attribution: CONFIG.TILE_ATTRIBUTION,
      maxZoom: 19,
      subdomains: 'abc',
    });

    this.satelliteLayer = L.tileLayer(CONFIG.SATELLITE_TILE_URL, {
      attribution: CONFIG.SATELLITE_ATTRIBUTION,
      maxZoom: 20,
      subdomains: CONFIG.SATELLITE_SUBDOMAINS,
    });

    let savedLayer = 'streets';
    try {
      savedLayer = localStorage.getItem('gg_map_layer') || 'streets';
    } catch (e) {}
    this.currentLayerType = savedLayer === 'satellite' ? 'satellite' : 'streets';

    if (this.currentLayerType === 'satellite') {
      this.satelliteLayer.addTo(this.map);
    } else {
      this.streetLayer.addTo(this.map);
    }

    this.revealLayer = L.featureGroup().addTo(this.map);

    this.map.on('click', (e) => {
      if (this.interactive === false) return;
      const wrap = this.map.getContainer().closest('.minimap-wrap');
      if (wrap && wrap.classList.contains('fullscreen')) return;
      const { lat, lng } = e.latlng;
      this.setPick(lat, lng);
      if (this.callbacks.onPick) this.callbacks.onPick(lat, lng);
    });

    if (this.callbacks.onReady) this.callbacks.onReady();
    return this.map;
  }

  /** Activa/desactiva la recogida de clics (modo adivinar). */
  setInteractive(active) {
    const wrap = this.map && this.map.getContainer() ? this.map.getContainer().closest('.minimap-wrap') : null;
    const isFullscreen = wrap && wrap.classList.contains('fullscreen');
    this.interactive = active !== false && !isFullscreen;
    if (this.map && this.map.getContainer()) {
      this.map.getContainer().style.cursor = this.interactive ? 'crosshair' : 'grab';
    }
  }

  /** Conmuta entre capa estándar (OpenStreetMap) y capa satelital (Google Hybrid). */
  toggleLayer() {
    if (!this.map || !this.streetLayer || !this.satelliteLayer) return this.currentLayerType;
    if (this.currentLayerType === 'streets') {
      this.map.removeLayer(this.streetLayer);
      this.satelliteLayer.addTo(this.map);
      this.currentLayerType = 'satellite';
    } else {
      this.map.removeLayer(this.satelliteLayer);
      this.streetLayer.addTo(this.map);
      this.currentLayerType = 'streets';
    }
    try {
      localStorage.setItem('gg_map_layer', this.currentLayerType);
    } catch (e) {}

    // Asegurar que la capa de chinchetas y líneas geodésicas quede visible encima
    if (this.revealLayer && this.map.hasLayer(this.revealLayer)) {
      if (typeof this.revealLayer.bringToFront === 'function') {
        this.revealLayer.bringToFront();
      } else if (typeof this.revealLayer.eachLayer === 'function') {
        this.revealLayer.eachLayer((l) => {
          if (l && typeof l.bringToFront === 'function') l.bringToFront();
        });
      }
    }
    if (this.pickMarker && typeof this.pickMarker.bringToFront === 'function') {
      this.pickMarker.bringToFront();
    }

    return this.currentLayerType;
  }

  /** Recentra la vista del mapa en el centro urbano de Tlaltenango. */
  recenter() {
    if (!this.map) return;
    this.map.setView(CONFIG.MAP_DEFAULT_CENTER, CONFIG.MAP_DEFAULT_ZOOM, {
      animate: true,
    });
  }

  /** Coloca (o mueve) el marcador del jugador con su color real. */
  setPick(lat, lng) {
    if (this.interactive === false) return;
    const wrap = this.map && this.map.getContainer() ? this.map.getContainer().closest('.minimap-wrap') : null;
    if (wrap && wrap.classList.contains('fullscreen')) return;
    this.pick = { lat, lng };
    const pinColor = this.myColor || MARKER.mine.color;
    if (!this.pickMarker) {
      this.pickMarker = makePin({
        lat,
        lng,
        color: pinColor,
        size: MARKER.mine.size,
        label: MARKER.mine.label,
      }).addTo(this.map);
    } else {
      this.pickMarker.setLatLng([lat, lng]);
      if (this.pickMarker.setIcon) {
        this.pickMarker.setIcon(makePinIcon({ color: pinColor, size: MARKER.mine.size }));
      }
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

    const realLat = real ? Number(real.lat) : NaN;
    const realLng = real ? Number(real.lng) : NaN;
    const hasReal = !isNaN(realLat) && !isNaN(realLng);

    if (hasReal) {
      this.revealLayer.addLayer(
        makeRealPin({ lat: realLat, lng: realLng, ...MARKER.real })
      );
      bounds.push([realLat, realLng]);
    }

    (players || []).forEach((p, i) => {
      if (!p.guess) return;
      const lat = Number(p.guess.lat);
      const lng = Number(p.guess.lng);
      if (isNaN(lat) || isNaN(lng)) return;

      const color = colors[i % colors.length];
      this.revealLayer.addLayer(
        makePlayerPin({
          lat,
          lng,
          color,
          size: 30,
          label: p.name,
          damage: p.damage,
        })
      );
      bounds.push([lat, lng]);
      if (hasReal) {
        const pts = greatCirclePoints(realLat, realLng, lat, lng, 96);
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
      if (bounds.length === 1) {
        this.map.setView(bounds[0], 14, { animate: false });
        return;
      }
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
    const wrap = this.map.getContainer().closest('.minimap-wrap');
    if (wrap) wrap.classList.toggle('fullscreen', active);
    if (active) {
      this.setInteractive(false);
      this.interactive = false;
      if (this.map.dragging) this.map.dragging.enable();
      if (this.map.touchZoom) this.map.touchZoom.enable();
      if (this.map.doubleClickZoom) this.map.doubleClickZoom.enable();
      if (this.map.scrollWheelZoom) this.map.scrollWheelZoom.enable();
      if (this.map.boxZoom) this.map.boxZoom.enable();
      if (this.map.keyboard) this.map.keyboard.enable();
      requestAnimationFrame(() => this.refreshSize());
    }
  }
}
