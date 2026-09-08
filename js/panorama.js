// ============================================================================
// panorama.js — Visor panorámico 360° (Google Street View) + brújula.
// ============================================================================

import { CONFIG } from './config.js?v=1.8.7';
import { detectPotatoMode } from './utils.js?v=1.8.7';

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
    this.isRace = false;
    this.isFlashlight = false;
    this.flashlightBattery = 100;
    this.flashlightPos = null;
    this._flashlightBoundHandler = null;
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
      if (!this.isRace) {
        this.panorama.setPov({
          heading: this.initialHeading,
          pitch: this.initialPitch,
        });
      } else {
        const pos = this.panorama.getPosition();
        if (pos && this.callbacks.onPositionChange) {
          this.callbacks.onPositionChange(pos.lat(), pos.lng(), this.currentPanoId);
        }
      }
    });

    this.panorama.addListener('position_changed', () => {
      if (this.isRace) {
        const pos = this.panorama.getPosition();
        if (pos && this.callbacks.onPositionChange) {
          this.callbacks.onPositionChange(pos.lat(), pos.lng(), this.currentPanoId);
        }
      }
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
    this._setupRaceControls(el);

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
      // Si estamos en modo carrera, permitir desplazamiento por teclas (flechas / WASD)
      if (this.isRace) return;

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

    // clickToGo ya está desactivado; esto bloquea el doble clic de zoom+navegación en modos normales.
    el.addEventListener('dblclick', (e) => {
      if (this.isRace) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  /**
   * Avanza en la dirección del heading indicado hacia el nodo conectado más cercano.
   * Cuenta con protección contra parpadeo en negro y artefactos WebGL limitando
   * la cadencia a máximo una transición fluida cada 240ms.
   */
  advanceInHeading(targetHeading) {
    if (!this.panorama || !this.isRace) return;

    const now = Date.now();
    if (this._lastAdvanceTime && (now - this._lastAdvanceTime) < 240) return;

    const links = this.panorama.getLinks();
    if (!links || !Array.isArray(links) || links.length === 0) return;

    let bestLink = null;
    let minDiff = 180;
    for (const link of links) {
      if (!link || !link.pano) continue;
      let diff = Math.abs(link.heading - targetHeading);
      if (diff > 180) diff = 360 - diff;
      if (diff < minDiff) {
        minDiff = diff;
        bestLink = link;
      }
    }

    if (!bestLink || minDiff > 85) return; // Fuera del ángulo de calles navegables
    if (bestLink.pano === this.currentPanoId) return;

    this._lastAdvanceTime = now;
    this.panorama.setPano(bestLink.pano);
  }

  _setupRaceControls(el) {
    let downX = 0, downY = 0, downTime = 0;

    el.addEventListener('mousedown', (e) => {
      if (!this.isRace) return;
      downX = e.clientX;
      downY = e.clientY;
      downTime = Date.now();
    }, true);

    el.addEventListener('mouseup', (e) => {
      if (!this.isRace) return;
      const elapsed = Date.now() - downTime;
      const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
      // Si fue arrastre para rotar la cámara o pulsación larga, no es click de avance
      if (dist > 12 || elapsed > 400) return;

      // Ignorar clicks sobre controles de interfaz, minimapa, botones o HUD
      if (e.target.closest('.hud-top, .minimap-wrap, button, .race-hud, .modal, .panel, input, textarea')) return;

      const rect = el.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      const normX = (clickX / rect.width) - 0.5; // [-0.5, 0.5]
      const normY = clickY / rect.height; // [0, 1]

      // Ignorar clicks en el cielo a menos que esté mirando hacia abajo
      if (normY < 0.18 && this.getPitch() >= 0) return;

      const zoom = (this.panorama && this.panorama.getZoom()) || 0;
      const fov = 90 / Math.pow(1.5, zoom);
      const targetHeading = (this.getHeading() + normX * fov + 360) % 360;

      this.advanceInHeading(targetHeading);
    }, true);

    // Controles táctiles para móviles / tablets
    let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
    el.addEventListener('touchstart', (e) => {
      if (!this.isRace || e.touches.length !== 1) return;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchStartTime = Date.now();
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
      if (!this.isRace || e.changedTouches.length !== 1) return;
      const elapsed = Date.now() - touchStartTime;
      const t = e.changedTouches[0];
      const dist = Math.hypot(t.clientX - touchStartX, t.clientY - touchStartY);
      if (dist > 16 || elapsed > 450) return;
      if (e.target.closest('.hud-top, .minimap-wrap, button, .race-hud, .modal, .panel, input, textarea')) return;

      const rect = el.getBoundingClientRect();
      const clickX = t.clientX - rect.left;
      const normX = (clickX / rect.width) - 0.5;
      const targetHeading = (this.getHeading() + normX * 85 + 360) % 360;
      this.advanceInHeading(targetHeading);
    }, { passive: true });

    // Controles de teclado en carrera (WASD y flechas con límite de velocidad para evitar sobrecarga WebGL)
    window.addEventListener('keydown', (e) => {
      if (!this.isRace) return;
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

      const key = e.key.toLowerCase();
      const now = Date.now();

      if (key === 'w' || key === 'arrowup') {
        e.preventDefault();
        if (this._lastAdvanceTime && (now - this._lastAdvanceTime) < 240) return;
        this.advanceInHeading(this.getHeading());
      } else if (key === 's' || key === 'arrowdown') {
        e.preventDefault();
        if (this._lastAdvanceTime && (now - this._lastAdvanceTime) < 240) return;
        this.advanceInHeading((this.getHeading() + 180) % 360);
      } else if (key === 'a' || key === 'arrowleft') {
        e.preventDefault();
        if (this.panorama) {
          const cur = this.panorama.getPov();
          this.panorama.setPov({ heading: (cur.heading - 25 + 360) % 360, pitch: cur.pitch });
        }
      } else if (key === 'd' || key === 'arrowright') {
        e.preventDefault();
        if (this.panorama) {
          const cur = this.panorama.getPov();
          this.panorama.setPov({ heading: (cur.heading + 25) % 360, pitch: cur.pitch });
        }
      }
    });
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

  /** Activa/desactiva el modo Carrera al Objetivo (navegación por calles en 360° permitida). */
  setRaceMode(enabled) {
    this.isRace = !!enabled;
    this._lastAdvanceTime = 0;
    if (this.panorama) {
      this.panorama.setOptions({
        clickToGo: false,             // Evita colisiones entre raycast nativo y advanceInHeading
        linksControl: !!enabled,      // Flechas en el suelo
        showRoadLabels: false,
        disableDoubleClickZoom: true, // Evita zoom repentino al hacer clics rápidos
      });
    }
  }

  /**
   * Activa/desactiva el Modo Linterna Táctica (Niebla Nocturna 360°).
   * Genera un haz de luz focalizado que sigue al cursor o dedo táctil.
   * La batería se consume ÚNICAMENTE al mover la luz; en reposo el consumo es 0%.
   */
  setFlashlightMode(enabled) {
    this.isFlashlight = !!enabled;

    // Limpiar listener previo si existía
    if (this._flashlightBoundHandler) {
      window.removeEventListener('pointermove', this._flashlightBoundHandler);
      window.removeEventListener('pointerdown', this._flashlightBoundHandler);
      window.removeEventListener('touchmove', this._flashlightBoundHandler);
      window.removeEventListener('touchstart', this._flashlightBoundHandler);
      this._flashlightBoundHandler = null;
    }

    const overlay = document.getElementById('panoFlashlightOverlay');

    if (!enabled) {
      if (overlay) {
        overlay.classList.add('hidden');
        overlay.style.removeProperty('background');
      }
      this.flashlightBattery = 100;
      this.flashlightPos = null;
      return;
    }

    // Inicializar linterna al 100% de batería
    this.flashlightBattery = 100;
    const panoEl = document.getElementById(this.containerId) || document.body;
    const rect = panoEl.getBoundingClientRect();
    const initX = rect.width ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const initY = rect.height ? rect.top + rect.height / 2 : window.innerHeight / 2;
    this.flashlightPos = { x: initX, y: initY };

    if (overlay) {
      overlay.classList.remove('hidden');
      this._updateFlashlightOverlay(initX, initY);
    }

    if (this.callbacks.onBatteryChange) {
      this.callbacks.onBatteryChange(100);
    }

    // Handler de movimiento táctico con consumo de batería por distancia
    this._flashlightBoundHandler = (e) => {
      if (!this.isFlashlight) return;

      let clientX = e.clientX;
      let clientY = e.clientY;
      if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
      } else if (clientX === undefined && e.changedTouches && e.changedTouches.length > 0) {
        clientX = e.changedTouches[0].clientX;
        clientY = e.changedTouches[0].clientY;
      }
      if (clientX === undefined || clientY === undefined) return;

      if (!this.flashlightPos) {
        this.flashlightPos = { x: clientX, y: clientY };
        this._updateFlashlightOverlay(clientX, clientY);
        return;
      }

      const dx = clientX - this.flashlightPos.x;
      const dy = clientY - this.flashlightPos.y;
      const dist = Math.hypot(dx, dy);

      // Si no quitas la luz de un punto (distancia <= 1.5px), la batería NO se consume
      if (dist > 1.5 && this.flashlightBattery > 0) {
        const drainPerPx = CONFIG.FLASHLIGHT_DRAIN_PER_PX || 0.0072;
        const drain = dist * drainPerPx;
        const prev = this.flashlightBattery;
        this.flashlightBattery = Math.max(0, this.flashlightBattery - drain);
        this.flashlightPos = { x: clientX, y: clientY };

        if (this.callbacks.onBatteryChange && Math.abs(prev - this.flashlightBattery) >= 0.2) {
          this.callbacks.onBatteryChange(this.flashlightBattery);
        }
      } else {
        this.flashlightPos = { x: clientX, y: clientY };
      }

      this._updateFlashlightOverlay(clientX, clientY);
    };

    window.addEventListener('pointermove', this._flashlightBoundHandler, { passive: true });
    window.addEventListener('pointerdown', this._flashlightBoundHandler, { passive: true });
    window.addEventListener('touchmove', this._flashlightBoundHandler, { passive: true });
    window.addEventListener('touchstart', this._flashlightBoundHandler, { passive: true });
  }

  /**
   * Actualiza el gradiente radial del overlay de niebla según coordenadas y nivel de batería.
   */
  _updateFlashlightOverlay(x, y) {
    const overlay = document.getElementById('panoFlashlightOverlay');
    if (!overlay) return;

    const battery = this.flashlightBattery;

    if (battery <= 0) {
      // Linterna completamente apagada: casi completa oscuridad, tenue punto rojo de emergencia
      overlay.style.background = `radial-gradient(circle 8px at ${Math.round(x)}px ${Math.round(y)}px, rgba(239, 68, 68, 0.2) 0%, rgba(2, 4, 10, 0.995) 100%)`;
      return;
    }

    const maxR = CONFIG.FLASHLIGHT_MAX_RADIUS || 155;
    const minR = CONFIG.FLASHLIGHT_MIN_RADIUS || 65;

    let r = maxR;
    if (battery < 20) {
      // Reserva crítica (< 20%): radio reducido y micro-parpadeo sutil
      const t = Math.max(0, battery / 20);
      r = minR + (maxR * 0.65 - minR) * t;
      if (Math.random() < 0.12) {
        r *= (0.88 + Math.random() * 0.1);
      }
    } else if (battery < 50) {
      const t = (battery - 20) / 30;
      r = (maxR * 0.65) + (maxR - maxR * 0.65) * t;
    }

    r = Math.max(12, Math.round(r));
    const innerClear = Math.round(r * 0.45);
    const softEdge = Math.round(r * 0.88);

    overlay.style.background = `radial-gradient(circle ${r}px at ${Math.round(x)}px ${Math.round(y)}px, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.08) ${innerClear}px, rgba(2, 4, 10, 0.9) ${softEdge}px, rgba(2, 4, 10, 0.985) ${r}px, rgba(2, 4, 10, 0.995) 100%)`;
  }

  destroy() {
    this.setFlashlightMode(false);
    if (this.panorama) {
      try {
        this.panorama.setVisible(false);
      } catch (e) {}
      this.panorama = null;
    }
  }
}
