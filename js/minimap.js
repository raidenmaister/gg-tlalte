// ============================================================================
// minimap.js — Minimapa interactivo Leaflet para adivinar y revelar.
// ============================================================================

import { CONFIG } from './config.js?v=1.8.8';
import { greatCirclePoints } from './utils.js?v=1.8.8';

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

/** Chincheta anclada al suelo (su vértice toca con exactitud matemática la coordenada real). */
function makeGroundPin({ lat, lng, color, size, isReal, zIndexOffset = 500 }) {
  const tipY = size * 1.2071;
  const icon = L.divIcon({
    className: 'gg-pin gg-ground-pin' + (isReal ? ' gg-real-pin' : ''),
    html: `<div class="gg-pin__pin ${isReal ? 'is-real' : ''}" style="--pin-color:${color}; width:${size}px; height:${size}px;"></div>`,
    iconSize: [size, tipY],
    iconAnchor: [size / 2, tipY],
  });
  return L.marker([lat, lng], { icon, interactive: true, zIndexOffset });
}

/** Crea el elemento DOM de la etiqueta flotante de la ubicación real. */
function createRealLabelElement(label) {
  const el = document.createElement('div');
  el.className = 'gg-floating-label gg-player-pin__label gg-real-pin__label';
  el.innerHTML = `<span class="gg-player-pin__name">${escapeHtml(label)}</span>`;
  return el;
}

/** Crea el elemento DOM de la etiqueta flotante de un jugador (con nombre y daño/puntos). */
function createPlayerLabelElement({ name, color, damage }) {
  const el = document.createElement('div');
  el.className = 'gg-floating-label gg-player-pin__label';
  el.style.setProperty('--pin-color', color);
  el.style.borderColor = color;
  el.style.color = color;

  const hasDamage = typeof damage === 'number';
  const dmgBadge = hasDamage
    ? (damage > 0
        ? `<span class="gg-player-pin__dmg hit">-${damage} pts</span>`
        : `<span class="gg-player-pin__dmg safe">⭐ 0 pts</span>`)
    : '';

  el.innerHTML = `
    <span class="gg-player-pin__name">${escapeHtml(name)}</span>
    ${dmgBadge}
  `;
  return el;
}

/** Pin de la ubicación real con etiqueta estática (fallback). */
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

/** Pin de jugador con etiqueta estática (fallback). */
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

