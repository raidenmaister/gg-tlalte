// ============================================================================
// audio.js — Efectos de sonido sintetizados con WebAudio (sin archivos).
// ============================================================================

class AudioManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.master = null;
  }

  /** Crea/resume el AudioContext (debe llamarse tras un gesto del usuario). */
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  toggle() {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  /**
   * Tono básico con envolvente (attack/decay).
   * @param {number} freq Frecuencia en Hz.
   * @param {number} dur  Duración en segundos.
   * @param {string} type Forma de onda.
   * @param {number} gain Ganancia.
   * @param {number} when Offset de inicio (s).
   */
  tone(freq, dur = 0.15, type = 'sine', gain = 0.6, when = 0) {
    if (!this.enabled) return;
    this.ensure();
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  click() {
    this.tone(720, 0.06, 'square', 0.25);
  }

  place() {
    this.tone(560, 0.09, 'sine', 0.4);
    this.tone(840, 0.07, 'sine', 0.3, 0.05);
  }

  confirm() {
    this.tone(440, 0.12, 'sawtooth', 0.3);
    this.tone(660, 0.16, 'sawtooth', 0.3, 0.1);
  }

  countdownTick() {
    this.tone(880, 0.08, 'square', 0.3);
  }

  finalTick() {
    this.tone(1240, 0.16, 'square', 0.35);
  }

  roundWin() {
    this.tone(523, 0.12, 'triangle', 0.5);
    this.tone(659, 0.12, 'triangle', 0.5, 0.1);
    this.tone(784, 0.22, 'triangle', 0.5, 0.2);
  }

  roundLose() {
    this.tone(392, 0.18, 'sawtooth', 0.35);
    this.tone(311, 0.24, 'sawtooth', 0.35, 0.14);
  }

  damage() {
    this.tone(180, 0.2, 'sawtooth', 0.5);
    this.tone(120, 0.28, 'sawtooth', 0.4, 0.08);
  }

  victory() {
    const seq = [523, 659, 784, 1047];
    seq.forEach((f, i) => this.tone(f, 0.28, 'triangle', 0.55, i * 0.14));
  }

  defeat() {
    const seq = [392, 349, 311, 262];
    seq.forEach((f, i) => this.tone(f, 0.32, 'sawtooth', 0.4, i * 0.18));
  }

  error() {
    this.tone(220, 0.16, 'square', 0.3);
    this.tone(180, 0.2, 'square', 0.3, 0.1);
  }

  join() {
    this.tone(660, 0.1, 'sine', 0.4);
    this.tone(880, 0.14, 'sine', 0.4, 0.08);
  }
}

export const audio = new AudioManager();
