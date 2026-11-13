// ============================================================================
// menu-pano.js — Fondo panorámico 360° ambiental para los menús (BETA v2.0)
//
// Presenta panorámicas reales aleatorias de Tlaltenango tomadas de la lista
// de ubicaciones válidas, girando suavemente de derecha a izquierda.
// Cada 45 segundos de visualización activa en menú realiza una transición
// cinematográfica sutil (imagen -> negro -> imagen).
// Pausa inteligente: si el usuario pierde el foco o cambia de pestaña,
// el temporizador y el cambio de pano se pausan para no cambiar en su ausencia.
// Suspensión total: se detiene al 100% durante las partidas para 0% uso de GPU/CPU.
// ============================================================================

import { loadGoogleMaps } from './panorama.js?v=1.0.0';
import { detectPotatoMode } from './utils.js?v=1.0.0';
import { CONFIG } from './config.js?v=1.0.0';

export class MenuPanoBackground {
  /**
   * @param {string} containerId ID del elemento contenedor (#menu-pano-bg).
   * @param {object} options Opciones de configuración.
   */
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    if (!containerId || !this.container) {
      console.warn('[menu-pano] Contenedor no encontrado:', containerId);
    }

    this.options = {
      rotationSpeed: options.rotationSpeed || 1.5, // grados por segundo (suave y cinemático)
      changeInterval: options.changeInterval || 45, // segundos entre transiciones
      ...options,
    };

    this.coordinates = [];
    this.currentPanoIndex = -1;
    this.panorama = null;
    this.currentHeading = 0;
    this.running = false;
    this.isTransitioning = false;
    this.activeTime = 0; // tiempo acumulado en segundos con foco activo
    this.isPotato = detectPotatoMode();
    this.targetFps = this.isPotato ? 25 : 60;
    this.frameInterval = 1000 / this.targetFps;

    this._lastFrameTime = 0;
    this._rafId = null;
    this._startTimeout = null;
    this._initPromise = null;
    this._isTabActive = true;

