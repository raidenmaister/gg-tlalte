// ============================================================================
// panorama.js — Visor panorámico 360° (Google Street View) + brújula.
// ============================================================================

import { CONFIG } from './config.js?v=1.7.7';
import { detectPotatoMode } from './utils.js?v=1.7.7';

let mapsPromise = null;

/**
 * Carga la API de Google Maps una única vez (Promise memoizada).
 * @returns {Promise<object>} Resuelve con el namespace `google.maps`.
 */
export function loadGoogleMaps() {
  if (mapsPromise) return mapsPromise;

  mapsPromise = new Promise(async (resolve, reject) => {
    const ensureLibraries = async (maps) => {
      try {
        if (typeof maps.importLibrary === 'function') {
          const svLib = await maps.importLibrary('streetView');
          if (svLib) {
            if (svLib.StreetViewPanorama) maps.StreetViewPanorama = svLib.StreetViewPanorama;
            if (svLib.StreetViewService) maps.StreetViewService = svLib.StreetViewService;
          }
          const mapsLib = await maps.importLibrary('maps');
          if (mapsLib && mapsLib.Map) {
            maps.Map = mapsLib.Map;
          }
        }
      } catch (e) {}
      // Esperar activamente hasta que StreetViewPanorama sea una función constructora
      let tries = 0;
      while (typeof maps.StreetViewPanorama !== 'function' && tries < 60) {
        await new Promise((r) => setTimeout(r, 50));
        tries++;
      }
      return maps;
    };

    if (window.google && window.google.maps) {
      const maps = await ensureLibraries(window.google.maps);
      resolve(maps);
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

    const cbName = '__ggMapsCallback_' + Math.random().toString(36).slice(2);
    window[cbName] = async () => {
      delete window[cbName];
      if (window.google && window.google.maps) {
        const maps = await ensureLibraries(window.google.maps);
        resolve(maps);
      } else {
        reject(new Error('API_NO_DISPONIBLE'));
      }
    };

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      key
    )}&v=weekly&loading=async&callback=${cbName}`;
    script.async = true;
    script.onerror = () => {
      delete window[cbName];
      reject(new Error('API_LOAD_FAILED'));
    };
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
    this.status = null;
    this.currentPanoId = null;
    this.currentCoord = null;
    this._svService = null;
    this._fallbackAttempted = false;
    this.isPotato = detectPotatoMode();
    this.isBlur = false;
  }

  async init() {
    const maps = await loadGoogleMaps();
    const el = document.getElementById(this.containerId);
    if (!el) throw new Error(`Contenedor #${this.containerId} no encontrado`);

    if (typeof maps.StreetViewPanorama !== 'function') {
      if (typeof maps.importLibrary === 'function') {
        const sv = await maps.importLibrary('streetView');
        if (sv && sv.StreetViewPanorama) maps.StreetViewPanorama = sv.StreetViewPanorama;
        if (sv && sv.StreetViewService) maps.StreetViewService = sv.StreetViewService;
      }
    }

    try {
      this._svService = new maps.StreetViewService();
    } catch (e) {}

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
      disableDoubleClickZoom: false,
    });

    this.panorama.addListener('pov_changed', () => {
      if (this.callbacks.onPovChange) {
        this.callbacks.onPovChange(this.getHeading(), this.getPitch());
      }
    });

    // Re-aplica el punto de vista al cargar un nuevo pano (evita que el
    // visor lo restablezca y garantiza la misma perspectiva en todos).
    this.panorama.addListener('pano_changed', () => {
      this.currentPanoId = this.panorama.getPano();
      this.panorama.setPov({
        heading: this.initialHeading,
        pitch: this.initialPitch,
      });
    });

    this.panorama.addListener('status_changed', () => {
      this.status = this.panorama.getStatus();
      if (this.status !== 'OK' && this.status !== 'LOADING' && this.status !== 'UNKNOWN') {
        console.warn('GG-TLALTE: StreetView status no es OK (' + this.status + '). Intentando recuperación...');
        this._tryFallbackPosition();
      }
      if (this.callbacks.onStatusChange) this.callbacks.onStatusChange(this.status);
    });

    // Recuperación ante pérdida de contexto WebGL
    el.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      console.warn('GG-TLALTE: WebGL context lost en panorama. Restaurando...');
      setTimeout(() => this.refresh(), 100);
      setTimeout(() => this.recover(), 300);
    }, false);

    // Evitar cualquier scroll por rueda o gestos en la ventana o contenedor
    el.addEventListener('wheel', (e) => {
      if (this.isTunnel || this.isStatic || this.isBlur) {
        e.preventDefault();
      }
    }, { passive: false });

    this._blockNavigation(el);

    if (this.currentPanoId) {
      this.setPano(this.currentPanoId, this.initialHeading, this.initialPitch, this.currentCoord);
    }

    if (this.callbacks.onReady) this.callbacks.onReady();
    return this.panorama;
  }

  /**
   * Intenta recuperar una panorámica usando StreetViewService o setPosition por coordenadas geográficas
   * cuando el pano_id falla, se desactualizó en los servidores de Google o devuelve ZERO_RESULTS.
   */
  _tryFallbackPosition() {
    if (!this.currentCoord || this._fallbackAttempted || !this.panorama) return;
    this._fallbackAttempted = true;
    const lat = Number(this.currentCoord.lat);
    const lng = Number(this.currentCoord.lng);
    if (isNaN(lat) || isNaN(lng)) return;

    try {
      if (!this._svService && window.google && window.google.maps) {
        this._svService = new window.google.maps.StreetViewService();
      }
      if (this._svService) {
        this._svService.getPanorama({
          location: { lat, lng },
          radius: 250,
          preference: window.google.maps.StreetViewPreference.NEAREST,
          source: window.google.maps.StreetViewSource.DEFAULT,
        }, (data, status) => {
          if (status === 'OK' && data && data.location && data.location.pano) {
            console.warn('GG-TLALTE: Pano ID recuperado exitosamente por coordenadas:', data.location.pano);
            this.panorama.setPano(data.location.pano);
            this.panorama.setPov({ heading: this.initialHeading, pitch: this.initialPitch });
            this.refresh();
          } else {
            console.warn('GG-TLALTE: Fallback directo a setPosition({ lat, lng })');
            this.panorama.setPosition({ lat, lng });
            this.panorama.setPov({ heading: this.initialHeading, pitch: this.initialPitch });
            this.refresh();
          }
        });
        return;
      }
    } catch (e) {
      console.error('GG-TLALTE: Error en fallback de panorámica:', e);
    }

    try {
      this.panorama.setPosition({ lat, lng });
      this.panorama.setPov({ heading: this.initialHeading, pitch: this.initialPitch });
      this.refresh();
    } catch (e) {}
  }

  /**
   * Evita que el teclado o el doble clic desplacen al usuario a otro nodo.
   * Se mantiene la rotación de vista (arrastre) y el zoom (rueda).
   */
  _blockNavigation(el) {
    el.addEventListener('keydown', (e) => {
      const navKeys = [
        'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'w', 'a', 's', 'd', 'W', 'A', 'S', 'D',
        'Enter', ' ', 'Spacebar',
      ];
      if (navKeys.includes(e.key) || navKeys.includes(e.code)) {
        e.preventDefault();
        e.stopPropagation();
      }

      const zoomKeys = ['+', '-', '=', '_', 'PageUp', 'PageDown'];
      if ((this.isTunnel || this.isBlur || this.isStatic) && (zoomKeys.includes(e.key) || zoomKeys.includes(e.code))) {
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // clickToGo ya está desactivado; esto bloquea el doble clic de zoom+navegación.
    el.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  /** Refresca el lienzo de StreetView forzando resize y visibilidad activa. */
  refresh() {
    if (this.panorama) {
      try {
        this.panorama.setVisible(true);
        if (window.google && window.google.maps && window.google.maps.event) {
          window.google.maps.event.trigger(this.panorama, 'resize');
        }
        window.dispatchEvent(new Event('resize'));
        requestAnimationFrame(() => {
          try {
            if (this.panorama && window.google && window.google.maps && window.google.maps.event) {
              window.google.maps.event.trigger(this.panorama, 'resize');
            }
          } catch (e) {}
        });
      } catch (e) {}
    }
  }

  /** Muestra una panorámica por su pano_id y fija el punto de vista inicial con fallback por coordenadas. */
  setPano(panoId, heading = 0, pitch = 0, coord = null) {
    this.initialHeading = heading;
    this.initialPitch = pitch;
    this.currentPanoId = panoId;
    if (coord) this.currentCoord = coord;
    this._fallbackAttempted = false;
    if (!this.panorama) {
      // Guardado en cola: se renderizará en cuanto init() finalice
      return;
    }
    this.status = null;
    this.refresh();
    this.panorama.setPano(panoId);
    this.panorama.setPov({ heading, pitch });
  }

  /**
   * Resuelve cuando la panorámica solicitada terminó de cargarse y renderizarse en alta definición.
   * @param {number} maxTimeout Tiempo máximo de espera antes de continuar (por defecto 2500ms).
   * @returns {Promise<void>}
   */
  waitForReady(maxTimeout = 2500) {
    if (!this.panorama) return Promise.resolve();

    return new Promise((resolve) => {
      const prev = this.callbacks.onStatusChange;
      let timer = null;
      let bufferTimer = null;
      let done = false;

      const restore = () => {
        if (timer) clearTimeout(timer);
        if (bufferTimer) clearTimeout(bufferTimer);
        this.callbacks.onStatusChange = prev;
      };

      const finishSuccess = () => {
        if (done) return;
        done = true;
        // Margen de 250ms para que Street View descargue y decodifique las teselas HD evitando imágenes borrosas
        bufferTimer = setTimeout(() => {
          restore();
          this.refresh();
          resolve();
        }, 250);
      };

      const onStatus = (s) => {
        this.status = s;
        if (s === 'OK') {
          finishSuccess();
        } else if (s && s !== 'LOADING' && s !== 'UNKNOWN') {
          // Intentar recuperación inmediata por coordenadas
          this._tryFallbackPosition();
        }
      };

      this.callbacks.onStatusChange = onStatus;
      if (this.status === 'OK') {
        finishSuccess();
      } else {
        onStatus(this.status);
      }

      // Timeout de seguridad: nunca congelar la partida más de maxTimeout si el internet es lento
      timer = setTimeout(() => {
        if (!done) {
          done = true;
          restore();
          if (this.status !== 'OK') {
            this._tryFallbackPosition();
          }
          this.refresh();
          resolve();
        }
      }, maxTimeout);
    });
  }

  /** Recupera la panorámica de forma forzada ante pantallas negras o fallos de renderizado. */
  recover(coord = null) {
    if (coord) this.currentCoord = coord;
    this.setBlind(false);
    this.refresh();
    this._fallbackAttempted = false;
    this._tryFallbackPosition();
    if (this.currentPanoId && this.panorama) {
      try {
        this.panorama.setPano(this.currentPanoId);
        this.panorama.setPov({ heading: this.initialHeading, pitch: this.initialPitch });
      } catch (e) {}
    }
    setTimeout(() => this.refresh(), 80);
    setTimeout(() => this.refresh(), 250);
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

  /** Activa/desactiva el modo estático bloqueando completamente la interacción y el arrastre. */
  setStatic(enabled) {
    this.isStatic = !!enabled;
    const el = document.getElementById(this.containerId);
    if (el) {
      el.classList.toggle('pano-static', !!enabled);
    }
    const overlay = document.getElementById('panoStaticOverlay');
    if (overlay) {
      overlay.classList.toggle('hidden', !enabled);
    }
    if (this.panorama) {
      this.panorama.setOptions({
        clickToGo: false,
        scrollwheel: false,
        disableDoubleClickZoom: !!enabled,
        gestureHandling: enabled ? 'none' : (this.isTunnel ? 'greedy' : 'greedy'),
      });
    }
    const screenGame = document.getElementById('screen-game');
    if (screenGame) {
      screenGame.scrollTop = 0;
      screenGame.scrollLeft = 0;
    }
    window.scrollTo(0, 0);
  }

  /**
   * Ajusta el nivel de zoom y escala visual del modo Zoom Progresivo.
   * @param {number} step Paso actual (4 = máximo, 3 = medio alto, 2 = medio, 1 = normal).
   */
  setTunnelZoom(step) {
    if (!this.panorama) return;
    const panoEl = document.getElementById(this.containerId);
    const zoomMap = {
      4: { svZoom: 4.2, scale: 1.5 },
      3: { svZoom: 2.8, scale: 1.0 },
      2: { svZoom: 1.4, scale: 1.0 },
      1: { svZoom: 0.0, scale: 1.0 },
    };
    const cfg = zoomMap[step] || { svZoom: 0.0, scale: 1.0 };
    try {
      this.panorama.setZoom(cfg.svZoom);
    } catch (e) {}
    if (panoEl) {
      panoEl.style.transition = 'transform 0.5s cubic-bezier(0.25, 1, 0.5, 1)';
      panoEl.style.transformOrigin = 'center center';
      panoEl.style.transform = cfg.scale > 1.0 ? `scale(${cfg.scale})` : 'none';
      const screenGame = document.getElementById('screen-game');
      if (screenGame) {
        screenGame.scrollTop = 0;
        screenGame.scrollLeft = 0;
      }
      window.scrollTo(0, 0);
    }
  }

  /**
   * Activa/desactiva el modo Zoom Progresivo (Visión Túnel).
   * Bloquea el zoom manual por rueda y gestos mientras permite rotación libre en 360° (o fija si es estático).
   */
  setTunnelMode(enabled, initialZoom = 4.2) {
    this.isTunnel = !!enabled;
    if (!this.panorama) return;
    const panoEl = document.getElementById(this.containerId);
    const screenGame = document.getElementById('screen-game');
    if (screenGame) {
      screenGame.scrollTop = 0;
      screenGame.scrollLeft = 0;
    }
    window.scrollTo(0, 0);

    if (enabled) {
      this.panorama.setOptions({
        clickToGo: false,
        scrollwheel: false,
        disableDoubleClickZoom: true,
        gestureHandling: this.isStatic ? 'none' : 'greedy',
      });
      this.setTunnelZoom(4);
    } else {
      this.panorama.setOptions({
        clickToGo: false,
        scrollwheel: !this.isStatic,
        disableDoubleClickZoom: !!this.isStatic,
        gestureHandling: this.isStatic ? 'none' : 'greedy',
      });
      if (panoEl) {
        panoEl.style.transform = 'none';
      }
      this.panorama.setZoom(0);
    }
  }

  /**
   * Activa/desactiva el Modo Borroso (Desenfocado Progresivo).
   * Bloquea zoom manual por rueda y gestos mientras permite rotación libre en 360° (o fija si es estático).
   */
  setBlurMode(enabled) {
    this.isBlur = !!enabled;
    const panoEl = document.getElementById(this.containerId);
    if (panoEl) {
      panoEl.classList.toggle('pano-blur-mode', !!enabled);
      // Mantener #pano siempre libre de filtros y transforms para 60 FPS nativos al arrastrar
      panoEl.style.filter = 'none';
      panoEl.style.webkitFilter = 'none';
      panoEl.style.transform = 'none';
    }

    const blurOverlay = document.getElementById('panoBlurOverlay');
    if (!enabled && blurOverlay) {
      blurOverlay.classList.remove('phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5');
      blurOverlay.classList.add('hidden');
      blurOverlay.style.removeProperty('backdrop-filter');
      blurOverlay.style.removeProperty('-webkit-backdrop-filter');
    }

    if (!this.panorama) return;
    if (enabled) {
      this.panorama.setOptions({
        clickToGo: false,
        scrollwheel: false,
        disableDoubleClickZoom: true,
        gestureHandling: this.isStatic ? 'none' : 'greedy',
      });
      try {
        this.panorama.setZoom(0);
      } catch (e) {}
      this.setBlurLevel(1);
    } else {
      this.setBlurLevel(0);
      this.panorama.setOptions({
        clickToGo: false,
        scrollwheel: !this.isStatic,
        disableDoubleClickZoom: !!this.isStatic,
        gestureHandling: this.isStatic ? 'none' : 'greedy',
      });
      try {
        this.panorama.setZoom(0);
      } catch (e) {}
    }
  }

  /**
   * Ajusta el nivel de desenfoque progresivo óptico según la fase activa (1 a 5, o 0 para nítido).
   * Se aplica sobre #panoBlurOverlay (backdrop-filter) con pointer-events: none,
   * manteniendo #pano totalmente limpio de transformaciones para un arrastre a 60 FPS ultra ligero.
   * Fase 1: 100% borroso (24px, potato 16px)
   * Fase 2: 80% borroso (16px, potato 11px)
   * Fase 3: 60% borroso (10px, potato 7px)
   * Fase 4: 40% borroso (5.5px, potato 3.5px)
   * Fase 5: 20% borroso (2.5px, potato 1.5px)
   * Fase 0: 0% borroso (nítido)
   */
  setBlurLevel(phase) {
    const panoEl = document.getElementById(this.containerId);
    if (panoEl) {
      panoEl.style.filter = 'none';
      panoEl.style.webkitFilter = 'none';
      panoEl.style.transform = 'none';
    }

    const overlay = document.getElementById('panoBlurOverlay');
    if (!overlay) return;

    overlay.classList.remove('phase-1', 'phase-2', 'phase-3', 'phase-4', 'phase-5');

    const numPhase = Number(phase) || 0;
    if (numPhase <= 0) {
      overlay.classList.add('hidden');
      overlay.style.removeProperty('backdrop-filter');
      overlay.style.removeProperty('-webkit-backdrop-filter');
      return;
    }

    const isPotato = this.isPotato || document.body.classList.contains('is-potato');
    const blurRadii = isPotato
      ? { 1: '16px', 2: '11px', 3: '7px', 4: '3.5px', 5: '1.5px' }
      : { 1: '24px', 2: '16px', 3: '10px', 4: '5.5px', 5: '2.5px' };

    const radius = blurRadii[numPhase] || '24px';
    const filterVal = `blur(${radius})`;

    overlay.classList.remove('hidden');
    overlay.classList.add(`phase-${numPhase}`);
    overlay.style.setProperty('backdrop-filter', filterVal, 'important');
    overlay.style.setProperty('-webkit-backdrop-filter', filterVal, 'important');
  }

  /** Ajusta el nivel de zoom programáticamente. */
  setSmoothZoom(zoomLevel) {
    if (this.panorama) {
      try {
        this.panorama.setZoom(zoomLevel);
      } catch (e) {}
    }
  }

  /** Muestra/oculta la cortina opaca sobre la panorámica (sincronización / modo temporal). */
  setBlind(visible, title = '', sub = '', showSpinner = false) {
    const blind = document.getElementById('panoBlind');
    if (!blind) return;
    if (visible) {
      blind.classList.remove('hidden');
      const titleEl = document.getElementById('blindTitle');
      const subEl = document.getElementById('blindSub');
      const spinnerEl = document.getElementById('blindSpinner');
      if (titleEl) titleEl.textContent = title;
      if (subEl) subEl.textContent = sub;
      if (spinnerEl) spinnerEl.style.display = showSpinner ? 'block' : 'none';
    } else {
      blind.classList.add('hidden');
    }
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