/** Marcador de jugador en modo Carrera: punto con halo y nombre legible. */
function makeRacePlayerPin({ lat, lng, color, name, isMe }) {
  const icon = L.divIcon({
    className: 'gg-race-pin' + (isMe ? ' is-me' : ''),
    html: `<div class="gg-race-pin__wrap" style="--player-color:${color};">
        <div class="gg-race-pin__label" style="border-color:${color}; color:${color};">${escapeHtml(name)}${isMe ? ' (Tú)' : ''}</div>
        <div class="gg-race-pin__dot" style="background:${color}; box-shadow: 0 0 10px ${color};"></div>
      </div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
  return L.marker([lat, lng], { icon, interactive: false, zIndexOffset: isMe ? 2000 : 1000 });
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
    this.raceLayer = null;
    this.raceMarkers = new Map();
    this.isRaceMode = false;
    this.pick = null;          // {lat, lng}
    this.interactive = true;   // por defecto interactivo durante el juego
    this.myColor = null;       // Color asignado al jugador en la partida
    this.streetLayer = null;
    this.satelliteLayer = null;
    this.currentLayerType = 'streets';

    // Sistema anti-colisión dinámico (etiquetas flotantes y conectores SVG)
    this.revealItems = [];
    this.labelsOverlay = null;
    this.svgOverlay = null;
    this._layoutRaf = null;
    this._boundOnMapChange = null;
    this._hoveredItemId = null;
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
    this.raceLayer = L.featureGroup().addTo(this.map);

    this._initCollisionOverlay(el);

    this.map.on('click', (e) => {
      if (this.isRaceMode) return; // En modo carrera no se colocan chinchetas
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

  /** Activa/desactiva el modo Carrera (muestra solo a los jugadores desplazándose). */
  setRaceMode(enabled) {
    this.isRaceMode = !!enabled;
    if (enabled) {
      this.setInteractive(false);
      this.clear();
    } else {
      this.clearRacePlayers();
    }
  }

  /**
   * Actualiza o crea el marcador dinámico de un jugador en la carrera.
   */
  updateRacePlayer(id, { lat, lng, color, name, isMe }) {
    if (!this.map || !this.raceLayer) return;
    const numLat = Number(lat);
    const numLng = Number(lng);
    if (isNaN(numLat) || isNaN(numLng)) return;

    // Clave canónica única por nombre de jugador (o por ID si no hay nombre)
    const normName = name ? String(name).trim().toLowerCase() : '';
    const key = normName ? `p_${normName}` : String(id || 'unknown');

    // Buscar si ya existe un marcador registrado para este jugador (por clave canónica o por nombre)
    let existingKey = null;
    if (this.raceMarkers.has(key)) {
      existingKey = key;
    } else if (normName) {
      for (const [k, m] of this.raceMarkers.entries()) {
        if (m && m._ggPlayerName && m._ggPlayerName.toLowerCase() === normName) {
          existingKey = k;
          break;
        }
      }
    }

    if (existingKey) {
      const marker = this.raceMarkers.get(existingKey);
      marker.setLatLng([numLat, numLng]);
      // Si el estado isMe cambió o el icono necesita actualizarse
      if (isMe && !marker._isMe) {
        marker._isMe = true;
        if (typeof marker.setIcon === 'function') {
          marker.setIcon(makeRacePlayerPin({ lat: numLat, lng: numLng, color, name, isMe: true }).options.icon);
        }
        if (typeof marker.setZIndexOffset === 'function') {
          marker.setZIndexOffset(2000);
        }
      }
      if (existingKey !== key) {
        this.raceMarkers.delete(existingKey);
        this.raceMarkers.set(key, marker);
      }
    } else {
      // Purgar preventivamente cualquier marcador residual con el mismo nombre antes de añadir
      if (normName) {
        for (const [k, m] of this.raceMarkers.entries()) {
          if (m && m._ggPlayerName && m._ggPlayerName.toLowerCase() === normName) {
            try { this.raceLayer.removeLayer(m); } catch (e) {}
            this.raceMarkers.delete(k);
          }
        }
      }
      const marker = makeRacePlayerPin({ lat: numLat, lng: numLng, color, name, isMe });
      marker._ggPlayerName = name;
      marker._ggPlayerId = id != null ? String(id) : '';
      marker._isMe = !!isMe;
      marker.addTo(this.raceLayer);
      this.raceMarkers.set(key, marker);
    }

    if (isMe && this.isRaceMode && this.map) {
      this.map.panTo([numLat, numLng], { animate: true, duration: 0.35 });
    }
  }

  /**
   * Elimina el marcador de un jugador de la carrera (ej. al alcanzar la meta y ganar).
   */
  removeRacePlayer(id, name) {
    if (!this.map || !this.raceLayer) return;
    const normName = name ? String(name).trim().toLowerCase() : '';
    const keysToRemove = [];

    if (normName) {
      keysToRemove.push(`p_${normName}`);
    }
    if (id != null) {
      keysToRemove.push(String(id));
    }

    for (const [key, marker] of this.raceMarkers.entries()) {
      if (
        keysToRemove.includes(key) ||
        (normName && marker._ggPlayerName && marker._ggPlayerName.toLowerCase() === normName) ||
        (id != null && marker._ggPlayerId === String(id))
      ) {
        try {
          this.raceLayer.removeLayer(marker);
        } catch (e) {}
        this.raceMarkers.delete(key);
      }
    }
  }

  /** Elimina todos los marcadores de jugadores de la carrera. */
  clearRacePlayers() {
    if (this.raceLayer) {
      this.raceLayer.clearLayers();
    }
    this.raceMarkers.clear();
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

  /** Inicializa la capa DOM de etiquetas flotantes y el lienzo SVG de líneas conectoras. */
  _initCollisionOverlay(containerEl) {
    if (this.labelsOverlay) return;
    this.labelsOverlay = document.createElement('div');
    this.labelsOverlay.className = 'gg-labels-overlay';

    this.svgOverlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svgOverlay.setAttribute('class', 'gg-leaders-svg');
    this.labelsOverlay.appendChild(this.svgOverlay);

    containerEl.appendChild(this.labelsOverlay);

    this._boundOnMapChange = () => this._scheduleLayoutUpdate();
    this.map.on('move zoom viewreset resize', this._boundOnMapChange);
    window.addEventListener('resize', this._boundOnMapChange);
  }

  /** Programa una actualización a 60 FPS para el cálculo de colisiones. */
  _scheduleLayoutUpdate() {
    if (this._layoutRaf) return;
    this._layoutRaf = requestAnimationFrame(() => {
      this._layoutRaf = null;
      this._resolveCollisions();
    });
  }

  /** Asocia interacciones bidireccionales de hover/touch entre etiqueta y chincheta. */
  _bindItemInteractions(item) {
    const onEnter = () => this._setHoveredItem(item.id);
    const onLeave = () => this._setHoveredItem(null);

    item.labelEl.addEventListener('mouseenter', onEnter);
    item.labelEl.addEventListener('mouseleave', onLeave);
    item.labelEl.addEventListener('touchstart', (e) => {
      e.stopPropagation();
      this._setHoveredItem(this._hoveredItemId === item.id ? null : item.id);
    }, { passive: true });

    requestAnimationFrame(() => {
      const pinEl = item.marker && item.marker.getElement ? item.marker.getElement() : null;
      if (pinEl) {
        pinEl.addEventListener('mouseenter', onEnter);
        pinEl.addEventListener('mouseleave', onLeave);
        pinEl.addEventListener('touchstart', (e) => {
          e.stopPropagation();
          this._setHoveredItem(this._hoveredItemId === item.id ? null : item.id);
        }, { passive: true });
      }
    });
  }

  /** Aplica el resaltado enfocado sobre el item objetivo (etiqueta, chincheta y líder SVG). */
  _setHoveredItem(id) {
    this._hoveredItemId = id;
    this.revealItems.forEach((it) => {
      const isTarget = it.id === id;
      it.labelEl.classList.toggle('is-hovered', isTarget);
      const pinEl = it.marker && it.marker.getElement ? it.marker.getElement() : null;
      if (pinEl) {
        const iconDiv = pinEl.querySelector('.gg-pin__pin');
        if (iconDiv) iconDiv.classList.toggle('is-focused', isTarget);
      }
      if (this.svgOverlay) {
        const leaderPath = this.svgOverlay.querySelector(`path[data-id="${it.id}"]`);
        if (leaderPath) {
          leaderPath.setAttribute('stroke-width', isTarget ? '3.5' : '2');
          leaderPath.setAttribute('opacity', isTarget ? '1' : '0.85');
        }
      }
      if (it.polyline) {
        it.polyline.setStyle({
          weight: isTarget ? 5 : 3,
          opacity: isTarget ? 1 : 0.85,
        });
        if (isTarget && typeof it.polyline.bringToFront === 'function') {
          it.polyline.bringToFront();
        }
      }
    });
  }

  /** Algoritmo anti-colisión: calcula posiciones sin solapes, agrupa clústeres y dibuja líneas SVG. */
  _resolveCollisions() {
    if (!this.map || !this.labelsOverlay || !this.revealItems || this.revealItems.length === 0) {
      if (this.svgOverlay) this.svgOverlay.innerHTML = '';
      return;
    }

    const container = this.map.getContainer();
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (width <= 0 || height <= 0) return;

    const safePad = 12;
    const padX = 10;
    const padY = 6;

    // 1. Proyectar coordenadas geográficas a puntos en pantalla y medir cajas
    for (const item of this.revealItems) {
      const pt = this.map.latLngToContainerPoint([item.lat, item.lng]);
      item.pinX = pt.x;
      item.pinY = pt.y;
      const tipY = item.size * 1.2071;
      item.pinHeadY = pt.y - tipY;

      const rect = item.labelEl.getBoundingClientRect();
      item.w = Math.max(rect.width || 0, 70);
      item.h = Math.max(rect.height || 0, 26);

      item.defaultX = pt.x - item.w / 2;
      item.defaultY = item.pinHeadY - item.h - 6;
      item.x = item.defaultX;
      item.y = item.defaultY;
      item.isDisplaced = false;
    }

    // 2. Detección de proximidad física de chinchetas (.is-cluster para halo de alto contraste)
    const pinProximityThreshold = 18;
    for (let i = 0; i < this.revealItems.length; i++) {
      let isCluster = false;
      for (let j = 0; j < this.revealItems.length; j++) {
        if (i === j) continue;
        const dx = this.revealItems[i].pinX - this.revealItems[j].pinX;
        const dy = this.revealItems[i].pinY - this.revealItems[j].pinY;
        if (Math.hypot(dx, dy) < pinProximityThreshold) {
          isCluster = true;
          break;
        }
      }
      const pinEl = this.revealItems[i].marker && this.revealItems[i].marker.getElement ? this.revealItems[i].marker.getElement() : null;
      if (pinEl) {
        const iconDiv = pinEl.querySelector('.gg-pin__pin');
        if (iconDiv) {
          iconDiv.classList.toggle('is-cluster', isCluster);
        }
      }
    }

    // 3. Agrupación en clústeres de colisión
    const n = this.revealItems.length;
    const adj = Array.from({ length: n }, () => []);

    function boxesOverlap(a, b) {
      return !(
        a.x + a.w + padX <= b.x ||
        b.x + b.w + padX <= a.x ||
        a.y + a.h + padY <= b.y ||
        b.y + b.h + padY <= a.y
      );
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = this.revealItems[i];
        const b = this.revealItems[j];
        const pinDist = Math.hypot(a.pinX - b.pinX, a.pinY - b.pinY);
        if (pinDist < 60 || boxesOverlap(a, b)) {
          adj[i].push(j);
          adj[j].push(i);
        }
      }
    }

    const visited = new Set();
    const clusters = [];
    for (let i = 0; i < n; i++) {
      if (visited.has(i)) continue;
      const cluster = [];
      const queue = [i];
      visited.add(i);
      while (queue.length > 0) {
        const curr = queue.shift();
        cluster.push(this.revealItems[curr]);
        for (const neighbor of adj[curr]) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      clusters.push(cluster);
    }

    // 4. Distribución no superpuesta por clúster (escalera vertical o por debajo de chinchetas)
    for (const cluster of clusters) {
      if (cluster.length === 1) {
        const it = cluster[0];
        it.x = Math.max(safePad, Math.min(width - it.w - safePad, it.x));
        it.y = Math.max(safePad, Math.min(height - it.h - safePad, it.y));
        it.isDisplaced = false;
        continue;
      }

      // Ordenar: Ubicación real primero, luego de arriba a abajo por pinY
      cluster.sort((a, b) => {
        if (a.isReal && !b.isReal) return -1;
        if (!a.isReal && b.isReal) return 1;
        return a.pinY - b.pinY;
      });

      const minPinHeadY = Math.min(...cluster.map((it) => it.pinHeadY));
      const maxPinTipY = Math.max(...cluster.map((it) => it.pinY));
      const totalH = cluster.reduce((sum, it) => sum + it.h + 6, 0) - 6;

      const spaceAbove = minPinHeadY - safePad - 8;
      const spaceBelow = height - maxPinTipY - safePad - 8;

      if (spaceAbove >= totalH || spaceAbove >= spaceBelow) {
        // Apilar hacia arriba (ladder vertical)
        let curY = minPinHeadY - 8;
        for (let idx = cluster.length - 1; idx >= 0; idx--) {
          const it = cluster[idx];
          it.y = curY - it.h;
          it.x = it.pinX - it.w / 2;
          it.x = Math.max(safePad, Math.min(width - it.w - safePad, it.x));
          it.y = Math.max(safePad, it.y);
          it.isDisplaced = true;
          curY = it.y - 6;
        }
      } else {
        // Apilar hacia abajo (debajo de las chinchetas)
        let curY = maxPinTipY + 12;
        for (let idx = 0; idx < cluster.length; idx++) {
          const it = cluster[idx];
          it.y = curY;
          it.x = it.pinX - it.w / 2;
          it.x = Math.max(safePad, Math.min(width - it.w - safePad, it.x));
          it.y = Math.min(height - it.h - safePad, it.y);
          it.isDisplaced = true;
          curY = it.y + it.h + 6;
        }
      }
    }

    // 5. Aplicar transformaciones CSS GPU-accelerated (translate3d)
    for (const it of this.revealItems) {
      it.labelEl.style.transform = `translate3d(${Math.round(it.x)}px, ${Math.round(it.y)}px, 0)`;
    }

    // 6. Generar líneas conectoras SVG (curvas Bézier cúbicas con puntos terminales)
    let svgHtml = '';
    for (const it of this.revealItems) {
      const labelCenterX = it.x + it.w / 2;
      const labelBottomY = it.y + it.h;
      const labelTopY = it.y;
      const isAbove = it.y < it.pinHeadY;

      const dx = Math.abs(labelCenterX - it.pinX);
      const dy = Math.abs(it.y - it.defaultY);

      if (it.isDisplaced || dx > 12 || dy > 12) {
        const startX = labelCenterX;
        const startY = isAbove ? labelBottomY : labelTopY;
        const endX = it.pinX;
        const endY = isAbove ? it.pinHeadY + 3 : it.pinY + 3;

        const midY = (startY + endY) / 2;
        const d = `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
        const isTarget = it.id === this._hoveredItemId;
        const strokeW = isTarget ? '3.5' : '2';
        const opacity = isTarget ? '1' : '0.85';

        svgHtml += `
          <path class="gg-leader-line" data-id="${it.id}" d="${d}" stroke="${it.color}" stroke-width="${strokeW}" opacity="${opacity}" />
          <circle class="gg-leader-dot" cx="${endX}" cy="${endY}" r="3.5" fill="${it.color}" stroke="#ffffff" stroke-width="1.5" />
        `;
      }
    }

    this.svgOverlay.innerHTML = svgHtml;
  }

  /** Limpia marcadores, líneas, etiquetas flotantes y elementos SVG. */
  clear() {
    this.pick = null;
    if (this.pickMarker) {
      this.map.removeLayer(this.pickMarker);
      this.pickMarker = null;
    }
    if (this.revealLayer) {
      this.revealLayer.clearLayers();
    }
    this.revealItems = [];
    if (this.labelsOverlay) {
      const labels = this.labelsOverlay.querySelectorAll('.gg-floating-label');
      labels.forEach((el) => el.remove());
    }
    if (this.svgOverlay) {
      this.svgOverlay.innerHTML = '';
    }
    if (this._layoutRaf) {
      cancelAnimationFrame(this._layoutRaf);
      this._layoutRaf = null;
    }
    this._hoveredItemId = null;
  }

  /** Prepara el mapa para una nueva ronda (limpia y restablece vista). */
  reset() {
    this.clear();
    this.map.setView(CONFIG.MAP_DEFAULT_CENTER, CONFIG.MAP_DEFAULT_ZOOM, {
      animate: false,
    });
  }

  /** Revela la respuesta multijugador con sistema anti-colisión dinámico. */
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
      const realMarker = makeGroundPin({
        lat: realLat,
        lng: realLng,
        color: MARKER.real.color,
        size: MARKER.real.size,
        isReal: true,
        zIndexOffset: 2000,
      });
      this.revealLayer.addLayer(realMarker);
      bounds.push([realLat, realLng]);

      const realLabelEl = createRealLabelElement(MARKER.real.label);
      this.labelsOverlay.appendChild(realLabelEl);

      const realItem = {
        id: 'real',
        lat: realLat,
        lng: realLng,
        color: MARKER.real.color,
        size: MARKER.real.size,
        isReal: true,
        marker: realMarker,
        labelEl: realLabelEl,
        polyline: null,
      };
      this.revealItems.push(realItem);
      this._bindItemInteractions(realItem);
    }

    if (this.isRaceMode) {
      this.raceMarkers.forEach((marker) => {
        if (marker && marker.getLatLng) {
          bounds.push(marker.getLatLng());
        }
      });
      if (bounds.length) this._fitBounds(bounds);
      return;
    }

    (players || []).forEach((p, i) => {
      if (!p.guess) return;
      const lat = Number(p.guess.lat);
      const lng = Number(p.guess.lng);
      if (isNaN(lat) || isNaN(lng)) return;

      const color = colors[i % colors.length];
      const size = 30;

      const marker = makeGroundPin({
        lat,
        lng,
        color,
        size,
        isReal: false,
        zIndexOffset: 1000 + i,
      });
      this.revealLayer.addLayer(marker);
      bounds.push([lat, lng]);

      let polyline = null;
      if (hasReal) {
        const pts = greatCirclePoints(realLat, realLng, lat, lng, 96);
        polyline = L.polyline(pts, {
          color,
          weight: 3,
          opacity: 0.9,
          dashArray: '6 8',
        });
        this.revealLayer.addLayer(polyline);
      }

      const labelEl = createPlayerLabelElement({
        name: p.name,
        color,
        damage: p.damage,
      });
      this.labelsOverlay.appendChild(labelEl);

      const item = {
        id: `player_${p.id || i}`,
        lat,
        lng,
        color,
        size,
        isReal: false,
        marker,
        labelEl,
        polyline,
      };
      this.revealItems.push(item);
      this._bindItemInteractions(item);
    });

    if (bounds.length) {
      this._fitBounds(bounds);
    } else {
      this._scheduleLayoutUpdate();
    }
  }

  /** Revela la respuesta: ubicación real + guesses + líneas geodésicas (anti-colisión). */
  reveal({ real, mine, opp }) {
    this.clear();
    const bounds = [];

    const realLat = real ? Number(real.lat) : NaN;
    const realLng = real ? Number(real.lng) : NaN;
    const hasReal = !isNaN(realLat) && !isNaN(realLng);

    if (hasReal) {
      const realMarker = makeGroundPin({
        lat: realLat,
        lng: realLng,
        color: MARKER.real.color,
        size: MARKER.real.size,
        isReal: true,
        zIndexOffset: 2000,
      });
      this.revealLayer.addLayer(realMarker);
      bounds.push([realLat, realLng]);

      const realLabelEl = createRealLabelElement(MARKER.real.label);
      this.labelsOverlay.appendChild(realLabelEl);

      const realItem = {
        id: 'real',
        lat: realLat,
        lng: realLng,
        color: MARKER.real.color,
        size: MARKER.real.size,
        isReal: true,
        marker: realMarker,
        labelEl: realLabelEl,
        polyline: null,
      };
      this.revealItems.push(realItem);
      this._bindItemInteractions(realItem);
    }

    const drawItem = (coord, config, id, isMine) => {
      if (!coord) return;
      const lat = Number(coord.lat);
      const lng = Number(coord.lng);
      if (isNaN(lat) || isNaN(lng)) return;

      const color = (isMine && this.myColor) ? this.myColor : config.color;
      const marker = makeGroundPin({
        lat,
        lng,
        color,
        size: config.size,
        isReal: false,
        zIndexOffset: isMine ? 1200 : 1100,
      });
      this.revealLayer.addLayer(marker);
      bounds.push([lat, lng]);

      let polyline = null;
      if (hasReal) {
        const pts = greatCirclePoints(realLat, realLng, lat, lng, 96);
        polyline = L.polyline(pts, {
          color,
          weight: 3,
          opacity: 0.9,
          dashArray: '6 8',
        });
        this.revealLayer.addLayer(polyline);
      }

      const labelEl = createPlayerLabelElement({
        name: config.label,
        color,
      });
      this.labelsOverlay.appendChild(labelEl);

      const item = {
        id,
        lat,
        lng,
        color,
        size: config.size,
        isReal: false,
        marker,
        labelEl,
        polyline,
      };
      this.revealItems.push(item);
      this._bindItemInteractions(item);
    };

    drawItem(mine, MARKER.mine, 'mine', true);
    drawItem(opp, MARKER.opp, 'opp', false);

    if (bounds.length) {
      this._fitBounds(bounds);
    } else {
      this._scheduleLayoutUpdate();
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
      } else {
        this.map.fitBounds(L.latLngBounds(bounds), {
          padding: [60, 60],
          maxZoom: 16,
          animate: false,
        });
      }
      this._scheduleLayoutUpdate();
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
      requestAnimationFrame(() => {
        this.refreshSize();
        this._scheduleLayoutUpdate();
      });
    } else {
      requestAnimationFrame(() => {
        this.refreshSize();
        this._scheduleLayoutUpdate();
      });
    }
  }
}