    this._createDom();
    this._bindEvents();
    this._updateFocusState();
  }

  _createDom() {
    if (!this.container) return;
    this.container.innerHTML = '';

    // Contenedor interno donde se monta StreetView
    this.stageEl = document.createElement('div');
    this.stageEl.className = 'menu-pano-stage';
    this.container.appendChild(this.stageEl);

    // Viñeta oscura sutil para contraste estético de textos y tarjetas glassmorphism
    this.vignetteEl = document.createElement('div');
    this.vignetteEl.className = 'menu-pano-vignette';
    this.container.appendChild(this.vignetteEl);

    // Cortina negra para transiciones suaves imagen -> negro -> imagen
    this.curtainEl = document.createElement('div');
    this.curtainEl.className = 'menu-pano-curtain';
    this.container.appendChild(this.curtainEl);
  }

  _bindEvents() {
    this._boundFocusHandler = () => this._updateFocusState();
    window.addEventListener('focus', this._boundFocusHandler);
    window.addEventListener('blur', this._boundFocusHandler);
    document.addEventListener('visibilitychange', this._boundFocusHandler);

    this._boundResizeHandler = () => {
      if (this.panorama && window.google && window.google.maps) {
        window.google.maps.event.trigger(this.panorama, 'resize');
      }
    };
    window.addEventListener('resize', this._boundResizeHandler);
  }

  _updateFocusState() {
    const wasActive = this._isTabActive;
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;
    this._isTabActive = !document.hidden && hasFocus;

    if (!wasActive && this._isTabActive) {
      // Reanuda el tiempo de frame para evitar saltos bruscos de delta-time
      this._lastFrameTime = performance.now();
    }
  }

  /**
   * Asigna la lista de coordenadas válidas para elegir panorámicas aleatorias.
   * @param {Array<object>} coords 
   */
  setCoordinates(coords) {
    if (Array.isArray(coords) && coords.length > 0) {
      this.coordinates = coords;
      // Si el panorama ya se había instanciado pero no tenía coordenadas para arrancar:
      if (this.panorama && (this.currentPanoIndex === -1 || !this.panorama.getPano())) {
        const item = this._getRandomItem();
        if (item) {
          if (item.pano_id) this.panorama.setPano(item.pano_id);
          else if (item.lat && item.lng) this.panorama.setPosition({ lat: Number(item.lat), lng: Number(item.lng) });
        }
      }
    }
  }

  /**
   * Inicializa Google Maps y el visor de Street View ambiental.
   */
  async init(coords = null) {
    if (coords) this.setCoordinates(coords);
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        const maps = await loadGoogleMaps();
        if (!this.stageEl) return;

        // Si aún no tenemos coordenadas cargadas, usar fallback inicial instantáneo
        // sin bloquear la red con un fetch duplicado (app.js cargará la lista completa en paralelo).
        if (!this.coordinates.length) {
          this.coordinates = [{ lat: 21.7837685, lng: -103.2954777, pano_id: 'rN89gpZf7j3437qMq8OoiQ' }];
        }

        const initialItem = this._getRandomItem();
        this.currentHeading = Math.floor(Math.random() * 360);

        this.panorama = new maps.StreetViewPanorama(this.stageEl, {
          pov: { heading: this.currentHeading, pitch: 0 },
          zoom: 0,
          visible: true,
          addressControl: false,
          linksControl: false,
          clickToGo: false,
          showRoadLabels: false,
          motionTracking: false,
          motionTrackingControl: false,
          fullscreenControl: false,
          zoomControl: false,
          panControl: false,
          enableCloseButton: false,
          scrollwheel: false,
          disableDefaultUI: true,
          disableDoubleClickZoom: true,
        });

        if (initialItem && initialItem.pano_id) {
          this.panorama.setPano(initialItem.pano_id);
        } else if (initialItem && initialItem.lat && initialItem.lng) {
          this.panorama.setPosition({ lat: Number(initialItem.lat), lng: Number(initialItem.lng) });
        }

        // Recuperación silenciosa si un pano_id devuelve error en Google
        this.panorama.addListener('status_changed', () => {
          const status = this.panorama.getStatus();
          if (status !== 'OK' && status !== 'LOADING' && status !== 'UNKNOWN') {
            console.warn('[menu-pano] Pano status no es OK (' + status + '). Cambiando a otro pano...');
            const fallback = this._getRandomItem();
            if (fallback) {
              if (fallback.pano_id) {
                this.panorama.setPano(fallback.pano_id);
              } else if (fallback.lat && fallback.lng) {
                this.panorama.setPosition({ lat: Number(fallback.lat), lng: Number(fallback.lng) });
              }
            }
          }
        });

        // Asegurar que la cortina negra no bloquee la vista inicial
        if (this.curtainEl) {
          this.curtainEl.classList.remove('fade-black');
        }
        this.isTransitioning = false;

        return this.panorama;
      } catch (err) {
        console.warn('[menu-pano] Error al inicializar visor ambiental:', err);
        throw err;
      }
    })();

    return this._initPromise;
  }

  _getRandomItem() {
    if (!this.coordinates || !this.coordinates.length) return null;
    let idx = Math.floor(Math.random() * this.coordinates.length);
    if (this.coordinates.length > 1 && idx === this.currentPanoIndex) {
      idx = (idx + 1) % this.coordinates.length;
    }
    this.currentPanoIndex = idx;
    return this.coordinates[idx];
  }

  /**
   * Inicia o reanuda la rotación del fondo panorámico en menús.
   */
  async start() {
    if (this.container) {
      this.container.classList.remove('hidden');
    }
    this.running = true;
    this.isTransitioning = false;
    if (this.curtainEl) {
      this.curtainEl.classList.remove('fade-black');
    }
    this._updateFocusState();

    if (!this.panorama) {
      try {
        await this.init();
      } catch (e) {
        // Fallback silencioso
        return;
      }
    }

    if (this.panorama && window.google && window.google.maps) {
      this.panorama.setVisible(true);
      window.google.maps.event.trigger(this.panorama, 'resize');
      requestAnimationFrame(() => {
        if (this.panorama && window.google && window.google.maps) {
          window.google.maps.event.trigger(this.panorama, 'resize');
        }
      });
    }

    if (!this._rafId && !this._startTimeout) {
      this._lastFrameTime = performance.now();
      // Pausa breve (1.2s) para que Street View cargue únicamente los 2-3 azulejos frontales
      // sin saturar el canal de red pidiendo 360° a la vez durante el arranque de la página.
      this._startTimeout = setTimeout(() => {
        this._startTimeout = null;
        if (this.running && !this._rafId) {
          this._lastFrameTime = performance.now();
          this._loop(this._lastFrameTime);
        }
      }, 1200);
    }
  }

  /**
   * Detiene por completo la animación y el consumo de GPU/CPU (p. ej. durante las partidas).
   */
  stop() {
    this.running = false;
    this.isTransitioning = false;
    if (this._startTimeout) {
      clearTimeout(this._startTimeout);
      this._startTimeout = null;
    }
    if (this.curtainEl) {
      this.curtainEl.classList.remove('fade-black');
    }
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.container) {
      this.container.classList.add('hidden');
    }
  }

  /**
   * Bucle principal de animación y acumulación de tiempo activo.
   */
  _loop(now) {
    if (!this.running) {
      this._rafId = null;
      return;
    }

    const elapsed = now - this._lastFrameTime;
    const dt = Math.min(0.1, elapsed / 1000); // delta en segundos (seguro ante desfases)
    this._lastFrameTime = now;

    // Solo rotar y avanzar temporizador si la pestaña está activa y visible
    if (this._isTabActive && this.panorama && !this.isTransitioning) {
      // 1. Rotación suave de derecha a izquierda:
      // Al aumentar el heading (rumbo a la derecha), los objetos visualmente se desplazan hacia la izquierda.
      this.currentHeading = (this.currentHeading + this.options.rotationSpeed * dt) % 360;
      this.panorama.setPov({ heading: this.currentHeading, pitch: 0 });

      // 2. Temporizador acumulativo para el cambio de panorámica (45 s activos)
      this.activeTime += dt;
      if (this.activeTime >= this.options.changeInterval) {
        this.activeTime = 0;
        this._transitionToRandomPano();
      }
    }

    this._rafId = requestAnimationFrame((t) => this._loop(t));
  }

  /**
   * Realiza la transición sutil: imagen -> fundido a negro -> cambio de pano -> fundido desde negro.
   */
  async _transitionToRandomPano() {
    if (this.isTransitioning || !this.panorama || !this.coordinates.length) return;
    this.isTransitioning = true;

    // Timeout de seguridad: pase lo que pase, la cortina no puede quedar negra más de 3 segundos
    const safetyTimeout = setTimeout(() => {
      if (this.curtainEl) this.curtainEl.classList.remove('fade-black');
      this.isTransitioning = false;
    }, 3000);

    try {
      // 1. Fundido a negro (fade out)
      if (this.curtainEl) {
        this.curtainEl.classList.add('fade-black');
      }
      // Esperar a que la cortina negra cubra suavemente la pantalla (800ms)
      await new Promise((r) => setTimeout(r, 850));

      // 2. Si durante el fade-out la pestaña perdió foco o el juego inició, abortar cambio
      if (!this.running || !this._isTabActive) {
        if (this.curtainEl) this.curtainEl.classList.remove('fade-black');
        this.isTransitioning = false;
        return;
      }

      // 3. Cambiar la panorámica en la oscuridad
      const nextItem = this._getRandomItem();
      if (nextItem && nextItem.pano_id) {
        this.panorama.setPano(nextItem.pano_id);
      } else if (nextItem && nextItem.lat && nextItem.lng) {
        this.panorama.setPosition({ lat: Number(nextItem.lat), lng: Number(nextItem.lng) });
      }

      // Añadir una ligera variación aleatoria al heading inicial para perspectiva fresca
      this.currentHeading = Math.floor(Math.random() * 360);
      this.panorama.setPov({ heading: this.currentHeading, pitch: 0 });

      // Pequeña pausa en negro para permitir que Google Maps renderice las teselas del nuevo pano
      await new Promise((r) => setTimeout(r, 450));

      // 4. Fundido desde negro (fade in) revelando la nueva panorámica
      if (this.curtainEl) {
        this.curtainEl.classList.remove('fade-black');
      }
      // Esperar a que concluya la transición visual
      await new Promise((r) => setTimeout(r, 900));
    } catch (err) {
      console.warn('[menu-pano] Error en transición de pano:', err);
      if (this.curtainEl) this.curtainEl.classList.remove('fade-black');
    } finally {
      clearTimeout(safetyTimeout);
      this.isTransitioning = false;
      if (this.curtainEl) this.curtainEl.classList.remove('fade-black');
    }
  }

  destroy() {
    this.stop();
    window.removeEventListener('focus', this._boundFocusHandler);
    window.removeEventListener('blur', this._boundFocusHandler);
    document.removeEventListener('visibilitychange', this._boundFocusHandler);
    window.removeEventListener('resize', this._boundResizeHandler);
    if (this.container) {
      this.container.innerHTML = '';
    }
  }
}
