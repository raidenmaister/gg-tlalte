// ============================================================================
// panorama.js — Visor panorámico 360° (Google Street View) + brújula.
// ============================================================================

import { CONFIG } from './config.js';

let mapsPromise = null;

/**
 * Carga la API de Google Maps una única vez (Promise memoizada).
 * @returns {Promise<object>} Resuelve con el namespace `google.maps`.
 */
export function loadGoogleMaps() {
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise((resolve, reject) => {
    if (window.google && window.google.maps) {
      resolve(window.google.maps);
      return;
    }

    let key = (
      window.GG_GOOGLE_MAPS_API_KEY ||
      CONFIG.GOOGLE_API_KEY ||
      ''
    ).trim();
    if (!key) {
      key = window.prompt(
        'Pega tu Google Maps API Key para cargar las panorámicas 360°:'
      );
    }
    if (!key) {
      reject(new Error('SIN_API_KEY'));
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key
    )}&v=weekly`;
    script.async = true;
    script.onload = () => {
      if (window.google && window.google.maps) resolve(window.google.maps);
      else reject(new Error('API_NO_DISPONIBLE'));
    };
    script.onerror = () => reject(new Error('API_LOAD_FAILED'));
    document.head.appendChild(script);
  });

  return mapsPromise;
}

export class PanoramaViewer {
  /**
   * @param {string} containerId ID del contenedor del panorama.
   * @param {object} callbacks { onReady, onPovChange }
   */
  constructor(containerId, callbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks;
    this.panorama = null;
    this.initialHeading = 0;
    this.initialPitch = 0;
  }

  async init() {
    const maps = await loadGoogleMaps();
    const el = document.getElementById(this.containerId);
    if (!el) throw new Error(`Contenedor #${this.containerId} no encontrado`);

    this.panorama = new maps.StreetViewPanorama(el, {
      pov: { heading: 0, pitch: 0 },
      zoom: 0,
      visible: true,
      addressControl: false,       // oculta la dirección (daría la respuesta)
      linksControl: false,         // sin flechas de navegación (modo sin mover)
      clickToGo: false,            // desactiva teleport por clic
      showRoadLabels: false,
      motionTracking: false,
      motionTrackingControl: false,
      fullscreenControl: false,
      enableCloseButton: false,
      scrollwheel: true,           // zoom con rueda / gestos
      disableDefaultUI: true,
    });

    this.panorama.addListener('pov_changed', () => {
      if (this.callbacks.onPovChange) {
        this.callbacks.onPovChange(this.getHeading(), this.getPitch());
      }
    });

    // Re-aplica el punto de vista al cargar un nuevo pano (evita que el
    // visor lo restablezca y garantiza la misma perspectiva en todos).
    this.panorama.addListener('pano_changed', () => {
      this.panorama.setPov({
        heading: this.initialHeading,
        pitch: this.initialPitch,
      });
    });

    this.panorama.addListener('status_changed', () => {
      if (this.callbacks.onStatusChange) this.callbacks.onStatusChange();
    });

    if (this.callbacks.onReady) this.callbacks.onReady();
    return this.panorama;
  }

  /** Muestra una panorámica por su pano_id y fija el punto de vista inicial. */
  setPano(panoId, heading = 0, pitch = 0) {
    if (!this.panorama) return;
    this.initialHeading = heading;
    this.initialPitch = pitch;
    this.panorama.setPano(panoId);
    this.panorama.setPov({ heading, pitch });
  }

  /** Orientación actual de la cámara (heading en grados, 0 = norte). */
  getHeading() {
    return this.panorama ? this.panorama.getPov().heading : 0;
  }

  getPitch() {
    return this.panorama ? this.panorama.getPov().pitch : 0;
  }

  /** Recentra la vista al punto original de la ronda. */
  recenter() {
    if (!this.panorama) return;
    this.panorama.setPov({
      heading: this.initialHeading,
      pitch: this.initialPitch,
    });
  }

  /** Habilita/deshabilita la interacción de arrastre. */
  setInteractivity(enabled) {
    if (this.panorama) this.panorama.setOptions({ clickToGo: false, scrollwheel: enabled });
  }

  destroy() {
    if (this.panorama) {
      try {
        this.panorama.setVisible(false);
      } catch (e) {}
      this.panorama = null;
    }
  }
}
