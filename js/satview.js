// ============================================================================
// satview.js — Visor del modo «Ojo de Halcón».
//
// Muestra a pantalla completa una imagen satelital con zoom máximo, girada a un
// ángulo aleatorio y sin brújula. La imagen la compone el servidor (api.php),
// así que el navegador nunca conoce las coordenadas del lugar antes de adivinar.
// ============================================================================

/** Metros de terreno que abarca cada foto del banco (zoom 19, 1024 px ≈ 280 m). */
export const SAT_FULL_M = 280;

export class SatelliteView {
  constructor(id = 'satView') {
    this.id = id;
    this.el = null;
    this.img = null;
    this.rotation = 0;
    this.zoomM = SAT_FULL_M;
    this._loadToken = 0;
    this._onResize = () => this._layout();
  }

  _ensure() {
    if (this.el) return;
    this.el = document.getElementById(this.id);
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.id = this.id;
      const game = document.getElementById('screen-game');
      (game || document.body).appendChild(this.el);
    }
    this.el.classList.add('sat-view', 'hidden');
    this.el.innerHTML = `
      <div class="sat-stage"><img class="sat-img" alt="" draggable="false"></div>
      <div class="sat-vignette"></div>
      <div class="sat-crosshair" aria-hidden="true"><span></span></div>
      <div class="sat-tag">🛰️ OJO DE HALCÓN · ¿Dónde está el centro de esta imagen?</div>`;
    this.img = this.el.querySelector('.sat-img');
    this.img.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', this._onResize);
  }

  /** Escala la imagen para que, girada, siga cubriendo toda la pantalla. */
  _layout() {
    if (!this.el || !this.img) return;
    const w = this.el.clientWidth || window.innerWidth;
    const h = this.el.clientHeight || window.innerHeight;
    const diag = Math.sqrt(w * w + h * h);
    // Zoom elegido: la diagonal de la pantalla abarca `zoomM` metros (280 m = foto completa).
    const zoomM = Math.max(150, Math.min(SAT_FULL_M, Number(this.zoomM) || SAT_FULL_M));
    const size = Math.ceil(diag * 1.02 * (SAT_FULL_M / zoomM));
    this.img.style.width = `${size}px`;
    this.img.style.height = `${size}px`;
    this.img.style.transform = `translate(-50%, -50%) rotate(${this.rotation}deg)`;
  }

  /**
   * Carga la imagen de la ronda con un reintento; si falla, consulta al servidor el
   * motivo exacto para mostrarlo al jugador.
   */
  async load(url, rotation = 0, zoomM = SAT_FULL_M) {
    this.zoomM = Number(zoomM) || SAT_FULL_M;
    try {
      return await this._loadOnce(url, rotation);
    } catch (firstErr) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        return await this._loadOnce(`${url}&retry=${Date.now()}`, rotation);
      } catch (err) {
        let reason = '';
        try {
          const res = await fetch(`${url}&diag=${Date.now()}`, { cache: 'no-store' });
          if ((res.headers.get('content-type') || '').includes('json')) {
            const json = await res.json();
            reason = json && json.error ? json.error : '';
          }
        } catch (e) {}
        throw new Error(reason || (err && err.message) || 'No se pudo cargar la vista satelital');
      }
    }
  }

  _loadOnce(url, rotation = 0) {
    this._ensure();
    const token = ++this._loadToken;
    this.rotation = Number(rotation) || 0;
    this.el.classList.remove('hidden');
    this.el.classList.add('loading');
    document.body.classList.add('is-sat-mode');
    this._layout();
    return new Promise((resolve, reject) => {
      const probe = new Image();
      probe.decoding = 'async';
      let done = false;
      const finish = (ok, err) => {
        if (done) return;
        done = true;
        if (token !== this._loadToken) return resolve(false);
        if (ok) {
          this.img.src = probe.src;
          this.el.classList.remove('loading');
          this._layout();
          resolve(true);
        } else {
          reject(err || new Error('No se pudo cargar la vista satelital'));
        }
      };
      probe.onload = () => {
        if (probe.decode) probe.decode().then(() => finish(true), () => finish(true));
        else finish(true);
      };
      probe.onerror = () => finish(false);
      setTimeout(() => finish(false, new Error('La vista satelital tardó demasiado')), 45000);
      probe.src = url;
    });
  }

  show() {
    this._ensure();
    this.el.classList.remove('hidden');
    document.body.classList.add('is-sat-mode');
    this._layout();
  }

  hide() {
    this._loadToken++;
    document.body.classList.remove('is-sat-mode');
    if (!this.el) return;
    this.el.classList.add('hidden');
    this.el.classList.remove('loading');
    if (this.img) this.img.removeAttribute('src');
  }
}

export const satView = new SatelliteView('satView');
