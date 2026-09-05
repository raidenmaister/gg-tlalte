// ============================================================================
// game.js — Máquina de estados del juego: rondas, puntuación, HP y daño.
//
// Eventos emitidos hacia la UI (app.js):
//   'data'        {count}                         coordenadas cargadas
//   'hud'         {mode, round, total, me, players, multiplier}
//   'timer'       {seconds, danger}
//   'confirm'     {enabled}                       botón confirmar habilitado
//   'waiting'     {waiting}                       ya adiviné, espero a los demás
//   'prepare'     {seconds|null}
//   'result'      result                          resumen de ronda
//   'gameover'    result                          fin de partida
//   'toast'       {message, kind}
// ============================================================================

import { CONFIG, damageMultiplier, getNoGuessPenalty } from './config.js?v=1.7.7';
import {
  haversineKm,
  scoreForDistance,
  scoreForDistanceTunnel,
  scoreForDistanceBlur,
  computeDamage,
  pickIndices,
  pickSeparatedIndices,
  clamp,
} from './utils.js?v=1.7.7';

export class Game {
  constructor({ pano, map, net, audio }) {
    this.pano = pano;
    this.map = map;
    this.net = net;
    this.audio = audio;

    this._listeners = {};
    this.coordenadas = [];
    this.meName = '';

    this.mode = 'solo'; // 'solo' | 'multi'
    this.role = 'solo'; // 'solo' | 'host' | 'guest'
    this.state = 'idle';

    this.gameMode = 'normal'; // 'normal' | 'static' | 'temporal' | 'tunnel' | 'static_tunnel' | 'blur' | 'static_blur'
    this.zoomMode = false;
    this.blurMode = false;
    this.temporalSeconds = CONFIG.DEFAULT_TEMPORAL_SECONDS || 3;
    this.tunnelSeconds = CONFIG.DEFAULT_TUNNEL_SECONDS || 3;
    this.blurSeconds = CONFIG.DEFAULT_BLUR_SECONDS || 3;
    this.currentZoomStep = 4;
    this.currentBlurPhase = 1;
    this._tunnelTimer = null;
    this._tunnelStartTime = null;
    this._blurTimer = null;
    this._blurStartTime = null;
    this.soloPerfectStreak = 0;

    this.rounds = CONFIG.SOLO_ROUNDS;
    this.soloTotalSeconds = CONFIG.SOLO_MODES[CONFIG.SOLO_ROUNDS].totalSeconds;
    this.soloRemainingSeconds = 0;
    this.soloRoundStartTime = 0;
    this.soloTotalPlayedMs = 0;
    this.soloStartTime = 0;
    this.soloTimedOut = false;
    this.currentRound = 0;
    this.locations = [];      // índices dentro de coordenadas
    this.roundHeading = 0;
    this.currentCoord = null;

    this.myGuess = null;
    this.roundEnd = 0;

    // Multijugador
    this.players = [];        // [{id,name,score,hp,guess,guessed}]

    // Solo (para no romper el leaderboard)
    this.scores = { me: 0 };

    this._resolved = false;
    this._over = false;
    this._hostStarted = false;
    this._roundActive = false;
    this._readyCount = 0;
    this._master = null;
    this._tick = null;
    this._prepare = null;
    this._resultTimer = null;
    this._hurry = null;
    this.hurryEnd = 0;
    this._temporalTimer = null;
    this._panoReadyPeers = new Set();
    this._syncTimeout = null;
    this._syncStartedRound = null;
    this._roundSyncStarted = null;

    this._guestReady = true;       // se pone a false durante guestOnStart hasta que esté listo
    this._pendingRoundStart = null; // encola mensajes si llegan antes de que el guest esté listo
    this._pendingHurryStart = null;
    this._pendingRoundResult = null;
    this._pendingGameOver = null;
    this._forfeitTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* Emisor de eventos                                                   */
  /* ------------------------------------------------------------------ */
  on(name, cb) {
    (this._listeners[name] = this._listeners[name] || []).push(cb);
  }
  emit(name, detail) {
    (this._listeners[name] || []).forEach((cb) => {
      try {
        cb(detail);
      } catch (e) {
        console.error(`[game] handler "${name}"`, e);
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Datos                                                               */
  /* ------------------------------------------------------------------ */
  async loadData() {
    const res = await fetch(CONFIG.COORDINATES_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    this.coordenadas = await res.json();
    if (!Array.isArray(this.coordenadas) || !this.coordenadas.length) {
      throw new Error('Sin coordenadas');
    }
    this.emit('data', { count: this.coordenadas.length });
    return this.coordenadas;
  }

  /* ------------------------------------------------------------------ */
  /* Inicio de partidas                                                  */
  /* ------------------------------------------------------------------ */
  startSolo(rounds = CONFIG.SOLO_ROUNDS, gameMode = 'normal', temporalSeconds = CONFIG.DEFAULT_TEMPORAL_SECONDS, tunnelSeconds = CONFIG.DEFAULT_TUNNEL_SECONDS, zoomMode = false, blurSeconds = CONFIG.DEFAULT_BLUR_SECONDS, blurMode = false) {
    const mode = CONFIG.SOLO_MODES[rounds] || CONFIG.SOLO_MODES[CONFIG.SOLO_ROUNDS];
    this._reset();
    this.mode = 'solo';
    this.role = 'solo';
    this.gameMode = gameMode || 'normal';
    this.zoomMode = !!zoomMode || this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel';
    this.blurMode = !!blurMode || this.gameMode === 'blur' || this.gameMode === 'static_blur';
    this.temporalSeconds = Number(temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
    this.tunnelSeconds = Number(tunnelSeconds) || CONFIG.DEFAULT_TUNNEL_SECONDS;
    this.blurSeconds = Number(blurSeconds) || CONFIG.DEFAULT_BLUR_SECONDS;
    this.soloPerfectStreak = 0;
    this.rounds = mode.rounds;
    let totalSecs = mode.totalSeconds;
    if (this.zoomMode || this.blurMode) {
      totalSecs += (CONFIG.SOLO_BONUS_SECONDS_ZOOM_BLUR || 60);
    }
    this.soloTotalSeconds = totalSecs;
    this.soloRemainingSeconds = totalSecs;
    this.soloStartTime = 0;
    this.soloRoundStartTime = 0;
    this.soloTotalPlayedMs = 0;
    // Selección aleatoria garantizando al menos 161m entre TODOS los panos de la partida
    this.locations = pickSeparatedIndices(this.coordenadas, this.rounds, CONFIG.MIN_LOCATION_SEPARATION_KM || 0.161);
    this._beginRound(1);
  }

  /** Host: inicia la partida y envía la semilla/orden a los invitados. */
  hostStart(gameMode = 'normal', temporalSeconds = CONFIG.DEFAULT_TEMPORAL_SECONDS, tunnelSeconds = CONFIG.DEFAULT_TUNNEL_SECONDS, zoomMode = false, blurSeconds = CONFIG.DEFAULT_BLUR_SECONDS, blurMode = false) {
    this._reset();
    this.mode = 'multi';
    this.role = 'host';
    this.gameMode = gameMode || 'normal';
    this.zoomMode = !!zoomMode || this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel';
    this.blurMode = !!blurMode || this.gameMode === 'blur' || this.gameMode === 'static_blur';
    this.temporalSeconds = Number(temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
    this.tunnelSeconds = Number(tunnelSeconds) || CONFIG.DEFAULT_TUNNEL_SECONDS;
    this.blurSeconds = Number(blurSeconds) || CONFIG.DEFAULT_BLUR_SECONDS;
    this.rounds = this.net.rounds || CONFIG.DUEL_ROUNDS;

    this.players = this.net.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hp: CONFIG.MAX_HP,
      guess: null,
      guessed: false,
      perfectStreak: 0,
    }));

    // No permitir iniciar un duelo si el anfitrión está solo
    if (this.players.length <= 1) {
      this.emit('toast', { message: 'Se necesitan al menos 2 jugadores para iniciar.', kind: 'error' });
      return;
    }

    const seed = (Math.random() * 0xffffffff) >>> 0;
    // Selección aleatoria garantizando al menos 161m entre TODOS los panos de la partida
    this.locations = pickSeparatedIndices(this.coordenadas, this.rounds, CONFIG.MIN_LOCATION_SEPARATION_KM || 0.161);

    this.net.broadcast({
      type: 'start',
      seed,
      rounds: this.rounds,
      locations: this.locations,
      mode: 'multi',
      gameMode: this.gameMode,
      zoomMode: this.zoomMode,
      blurMode: this.blurMode,
      temporalSeconds: this.temporalSeconds,
      tunnelSeconds: this.tunnelSeconds,
      blurSeconds: this.blurSeconds,
      players: this.players.map((p) => ({ id: p.id, name: p.name })),
    });

    this._hostStarted = true;
    this.emit('toast', { message: 'Iniciando partida…', kind: 'info' });

    // Iniciar ronda 1 tras 1000ms o cuando todos los jugadores reporten 'ready'
    clearTimeout(this._readyTimer);
    this._readyTimer = setTimeout(() => {
      this._beginRound(1);
    }, 1000);
  }

  /** Guest: recibe el mensaje 'start' del host. */
  guestOnStart(data) {
    this._reset();
    this.mode = 'multi';
    this.role = 'guest';
    this.gameMode = data.gameMode || 'normal';
    this.zoomMode = !!data.zoomMode || this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel';
    this.blurMode = !!data.blurMode || this.gameMode === 'blur' || this.gameMode === 'static_blur';
    this.temporalSeconds = Number(data.temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
    this.tunnelSeconds = Number(data.tunnelSeconds) || CONFIG.DEFAULT_TUNNEL_SECONDS;
    this.blurSeconds = Number(data.blurSeconds) || CONFIG.DEFAULT_BLUR_SECONDS;
    this.rounds = data.rounds || CONFIG.DUEL_ROUNDS;
    this.locations = data.locations || [];
    this.players = (data.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hp: CONFIG.MAX_HP,
      guess: null,
      guessed: false,
      perfectStreak: 0,
    }));
    const myClean = (this.meName || '').trim().toLowerCase();
    const mePlayer = this.players.find((p) => (p.name || '').trim().toLowerCase() === myClean);
    if (mePlayer && mePlayer.id) {
      this.net.myId = mePlayer.id;
    }
    this.emit('toast', { message: '¡Comienza la partida!', kind: 'info' });
    this._guestReady = false;
    this._pendingRoundStart = null;
    this._pendingSyncStart = null;
    this._pendingHurryStart = null;
    this._pendingRoundResult = null;
    this._pendingGameOver = null;
  }

  /** Guest: marca que los datos y visores están listos; procesa mensajes pendientes en orden. */
  guestSetReady() {
    this._guestReady = true;
    if (this._pendingGameOver) {
      const data = this._pendingGameOver;
      this._pendingRoundStart = null;
      this._pendingSyncStart = null;
      this._pendingHurryStart = null;
      this._pendingRoundResult = null;
      this._pendingGameOver = null;
      this._onGameOver(data);
      return;
    }
    if (this._pendingRoundResult) {
      const data = this._pendingRoundResult;
      this._pendingRoundStart = null;
      this._pendingSyncStart = null;
      this._pendingHurryStart = null;
      this._pendingRoundResult = null;
      this._onRoundResult(data);
      return;
    }
    if (this._pendingRoundStart) {
      const data = this._pendingRoundStart;
      this._pendingRoundStart = null;
      this.handleNetworkMessage(data, null);
    }
    if (this._pendingSyncStart) {
      const sync = this._pendingSyncStart;
      this._pendingSyncStart = null;
      this._onSyncStart(sync);
    }
    if (this._pendingHurryStart) {
      const hurry = this._pendingHurryStart;
      this._pendingHurryStart = null;
      this._onHurryStart(hurry);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bucle de rondas (común)                                             */
  /* ------------------------------------------------------------------ */
  _reset() {
    this._clearTimers();
    this._clearTemporal();
    this._clearTunnelProgression();
    this._clearBlurProgression();
    if (this._guestBlindFailsafe) {
      clearTimeout(this._guestBlindFailsafe);
      this._guestBlindFailsafe = null;
    }
    if (this._syncTimeout) {
      clearTimeout(this._syncTimeout);
      this._syncTimeout = null;
    }
    this._panoReadyPeers = new Set();
    this.currentRound = 0;
    this.locations = [];
    this.myGuess = null;
    this.players = [];
    this.scores = { me: 0 };
    this.soloPerfectStreak = 0;
    this._resolved = false;
    this._lastResolvedAt = 0;
    if (this.net && typeof this.net.setAwaitingGuesses === 'function') {
      this.net.setAwaitingGuesses(false);
    }
    this._over = false;
    this._hostStarted = false;
    this._roundActive = false;
    this._readyCount = 0;
    this.currentCoord = null;
    this.soloTimedOut = false;
    this.soloStartTime = 0;
    this.soloRemainingSeconds = 0;
    this.soloRoundStartTime = 0;
    this.soloTotalPlayedMs = 0;
    this.state = 'idle';
    this._guestReady = true;
    this._pendingRoundStart = null;
    this._pendingHurryStart = null;
    this._pendingRoundResult = null;
    this._pendingGameOver = null;
    if (this.pano) {
      this.pano.setBlind(false);
      this.pano.setStatic(false);
      this.pano.setTunnelMode(false);
      this.pano.setBlurMode(false);
    }
  }

  _beginRound(round) {
    this.currentRound = round;
    this.state = 'playing';
    this._resolved = false;
    this._roundActive = false;
    this._syncStartedRound = null;
    this._roundSyncStarted = null;
    this.myGuess = null;
    this._clearTemporal();
    this._clearTunnelProgression();
    this._clearBlurProgression();

    this.players.forEach((p) => {
      p.guess = null;
      p.guessed = false;
      p._preRoundHp = typeof p.hp === 'number' ? p.hp : CONFIG.MAX_HP;
      p._preRoundScore = typeof p.score === 'number' ? p.score : 0;
    });

    const idx = this.locations[round - 1];
    const coord = this.coordenadas[idx];
    this.currentCoord = coord;

    if (this.role !== 'guest') {
      this.roundHeading = Math.floor(Math.random() * 360);
    }

    // Cortina de carga activa ANTES de emitir HUD para que al colapsar el minimapa no se filtre la imagen
    this.pano.setBlind(true, 'Ronda ' + round, 'Cargando ubicación en alta definición…', true);
    this.pano.setPano(coord.pano_id, this.roundHeading, 0, coord);

    // Configurar modo estático/bloqueo de arrastre (modos estático y temporal)
    const isStatic = this.gameMode === 'static' || this.gameMode === 'static_tunnel' || this.gameMode === 'static_blur' || (this.gameMode === 'static' && (this.zoomMode || this.blurMode));
    const isBlur = this.gameMode === 'blur' || this.gameMode === 'static_blur' || this.blurMode;
    const isTunnel = this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel' || this.zoomMode;

    if (isBlur) {
      this.pano.setBlurMode(true);
    } else if (isTunnel) {
      this.pano.setTunnelMode(true);
    }
    this.pano.setStatic(isStatic || this.gameMode === 'temporal');
    this.map.reset();

    // Asignar el color real de la chincheta según el jugador (Req 7)
    if (this.mode === 'solo') {
      this.map.setMyColor(CONFIG.PLAYER_COLORS[0]);
    } else {
      const myIndex = this.players.findIndex((p) => p.id === this.net.myId);
      const assignedColor = CONFIG.PLAYER_COLORS[myIndex >= 0 ? myIndex % CONFIG.PLAYER_COLORS.length : 0];
      this.map.setMyColor(assignedColor);
    }

    this.map.setInteractive(true);

    this.emit('waiting', { waiting: false });
    this.emit('confirm', { enabled: false });
    this.emit('temporalBlind', { active: false });
    this.emit('temporalTimer', { seconds: null });
    this._emitHud();

    if (this.mode === 'solo') {
      this.pano.waitForReady(2500)
        .catch(() => {})
        .then(() => {
          if (this.state !== 'playing' || this.currentRound !== round) return;
          this.pano.refresh();
          this.pano.setBlind(false);
          this._startSoloRoundTimer(round);
          if (this.gameMode === 'temporal') {
            this._startTemporalCountdown(this.temporalSeconds);
          } else if (isTunnel) {
            this._startTunnelProgression(this.tunnelSeconds);
          } else if (isBlur) {
            this._startBlurProgression(this.blurSeconds);
          }
        });
      return;
    }

    if (this.role === 'host') {
      if (this.net && typeof this.net.setAwaitingGuesses === 'function') {
        this.net.setAwaitingGuesses(true);
      }
      this._panoReadyPeers = new Set();
      if (this._syncTimeout) clearTimeout(this._syncTimeout);

      // Notificar a los invitados para que preparen y carguen la misma vista
      this.net.broadcast({
        type: 'roundStart',
        round,
        locationIndex: idx,
        coord,
        heading: this.roundHeading,
        gameMode: this.gameMode,
        zoomMode: this.zoomMode,
        blurMode: this.blurMode,
        temporalSeconds: this.temporalSeconds,
        tunnelSeconds: this.tunnelSeconds,
        blurSeconds: this.blurSeconds,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          hp: typeof p.hp === 'number' && !isNaN(p.hp) ? p.hp : CONFIG.MAX_HP,
          score: p.score || 0,
          perfectStreak: p.perfectStreak || 0,
        })),
      });

      // El anfitrión también espera a que su visor decodifique
      this.pano.waitForReady(2500)
        .catch(() => {})
        .then(() => {
          this._panoReadyPeers.add(this.net.myId);
          this._checkAllPanoReady(round);
        });

      // Margen de sincronización ultra ágil: máximo 1200ms para no demorar la partida si un rival tiene conexión lenta
      this._syncTimeout = setTimeout(() => {
        this._triggerSyncStart(round);
      }, 1200);
    }
  }

  /** Host: comprueba si todos los jugadores reportaron imagen lista para dar la salida al unísono. */
  _checkAllPanoReady(round) {
    if (this.role !== 'host' || this._resolved || this.currentRound !== round) return;
    if (this._syncStartedRound === round) return;
    const targetCount = this.players.length;
    if (this._panoReadyPeers.size >= targetCount) {
      if (this._syncTimeout) {
        clearTimeout(this._syncTimeout);
        this._syncTimeout = null;
      }
      this._triggerSyncStart(round);
    }
  }

  /** Host: emite la señal de salida sincronizada a todos los jugadores. */
  _triggerSyncStart(round) {
    if (this.role !== 'host' || this._resolved || this.currentRound !== round) return;
    if (this._syncStartedRound === round) return;
    this._syncStartedRound = round;
    if (this._syncTimeout) {
      clearTimeout(this._syncTimeout);
      this._syncTimeout = null;
    }
    const prepSecs = CONFIG.PREPARE_DURATION || 3;
    this.net.broadcast({
      type: 'syncStart',
      round,
      prepareSeconds: prepSecs,
    });
    // Re-emisión preventiva para amortiguar pérdidas esporádicas de paquetes WebRTC en clientes móviles/inestables
    setTimeout(() => {
      if (this.role === 'host' && this.currentRound === round && !this._resolved) {
        this.net.broadcast({
          type: 'syncStart',
          round,
          prepareSeconds: prepSecs,
        });
      }
    }, 150);
    this._onSyncStart({ round, prepareSeconds: prepSecs });
  }

  _onSyncStart(data) {
    const round = data.round != null ? data.round : this.currentRound;
    if (this._roundSyncStarted === round && this._roundActive) return;
    this._roundSyncStarted = round;
    this.currentRound = round;
    if (this._guestBlindFailsafe) {
      clearTimeout(this._guestBlindFailsafe);
      this._guestBlindFailsafe = null;
    }
    this.pano.refresh();
    const prepSecs = data.prepareSeconds || 3;
    this.pano.setBlind(true, '¡Prepárate!', `La imagen se mostrará en ${prepSecs} segundos`, false);
    this._startPrepare(prepSecs, this.currentRound);
  }

  /** Arranca la fase de adivinar en solitario. */
  _startSoloRoundTimer(round) {
    if (this.state !== 'playing' || this.currentRound !== round) return;
    this._activateRound(round);
  }

  /**
   * Fase "prepárate": cuenta atrás fija de 3 segundos sincronizada.
   */
  _startPrepare(durationSeconds, round) {
    this._clearPrepare();
    let left = durationSeconds || CONFIG.PREPARE_DURATION || 3;
    this.emit('prepare', { seconds: left });

    this._prepare = setInterval(() => {
      left--;
      if (left > 0) {
        this.emit('prepare', { seconds: left });
        this.pano.setBlind(true, '¡Prepárate!', `La imagen se mostrará en ${left} segundos`, false);
      } else {
        this._clearPrepare();
        // Forzar visibilidad y resize del StreetView al destapar
        this.pano.refresh();
        this.pano.setBlind(false);
        this._activateRound(round);
        const isTunnel = this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel' || this.zoomMode;
        const isBlur = this.gameMode === 'blur' || this.gameMode === 'static_blur' || this.blurMode;
        if (this.gameMode === 'temporal') {
          this._startTemporalCountdown(this.temporalSeconds);
        } else if (isTunnel) {
          this._startTunnelProgression(this.tunnelSeconds);
        } else if (isBlur) {
          this._startBlurProgression(this.blurSeconds);
        }
      }
    }, 1000);
  }

  _clearPrepare() {
    if (this._prepare) {
      clearInterval(this._prepare);
      this._prepare = null;
    }
    this.emit('prepare', { seconds: null });
  }

  /** Temporizador de cuenta atrás para el modo temporal. */
  _startTemporalCountdown(seconds) {
    this._clearTemporal();
    let left = seconds;
    this.emit('temporalTimer', { seconds: left });
    this._temporalTimer = setInterval(() => {
      left--;
      if (left > 0) {
        this.emit('temporalTimer', { seconds: left });
      } else {
        this._clearTemporal();
        this.emit('temporalTimer', { seconds: 0 });
        // Ocultar imagen y expandir automáticamente el minimapa
        this.pano.setBlind(true, '⏱️ Imagen oculta', 'Coloca tu chincheta en el mapa');
        this.emit('temporalBlind', { active: true });
      }
    }, 1000);
  }

  _clearTemporal() {
    if (this._temporalTimer) {
      clearInterval(this._temporalTimer);
      this._temporalTimer = null;
    }
    this.emit('temporalTimer', { seconds: null });
  }

  /** Progresión de zoom del Modo Zoom Progresivo (Visión Túnel). */
  _startTunnelProgression(secondsPerStep) {
    this._clearTunnelProgression();
    const duration = Math.max(1, Number(secondsPerStep) || 3);
    this._tunnelStartTime = Date.now();
    this.currentZoomStep = 4;
    if (this.pano && this.pano.setTunnelMode) {
      this.pano.setTunnelMode(true, 4.2);
    }

    const tick = () => {
      if (this.state !== 'playing' || (!this._roundActive && this.mode !== 'solo')) {
        return;
      }
      const elapsed = (Date.now() - this._tunnelStartTime) / 1000;
      let step = 4;
      let zoom = 4.2;
      let timeLeft = 0;
      let progressPercent = 100;
      let isFinished = false;

      if (elapsed < duration) {
        step = 4;
        zoom = 4.2;
        timeLeft = Math.max(0, duration - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else if (elapsed < 2 * duration) {
        step = 3;
        zoom = 2.8;
        timeLeft = Math.max(0, (2 * duration) - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else if (elapsed < 3 * duration) {
        step = 2;
        zoom = 1.4;
        timeLeft = Math.max(0, (3 * duration) - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else {
        step = 1;
        zoom = 0.0;
        timeLeft = 0;
        progressPercent = 0;
        isFinished = true;
      }

      if (step !== this.currentZoomStep) {
        this.currentZoomStep = step;
        if (this.pano && this.pano.setTunnelZoom) {
          this.pano.setTunnelZoom(step);
        } else if (this.pano && this.pano.setSmoothZoom) {
          this.pano.setSmoothZoom(zoom);
        }
        try {
          if (this.audio && this.audio.click) this.audio.click();
        } catch (e) {}
      }

      this.emit('tunnelProgress', {
        step,
        totalSteps: 4,
        timeLeft: Number(timeLeft.toFixed(1)),
        duration,
        progressPercent,
        zoom,
        isFinished,
      });

      if (isFinished && this._tunnelTimer) {
        clearInterval(this._tunnelTimer);
        this._tunnelTimer = null;
      }
    };

    tick();
    this._tunnelTimer = setInterval(tick, 80);
  }

  _clearTunnelProgression() {
    if (this._tunnelTimer) {
      clearInterval(this._tunnelTimer);
      this._tunnelTimer = null;
    }
    this.currentZoomStep = 1;
    if (this.pano && this.pano.setTunnelMode) {
      this.pano.setTunnelMode(false);
    }
    this.emit('tunnelProgress', null);
  }

  /** Progresión de desenfoque del Modo Borroso (5 fases progresivas de 20%). */
  _startBlurProgression(secondsPerPhase) {
    this._clearBlurProgression();
    const duration = Math.max(1, Number(secondsPerPhase) || 3);
    this._blurStartTime = Date.now();
    this.currentBlurPhase = 1;
    if (this.pano && this.pano.setBlurMode) {
      this.pano.setBlurMode(true);
      this.pano.setBlurLevel(1);
    }

    const tick = () => {
      if (this.state !== 'playing' || (!this._roundActive && this.mode !== 'solo')) {
        return;
      }
      const elapsed = (Date.now() - this._blurStartTime) / 1000;
      let phase = 1;
      let timeLeft = 0;
      let progressPercent = 100;
      let isFinished = false;

      if (elapsed < duration) {
        phase = 1; // 100%
        timeLeft = Math.max(0, duration - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else if (elapsed < 2 * duration) {
        phase = 2; // 80%
        timeLeft = Math.max(0, (2 * duration) - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else if (elapsed < 3 * duration) {
        phase = 3; // 60%
        timeLeft = Math.max(0, (3 * duration) - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else if (elapsed < 4 * duration) {
        phase = 4; // 40%
        timeLeft = Math.max(0, (4 * duration) - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else if (elapsed < 5 * duration) {
        phase = 5; // 20%
        timeLeft = Math.max(0, (5 * duration) - elapsed);
        progressPercent = Math.max(0, Math.min(100, (timeLeft / duration) * 100));
      } else {
        phase = 0; // 0% (Nítido)
        timeLeft = 0;
        progressPercent = 0;
        isFinished = true;
      }

      if (phase !== this.currentBlurPhase) {
        this.currentBlurPhase = phase;
        if (this.pano && this.pano.setBlurLevel) {
          this.pano.setBlurLevel(phase);
        }
        try {
          if (this.audio && this.audio.click) this.audio.click();
        } catch (e) {}
      }

      this.emit('blurProgress', {
        phase,
        step: phase,
        totalPhases: 5,
        timeLeft: Number(timeLeft.toFixed(1)),
        duration,
        progressPercent,
        isFinished,
      });

      if (isFinished && this._blurTimer) {
        clearInterval(this._blurTimer);
        this._blurTimer = null;
      }
    };

    tick();
    this._blurTimer = setInterval(tick, 80);
  }

  _clearBlurProgression() {
    if (this._blurTimer) {
      clearInterval(this._blurTimer);
      this._blurTimer = null;
    }
    this.currentBlurPhase = 0;
    if (this.pano && this.pano.setBlurMode) {
      this.pano.setBlurMode(false);
    }
    this.emit('blurProgress', null);
  }

  /** Activa el temporizador de adivinar y habilita el minimapa. */
  _activateRound(round) {
    this._roundActive = true;
    this.map.setInteractive(true);
    this.emit('prepare', { seconds: null });

    if (this.mode === 'solo') {
      this.soloRoundStartTime = Date.now();
      this.roundEnd = Date.now() + this.soloRemainingSeconds * 1000;
      this.emit('timer', {
        seconds: Math.max(0, Math.ceil(this.soloRemainingSeconds)),
        danger: this.soloRemainingSeconds <= 5,
      });
      this._startSoloTimers();
      return;
    }

    // Multijugador: sin límite rígido previo a que alguien adivine
    this.roundEnd = 0;
    this.emit('timer', { seconds: null, danger: false });

    if (this.role === 'host') {
      this._startHostTimers();
    } else if (this.role === 'guest') {
      this._startGuestTimers();
    }
  }

  _clearPrepare() {
    if (this._prepare) {
      clearInterval(this._prepare);
      this._prepare = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Colocación de marcador y confirmación                               */
  /* ------------------------------------------------------------------ */
  placePick(lat, lng) {
    if (this.state === 'result' || this._over) return;
    this._roundActive = true;
    this.myGuess = { lat: Number(lat), lng: Number(lng) };
    this.emit('confirm', { enabled: true });
  }

  /** Garantiza recuperar la chincheta activa desde Leaflet si myGuess está desfasado */
  _ensureMyGuess() {
    if ((!this.myGuess || this.myGuess.lat == null) && this.map && typeof this.map.getPick === 'function') {
      const p = this.map.getPick();
      if (p && p.lat != null && p.lng != null && !isNaN(Number(p.lat)) && !isNaN(Number(p.lng))) {
        this.myGuess = { lat: Number(p.lat), lng: Number(p.lng) };
      }
    }
    return this.myGuess;
  }

  /** Devuelve verdadero si el jugador tiene una chincheta colocada en el mapa */
  hasPick() {
    this._ensureMyGuess();
    return !!(this.myGuess && this.myGuess.lat != null && this.myGuess.lng != null && !isNaN(Number(this.myGuess.lat)) && !isNaN(Number(this.myGuess.lng)));
  }

  confirmGuess() {
    this._ensureMyGuess();
    if (this.mode === 'solo') {
      this._soloConfirm();
      return;
    }
    this._multiConfirm();
  }

  _soloConfirm() {
    if (this.state === 'result' || this._over) return;
    this._ensureMyGuess();
    const currentStep = this.currentZoomStep;
    const currentBlur = this.currentBlurPhase;
    const guess = this.myGuess ? { ...this.myGuess, zoomStep: currentStep, blurPhase: currentBlur } : null;
    this._clearTimers();
    this._clearTemporal();
    this._clearTunnelProgression();
    this._clearBlurProgression();
    if (this.pano) {
      this.pano.setBlind(false);
      this.pano.setStatic(false);
      this.pano.setTunnelMode(false);
      this.pano.setBlurMode(false);
    }
    this.emit('temporalBlind', { active: false });

    // Descontar únicamente el tiempo jugado en la ronda activa (pausa el reloj durante los resultados)
    const elapsedSec = this.soloRoundStartTime ? (Date.now() - this.soloRoundStartTime) / 1000 : 0;
    this.soloRemainingSeconds = Math.max(0, this.soloRemainingSeconds - elapsedSec);
    this.soloTotalPlayedMs += Math.round(elapsedSec * 1000);
    this.emit('timer', { seconds: Math.ceil(this.soloRemainingSeconds), danger: false });

    const { distance, score: baseScore } = this._score(guess);
    let score = baseScore;
    const isBlur = this.gameMode === 'blur' || this.gameMode === 'static_blur' || this.blurMode;
    const isPerfect = distance != null && distance <= CONFIG.PERFECT_DISTANCE;

    if (isBlur) {
      if (isPerfect) {
        this.soloPerfectStreak = (this.soloPerfectStreak || 0) + 1;
        const streak = this.soloPerfectStreak;
        const streakBonus = Math.max(0, streak - 1) * 750;
        score += streakBonus;
      } else {
        this.soloPerfectStreak = 0;
      }
    }

    this.scores.me += score;

    const result = {
      mode: 'solo',
      gameMode: this.gameMode,
      round: this.currentRound,
      total: this.rounds,
      real: { lat: this.currentCoord.lat, lng: this.currentCoord.lng },
      mine: guess,
      myScore: score,
      myDistanceKm: distance,
      myTotalScore: this.scores.me,
      names: { me: this.meName, opp: null },
      isPerfect,
      perfectStreak: this.soloPerfectStreak || 0,
      blurPhase: (guess && guess.blurPhase !== undefined) ? guess.blurPhase : 1,
    };

    this.audio.confirm();
    this.emit('confirm', { enabled: false });
    this.emit('waiting', { waiting: false });
    this.state = 'result';
    this.emit('result', result);
  }

  _multiConfirm() {
    this._ensureMyGuess();
    if (!this.myGuess || this.state === 'result' || this._over) return;
    this.myGuess.zoomStep = this.currentZoomStep;
    this.myGuess.blurPhase = this.currentBlurPhase;
    this.audio.confirm();
    this._submitGuess(this.myGuess);
  }

  _submitGuess(guess) {
    const currentStep = (guess && guess.zoomStep) ? guess.zoomStep : this.currentZoomStep;
    const currentBlur = (guess && guess.blurPhase !== undefined) ? guess.blurPhase : this.currentBlurPhase;
    const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const myClean = norm(this.meName);
    let me = this.players.find((p) =>
      (this.net.myId && p.id === this.net.myId) ||
      (myClean && norm(p.name) === myClean)
    );
    if (!me && this.role === 'guest') {
      me = this.players.find((p, idx) => idx > 0 && p.id !== this.net.roomId);
    }
    if (!me && this.role === 'host') {
      me = this.players.find((p) => p.isHost || p.id === this.net.roomId) || this.players[0];
    }
    if (!me) me = this.players[0];

    if (me) {
      me.guessed = true;
      me.guess = guess ? { ...guess, zoomStep: currentStep, blurPhase: currentBlur } : null;
    }
    this.emit('confirm', { enabled: false });
    this.emit('waiting', { waiting: true });

    if (this.role === 'guest') {
      this.net.send({
        type: 'guess',
        round: this.currentRound,
        lat: guess ? Number(guess.lat) : null,
        lng: guess ? Number(guess.lng) : null,
        zoomStep: currentStep,
        blurPhase: currentBlur,
        name: this.meName,
        senderId: me ? me.id : this.net.myId,
        playerId: me ? me.id : this.net.myId,
      });
    } else if (this.role === 'host') {
      if (this._allGuessed() && !this._resolved) {
        this._clearHurry();
        if (this._graceTimer) {
          clearTimeout(this._graceTimer);
          this._graceTimer = null;
        }
        this._resolveMultiRound();
      } else if (!this._resolved) {
        // Arranca el contador de 15s para los que aún no envían, anunciando quién adivinó
        this._startHurry(me ? me.name : (this.meName || 'Un jugador'));
      }
    }
  }

  /** Contador de 15 segundos cuando el primer jugador adivina. */
  _startHurry(guesserName = '') {
    if (this._hurryActive) return;
    this._hurryActive = true;
    this.hurryGuesser = guesserName;
    const seconds = CONFIG.OPPONENT_COUNTDOWN || 15;
    const penalty = getNoGuessPenalty(this.currentRound);
    this.net.broadcast({
      type: 'hurryStart',
      round: this.currentRound,
      seconds,
      guesserName,
      penalty,
    });
    this._runHurryCountdown(seconds, guesserName, penalty);
  }

  _onHurryStart(data) {
    if (this._resolved) return;
    this._hurryActive = true;
    const seconds = data.seconds || CONFIG.OPPONENT_COUNTDOWN || 15;
    const guesserName = data.guesserName || '';
    const penalty = data.penalty || getNoGuessPenalty(this.currentRound);
    this._runHurryCountdown(seconds, guesserName, penalty);
  }

  _runHurryCountdown(totalSeconds, guesserName = '', penalty = 0) {
    this._clearHurryTimer();
    const roundPenalty = penalty || getNoGuessPenalty(this.currentRound);
    let left = totalSeconds;
    // Asigna el timestamp límite para el temporizador maestro de rescate del anfitrión (margen de red +4.5s)
    this.hurryEnd = Date.now() + (totalSeconds + 4.5) * 1000;
    this.emit('countdown', { seconds: left, guesserName, penalty: roundPenalty });
    this._hurry = setInterval(() => {
      left--;
      if (left >= 0) {
        this.emit('countdown', { seconds: left, guesserName, penalty: roundPenalty });
      }
      if (left <= 0) {
        this._clearHurryTimer();
        this.emit('countdown', { seconds: null });

        // Si el jugador colocó un marcador pero no llegó a confirmar, auto-enviamos su guess:
        this._ensureMyGuess();
        const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        const myClean = norm(this.meName);
        const me = this.players.find((p) =>
          (this.net.myId && p.id === this.net.myId) ||
          (myClean && norm(p.name) === myClean)
        );
        if (this.myGuess && (!me || !me.guessed)) {
          this._multiConfirm();
        }

        if (this.role === 'host' && !this._resolved) {
          // Si el anfitrión tenía marcador y no había confirmado, confirmarlo
          if (this.myGuess && (!me || !me.guessed)) {
            this._multiConfirm();
          }
          if (this._resolved) return; // Si _multiConfirm ya resolvió la ronda, no crear graceTimer zombie (BUG-17)

          // Tolerancia de red ampliada a 3.5 segundos para recibir paquetes de invitados en tránsito
          if (this._graceTimer) clearTimeout(this._graceTimer);
          this._graceTimer = setTimeout(() => {
            if (!this._resolved) {
              this.players.forEach((p) => {
                if (!p.guessed) {
                  p.guessed = true;
                  p.guess = null;
                }
              });
              this._resolveMultiRound();
            }
          }, 3500);
        }
      }
    }, 1000);
  }

  _clearHurryTimer() {
    if (this._hurry) {
      clearInterval(this._hurry);
      this._hurry = null;
    }
  }

  _clearHurry() {
    this._clearHurryTimer();
    this._hurryActive = false;
    this.hurryGuesser = '';
    this.hurryEnd = 0;
  }

  _allGuessed() {
    return this.players.length > 0 && this.players.every((p) => p.guessed);
  }

  /** Marca a un jugador desconectado durante la partida con tiempo de gracia para reconectar. */
  removePlayer(peerId) {
    if (!peerId) return;
    const player = this.players.find((p) => p.id === peerId);
    if (player) {
      player.disconnected = true;
    }

    // Si todos los rivales están desconectados, iniciar un temporizador de abandono (15s)
    const activeOpponents = this.players.filter((p) => p.id !== this.net.myId && !p.disconnected);
    if (activeOpponents.length === 0 && !this._over) {
      if (!this._forfeitTimer) {
        this.emit('toast', { message: 'Rival desconectado. Esperando reconexión (15s)…', kind: 'warning' });
        this._forfeitTimer = setTimeout(() => {
          const stillActive = this.players.filter((p) => p.id !== this.net.myId && !p.disconnected);
          if (stillActive.length === 0 && !this._over) {
            this._endGame('forfeit');
          }
          this._forfeitTimer = null;
        }, 15000);
      }
      return;
    }

    // Si aún quedan jugadores y todos los que están conectados ya adivinaron:
    const connectedPlayers = this.players.filter((p) => !p.disconnected);
    if (connectedPlayers.length > 0 && connectedPlayers.every((p) => p.guessed) && !this._resolved) {
      this._resolveMultiRound();
    }
  }

  /** Host: sincroniza a un invitado que se reconectó durante una partida en curso. */
  syncGuestReconnect(peerId) {
    if (!this._hostStarted || !this.locations || !this.locations.length) return;
    const guestName = (this.net.guestNames.get(peerId) || '').trim().toLowerCase();
    const existing = this.players.find((p) => (p.name || '').trim().toLowerCase() === guestName);
    if (existing) {
      existing.id = peerId;
      existing.disconnected = false;
    }
    // Si había un temporizador de forfeit por rival desconectado, cancelarlo
    if (this._forfeitTimer) {
      clearTimeout(this._forfeitTimer);
      this._forfeitTimer = null;
      this.emit('toast', { message: `${existing ? existing.name : 'Un jugador'} se ha reconectado.`, kind: 'info' });
    }

    // 1. Enviar el paquete 'start' al invitado para que inicialice su juego
    this.net.sendTo(peerId, {
      type: 'start',
      rounds: this.rounds,
      locations: this.locations,
      mode: 'multi',
      gameMode: this.gameMode,
      temporalSeconds: this.temporalSeconds,
      players: this.players.map((p) => ({ id: p.id, name: p.name, hp: p.hp, score: p.score })),
    });

    // 2. Enviar inmediatamente el roundStart de la ronda actual
    setTimeout(() => {
      if (!this.currentCoord) return;
      this.net.sendTo(peerId, {
        type: 'roundStart',
        round: this.currentRound,
        total: this.rounds,
        locationIndex: this.locations ? this.locations[this.currentRound - 1] : null,
        coord: this.currentCoord,
        heading: this.roundHeading || 0,
        gameMode: this.gameMode,
        temporalSeconds: this.temporalSeconds,
        duration: CONFIG.ROUND_DURATION,
        syncTime: Date.now() + 400,
        players: this.players.map((p) => ({ id: p.id, name: p.name, hp: p.hp, score: p.score })),
      });
      setTimeout(() => {
        if (this.currentRound && !this._resolved) {
          this.net.sendTo(peerId, {
            type: 'syncStart',
            round: this.currentRound,
            prepareSeconds: 1,
          });
        }
      }, 350);
    }, 600);
  }

  /* ------------------------------------------------------------------ */
  /* Temporizadores                                                      */
  /* ------------------------------------------------------------------ */
  _startHostTimers() {
    this._clearTimers();
    this._master = setInterval(() => {
      if (this.hurryEnd && Date.now() >= this.hurryEnd && !this._resolved) {
        this.hurryEnd = 0;
        // Los que no adivinaron quedan sin guess.
        this.players.forEach((p) => {
          if (!p.guessed) {
            p.guessed = true;
            p.guess = null;
          }
        });
        this._resolveMultiRound();
      }
    }, 200);
  }

  _startGuestTimers() {
    this._clearTimers();
    // Los invitados se gestionan con el contador de 15s al recibir hurryStart.
  }

  _startSoloTimers() {
    this._clearTimers();
    let lastSecond = -1;
    this._tick = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((this.roundEnd - Date.now()) / 1000));
      if (remaining !== lastSecond) {
        lastSecond = remaining;
        this.emit('timer', { seconds: remaining, danger: remaining <= 5 });
      }
      if (remaining <= 0) {
        this._clearTimers();
        this._clearTemporal();
        this.soloRemainingSeconds = 0;
        this.soloTimedOut = true;
        this._endSoloGame();
      }
    }, 250);
  }

  _clearTimers() {
    if (this._master) clearInterval(this._master);
    if (this._tick) clearInterval(this._tick);
    if (this._resultTimer) clearTimeout(this._resultTimer);
    if (this._readyTimer) clearTimeout(this._readyTimer);
    if (this._graceTimer) clearTimeout(this._graceTimer);
    if (this._forfeitTimer) {
      clearTimeout(this._forfeitTimer);
      this._forfeitTimer = null;
    }
    this._clearPrepare();
    this._clearHurry();
    this._clearTemporal();
    this._clearTunnelProgression();
    if (this.pano && this.pano.setTunnelMode) {
      this.pano.setTunnelMode(false);
    }
    this._clearBlurProgression();
    if (this.pano && this.pano.setBlurMode) {
      this.pano.setBlurMode(false);
    }
    if (this._syncTimeout) {
      clearTimeout(this._syncTimeout);
      this._syncTimeout = null;
    }
    this._master = null;
    this._tick = null;
    this._resultTimer = null;
    this._readyTimer = null;
    this._graceTimer = null;
    this.hurryEnd = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Red (mensajes entrantes)                                            */
  /* ------------------------------------------------------------------ */
  handleNetworkMessage(data, fromPeerId) {
    switch (data.type) {
      case 'ready':
        if (this.role === 'host') {
          this._readyCount += 1;
          if (this._readyCount >= this.players.length) {
            clearTimeout(this._readyTimer);
            this._readyTimer = null;
            this._beginRound(1);
          }
        }
        break;
      case 'roundStart': {
        // Si el guest aún no terminó de cargar datos/visores, encolar para después.
        if (this.role === 'guest' && !this._guestReady) {
          this._pendingRoundStart = data;
          break;
        }
        this.currentRound = data.round;
        this.state = 'playing';
        this.roundHeading = data.heading || 0;
        this.gameMode = data.gameMode || 'normal';
        this.zoomMode = !!data.zoomMode || this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel';
        this.blurMode = !!data.blurMode || this.gameMode === 'blur' || this.gameMode === 'static_blur';
        this.temporalSeconds = Number(data.temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
        this.tunnelSeconds = Number(data.tunnelSeconds) || CONFIG.DEFAULT_TUNNEL_SECONDS;
        this.blurSeconds = Number(data.blurSeconds) || CONFIG.DEFAULT_BLUR_SECONDS;
        this._resolved = false;
        this._roundActive = false;
        this._syncStartedRound = null;
        this._roundSyncStarted = null;
        this.myGuess = null;
        this._clearTemporal();
        this._clearTunnelProgression();
        this._clearBlurProgression();

        // Configurar modo estático según regla
        const isStatic = this.gameMode === 'static' || this.gameMode === 'static_tunnel' || this.gameMode === 'static_blur' || (this.gameMode === 'static' && (this.zoomMode || this.blurMode));
        const isBlur = this.gameMode === 'blur' || this.gameMode === 'static_blur' || this.blurMode;
        const isTunnel = this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel' || this.zoomMode;

        if (isBlur) {
          this.pano.setBlurMode(true);
        } else if (isTunnel) {
          this.pano.setTunnelMode(true);
        }
        this.pano.setStatic(isStatic);

        if (data.players && Array.isArray(data.players)) {
          this.players = data.players.map((dp) => ({
            id: dp.id,
            name: dp.name,
            score: dp.score || 0,
            hp: typeof dp.hp === 'number' && !isNaN(dp.hp) ? dp.hp : CONFIG.MAX_HP,
            guess: null,
            guessed: false,
            _preRoundHp: typeof dp.hp === 'number' && !isNaN(dp.hp) ? dp.hp : CONFIG.MAX_HP,
            _preRoundScore: dp.score || 0,
          }));
        } else {
          this.players.forEach((p) => {
            p.guess = null;
            p.guessed = false;
            p._preRoundHp = typeof p.hp === 'number' ? p.hp : CONFIG.MAX_HP;
            p._preRoundScore = typeof p.score === 'number' ? p.score : 0;
            if (typeof p.hp !== 'number' || isNaN(p.hp)) p.hp = CONFIG.MAX_HP;
          });
        }

        const coord = (data.locationIndex != null && this.coordenadas && this.coordenadas[data.locationIndex])
          || data.coord
          || this.currentCoord;
        this.currentCoord = coord;

        // Cortina de carga activa ANTES de emitir HUD para evitar destello de StreetView al colapsar el minimapa
        this.pano.setBlind(true, 'Ronda ' + data.round, 'Cargando ubicación en alta definición…', true);
        if (coord) {
          this.pano.setPano(coord.pano_id, this.roundHeading, 0, coord);
        }

        // Failsafe de seguridad para invitados: si syncStart se pierde o demora por red, nunca quedar con pantalla negra
        if (this._guestBlindFailsafe) clearTimeout(this._guestBlindFailsafe);
        this._guestBlindFailsafe = setTimeout(() => {
          if (this.state === 'playing' && this.currentRound === data.round && !this._roundActive) {
            console.warn('GG-TLALTE: Failsafe activado: syncStart no llegó a tiempo, retirando cortina automáticamente.');
            this.pano.refresh();
            this.pano.setBlind(false);
            this._activateRound(data.round);
          }
        }, 3600);

        this.pano.setStatic(isStatic || this.gameMode === 'temporal');
        this.map.reset();
        const myIndex = this.players.findIndex((p) => p.id === this.net.myId);
        const assignedColor = CONFIG.PLAYER_COLORS[myIndex >= 0 ? myIndex % CONFIG.PLAYER_COLORS.length : 0];
        this.map.setMyColor(assignedColor);
        this.map.setInteractive(true);
        this.emit('waiting', { waiting: false });
        this.emit('confirm', { enabled: false });
        this.emit('temporalBlind', { active: false });
        this.emit('temporalTimer', { seconds: null });
        this._emitHud();

        this.pano.waitForReady(2500)
          .catch(() => {})
          .then(() => {
            if (this.state !== 'playing' || this.currentRound !== data.round) return;
            this.net.send({
              type: 'panoReady',
              round: this.currentRound,
              senderId: this.net.myId,
            });
          });
        break;
      }
      case 'panoReady': {
        if (this.role !== 'host') break;
        const pId = data.senderId || fromPeerId;
        if (pId) {
          this._panoReadyPeers.add(pId);
          this._checkAllPanoReady(data.round || this.currentRound);
        }
        break;
      }
      case 'syncStart': {
        if (this._guestBlindFailsafe) {
          clearTimeout(this._guestBlindFailsafe);
          this._guestBlindFailsafe = null;
        }
        if (this.role === 'guest' && !this._guestReady) {
          this._pendingSyncStart = data;
          break;
        }
        this._onSyncStart(data);
        break;
      }
      case 'tick':
        if (data.remaining !== undefined) {
          this.emit('timer', { seconds: data.remaining, danger: data.remaining <= 5 });
          // Si el anfitrión ya arrancó el temporizador de la ronda, garantizar que ningún jugador
          // quede bloqueado tras la cortina o con el visor desincronizado
          if (this.state === 'playing' && data.remaining < (CONFIG.ROUND_DURATION || 60)) {
            if (this._guestBlindFailsafe) {
              clearTimeout(this._guestBlindFailsafe);
              this._guestBlindFailsafe = null;
            }
            if (!this._roundActive) {
              this.pano.refresh();
              this.pano.setBlind(false);
              this._activateRound(this.currentRound);
            }
          }
        }
        break;
      case 'guess': {
        if (this.role !== 'host') break;
        const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
        const senderName = norm(data.name || data.senderName);
        const hostClean = norm(this.meName);

        let p = this.players.find((x) => {
          const xName = norm(x.name);
          if (fromPeerId && x.id === fromPeerId) return true;
          if (data.senderId && x.id === data.senderId) return true;
          if (data.playerId && x.id === data.playerId) return true;
          if (senderName && xName && (xName === senderName || xName.includes(senderName) || senderName.includes(xName))) return true;
          return false;
        });

        // Si no se encontró por ID directo ni por nombre, buscar entre los jugadores que no sean el host:
        if (!p) {
          // Si quedan jugadores que aún no han adivinado y no son el host:
          const pendingGuests = this.players.filter((x) =>
            !x.guessed &&
            x.id !== this.net.myId &&
            norm(x.name) !== hostClean
          );
          if (pendingGuests.length === 1) {
            // Solo queda un invitado pendiente por adivinar: le pertenece este guess
            p = pendingGuests[0];
          } else if (this.players.length === 2) {
            // Duelo de 2 jugadores: si no es el anfitrión, es el rival
            p = this.players.find((x) => x.id !== this.net.myId && norm(x.name) !== hostClean);
          }
        }

        const validCoords = (data.lat != null && data.lng != null && !isNaN(Number(data.lat)) && !isNaN(Number(data.lng)));
        const parsedGuess = validCoords
          ? {
              lat: Number(data.lat),
              lng: Number(data.lng),
              zoomStep: Number(data.zoomStep) || 1,
              blurPhase: data.blurPhase !== undefined ? Number(data.blurPhase) : 1,
            }
          : null;

        if (p && (!p.guessed || p.guess == null)) {
          p.guessed = true;
          p.guess = parsedGuess;
        }

        if (this._allGuessed() && !this._resolved) {
          this._clearHurry();
          if (this._graceTimer) {
            clearTimeout(this._graceTimer);
            this._graceTimer = null;
          }
          this._resolveMultiRound();
        } else if (!this._resolved && !this._hurryActive) {
          // El primer jugador en adivinar dispara el contador de 15s para los demás con su nombre
          this._startHurry(p ? p.name : 'Un rival');
        } else if (this._resolved && this.state === 'result' && p && p.guess == null && parsedGuess) {
          // Rescate de conjetura tardía si llegó durante la pantalla de resultados y el jugador fue penalizado como AFK
          if (this._lastResolvedAt && (Date.now() - this._lastResolvedAt) < 4000) {
            console.log('GG-TLALTE: Rescatando conjetura tardía para anular AFK:', p.name);
            p.guess = parsedGuess;
            p.guessed = true;
            this._resolved = false;
            this._resolveMultiRound();
          }
        }
        break;
      }
      case 'hurryStart':
        if (this.role === 'guest' && !this._guestReady) {
          this._pendingHurryStart = data;
          break;
        }
        this._onHurryStart(data);
        break;
      case 'roundResult':
        if (this.role === 'guest' && !this._guestReady) {
          this._pendingRoundStart = null;
          this._pendingHurryStart = null;
          this._pendingRoundResult = data;
          break;
        }
        this._onRoundResult(data);
        break;
      case 'gameOver':
        if (this.role === 'guest' && !this._guestReady) {
          this._pendingRoundStart = null;
          this._pendingHurryStart = null;
          this._pendingRoundResult = null;
          this._pendingGameOver = data;
          break;
        }
        this._onGameOver(data);
        break;
    }
  }

  _score(guess) {
    if (!guess) return { distance: null, score: 0 };
    const d = haversineKm(
      this.currentCoord.lat,
      this.currentCoord.lng,
      guess.lat,
      guess.lng
    );
    const isTunnel = this.gameMode === 'tunnel' || this.gameMode === 'static_tunnel' || this.zoomMode;
    const isBlur = this.gameMode === 'blur' || this.gameMode === 'static_blur' || this.blurMode;
    let score;
    if (isBlur) {
      score = scoreForDistanceBlur(d, guess.blurPhase !== undefined ? guess.blurPhase : 1);
    } else if (isTunnel) {
      score = scoreForDistanceTunnel(d, guess.zoomStep || 1);
    } else {
      score = scoreForDistance(d);
    }
    return { distance: d, score };
  }

  /* ------------------------------------------------------------------ */
  /* Resolución de ronda (multijugador, host autoritativo)               */
  /* ------------------------------------------------------------------ */
  _resolveMultiRound() {
    if (this._resolved) return;
    this._resolved = true;
    this._lastResolvedAt = Date.now();
    if (this.net && typeof this.net.setAwaitingGuesses === 'function') {
      this.net.setAwaitingGuesses(false);
    }
    this._clearTimers();
    this.state = 'result';

    const real = { lat: this.currentCoord.lat, lng: this.currentCoord.lng };
    const roundMult = damageMultiplier(this.currentRound);
    const penalty = getNoGuessPenalty(this.currentRound);
    const isBlur = this.gameMode === 'blur' || this.gameMode === 'static_blur' || this.blurMode;

    // Actualizamos directamente en this.players para que el daño, curación y los puntos persistan
    const results = this.players.map((p) => {
      // Revertir a la base de la ronda para cálculo limpio y determinista ante recálculos por rescate
      p.hp = (typeof p._preRoundHp === 'number') ? p._preRoundHp : p.hp;
      p.score = (typeof p._preRoundScore === 'number') ? p._preRoundScore : p.score;

      const info = this._score(p.guess);
      const isPerfect = info.distance != null && info.distance <= CONFIG.PERFECT_DISTANCE;

      let damage = 0;
      let healed = 0;

      if (isBlur) {
        if (isPerfect) {
          // PERFECT en modo borroso: sumarle puntos extra y curación de vida
          p.perfectStreak = (p.perfectStreak || 0) + 1;
          const streak = p.perfectStreak;
          const phase = (p.guess && p.guess.blurPhase !== undefined) ? p.guess.blurPhase : 1;
          const baseHeals = { 1: 1600, 2: 1200, 3: 900, 4: 600, 5: 300, 0: 150 };
          const baseHeal = baseHeals[phase] !== undefined ? baseHeals[phase] : 150;
          const streakMultiplier = 1 + Math.max(0, streak - 1) * 0.5;
          healed = Math.round(baseHeal * streakMultiplier);

          // Si hace varios perfect seguidos, sumarle aún más puntos!
          const streakScoreBonus = Math.max(0, streak - 1) * 750;
          info.score += streakScoreBonus;

          // No importa si la vida pasa de 5,000 puntos:
          p.hp = p.hp + healed;
          damage = 0;
        } else {
          // Más allá de los 25m: reinicia racha y resta puntos normalmente
          p.perfectStreak = 0;
          if (p.guess == null) {
            damage = penalty;
          } else if (info.score < CONFIG.BASE_SCORE) {
            const scoreDeficit = (CONFIG.BASE_SCORE - info.score) / CONFIG.BASE_SCORE;
            damage = Math.round(scoreDeficit * penalty);
          }
          damage = Math.round(damage * roundMult);
          p.hp = Math.max(0, p.hp - damage);
          healed = 0;
        }
      } else {
        if (p.guess == null) {
          damage = penalty;
        } else if (info.score < CONFIG.BASE_SCORE) {
          const scoreDeficit = (CONFIG.BASE_SCORE - info.score) / CONFIG.BASE_SCORE;
          damage = Math.round(scoreDeficit * penalty);
        }
        damage = Math.round(damage * roundMult);
        p.hp = clamp(p.hp - damage, 0, CONFIG.MAX_HP);
      }

      p.score += info.score;

      return {
        id: p.id,
        name: p.name,
        guess: p.guess,
        score: info.score,
        totalScore: p.score,
        distance: info.distance,
        hp: p.hp,
        damage,
        healed,
        isPerfect,
        perfectStreak: p.perfectStreak || 0,
      };
    });

    const neutral = {
      round: this.currentRound,
      total: this.rounds,
      real,
      players: results,
      multiplier: roundMult,
      penalty,
    };

    this.net.broadcast({ type: 'roundResult', ...neutral });
    this._showMultiResult(neutral);
    this._scheduleAdvance();
  }

  _showMultiResult(neutral) {
    const result = this._adaptResult(neutral);
    if (neutral.players.some((p) => (p.damage || 0) > 0)) {
      if (result.wonRound) this.audio.roundWin();
      else this.audio.roundLose();
    } else if (neutral.players.some((p) => (p.healed || 0) > 0)) {
      this.audio.roundWin();
    }
    this.emit('result', result);
  }

  _onRoundResult(neutral) {
    this._clearTimers();
    this.state = 'result';

    neutral.players.forEach((r) => {
      const p = this.players.find((x) => x.id === r.id || x.name === r.name);
      if (p) {
        p.score = r.totalScore;
        p.hp = r.hp;
        p.guess = r.guess;
        p.healed = r.healed;
        p.perfectStreak = r.perfectStreak;
        p.isPerfect = r.isPerfect;
      }
    });

    const result = this._adaptResult(neutral);
    if (neutral.players.some((p) => (p.damage || 0) > 0)) {
      if (result.wonRound) this.audio.roundWin();
      else this.audio.roundLose();
    } else if (neutral.players.some((p) => (p.healed || 0) > 0)) {
      this.audio.roundWin();
    }
    this.emit('result', result);
  }

  _adaptResult(neutral) {
    const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const myClean = norm(this.meName);
    const me = neutral.players.find((p) =>
      (this.net.myId && p.id === this.net.myId) ||
      (myClean && norm(p.name) === myClean)
    ) || neutral.players[0];
    return {
      mode: 'multi',
      round: neutral.round,
      total: neutral.total,
      real: neutral.real,
      players: neutral.players,
      me,
      myScore: me.score,
      myTotalScore: me.totalScore,
      myHp: me.hp,
      healed: me.healed || 0,
      isPerfect: !!me.isPerfect,
      perfectStreak: me.perfectStreak || 0,
      multiplier: neutral.multiplier,
      penalty: neutral.penalty || getNoGuessPenalty(neutral.round),
      wonRound: me.score >= CONFIG.BASE_SCORE,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Avance de ronda y fin de partida                                    */
  /* ------------------------------------------------------------------ */
  _scheduleAdvance() {
    if (this._resultTimer) {
      clearTimeout(this._resultTimer);
      this._resultTimer = null;
    }
    this._resultTimer = setTimeout(() => {
      if (this._over) return;

      // Si el rival se desconectó y quedó solo 1 jugador en multijugador, victoria por abandono (BUG-05)
      if (this.players.length < 2) {
        this._endGame('forfeit');
        return;
      }

      // El KO solo termina la partida en 1v1 (2 jugadores).
      // Con 3+ jugadores se sigue hasta agotar las rondas.
      if (this.players.length === 2 && this.players.some((p) => p.hp <= 0)) {
        this._endGame('hp');
        return;
      }
      if (this.currentRound >= this.rounds) {
        this._endGame('rounds');
        return;
      }
      this._beginRound(this.currentRound + 1);
    }, CONFIG.RESULT_DURATION);
  }

  _endGame(reason) {
    this._over = true;
    this.state = 'gameover';
    this._clearTimers();

    const ranked = [...this.players].sort((a, b) => {
      if (b.hp !== a.hp) return b.hp - a.hp;
      return b.score - a.score;
    });

    const neutral = {
      reason,
      total: this.rounds,
      players: ranked.map((p, i) => ({
        id: p.id,
        name: p.name,
        hp: p.hp,
        score: p.score,
        rank: i + 1,
      })),
    };

    if (this.role === 'host') {
      this.net.broadcast({ type: 'gameOver', ...neutral });
    }

    const result = this._adaptGameOver(neutral);
    if (result.won) this.audio.victory();
    else if (result.won === false) this.audio.defeat();
    this.emit('gameover', result);
  }

  _onGameOver(neutral) {
    this._over = true;
    this.state = 'gameover';
    this._clearTimers();
    const result = this._adaptGameOver(neutral);
    if (result.won) this.audio.victory();
    else if (result.won === false) this.audio.defeat();
    this.emit('gameover', result);
  }

  _adaptGameOver(neutral) {
    const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const myClean = norm(this.meName);
    const me = neutral.players.find((p) =>
      (this.net.myId && p.id === this.net.myId) ||
      (myClean && norm(p.name) === myClean)
    ) || neutral.players[0];
    return {
      mode: 'multi',
      total: neutral.total,
      reason: neutral.reason,
      players: neutral.players,
      me,
      rank: me ? me.rank : 1,
      won: me ? me.rank === 1 : false,
      myTotalScore: me ? me.score : 0,
      myHp: me ? me.hp : 0,
    };
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */
  _emitHud() {
    const norm = (s) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const myClean = norm(this.meName);
    const me = this.players.find((p) =>
      (this.net.myId && p.id === this.net.myId) ||
      (myClean && norm(p.name) === myClean)
    ) || null;
    this.emit('hud', {
      mode: this.mode,
      gameMode: this.gameMode,
      round: this.currentRound,
      total: this.rounds,
      multiplier: damageMultiplier(this.currentRound),
      penalty: getNoGuessPenalty(this.currentRound),
      me: {
        name: this.meName || 'Tú',
        hp: me ? me.hp : CONFIG.MAX_HP,
        hpMax: CONFIG.MAX_HP,
        score: me ? me.score : (this.scores ? this.scores.me : 0),
      },
      players: this.mode === 'multi' ? this.players : null,
    });
  }

  /** Avanza a la siguiente ronda en solitario (botón "Siguiente"). */
  nextRound() {
    if (this.mode !== 'solo') return;
    if (this.currentRound >= this.rounds) {
      this._endSoloGame();
      return;
    }
    this.state = 'playing';
    this._beginRound(this.currentRound + 1);
  }

  _endSoloGame() {
    this._over = true;
    this.state = 'gameover';
    this._clearTimers();
    this._clearTemporal();
    this._clearTunnelProgression();
    if (this.pano) {
      this.pano.setBlind(false);
      this.pano.setStatic(false);
      this.pano.setTunnelMode(false);
    }
    this.emit('temporalBlind', { active: false });

    // El tiempo final de partida excluye las pausas de la pantalla de resultados (Req 2)
    const elapsed = this.soloTimedOut
      ? this.soloTotalSeconds * 1000
      : Math.min(this.soloTotalSeconds * 1000, this.soloTotalPlayedMs);
    this.emit('gameover', {
      mode: 'solo',
      gameMode: this.gameMode,
      total: this.rounds,
      won: null,
      myTotalScore: this.scores.me,
      oppTotalScore: null,
      names: { me: this.meName, opp: null },
      timeMs: Math.max(0, Math.round(elapsed)),
      timedOut: this.soloTimedOut,
    });
    this.audio.victory();
  }

  /** Cancela cualquier partida en curso (salida de sala, etc.). */
  abort() {
    this._clearTimers();
    this._clearPrepare();
    this._clearTemporal();
    this._clearTunnelProgression();
    this._pendingRoundStart = null;
    this._pendingSyncStart = null;
    this._pendingHurryStart = null;
    this._pendingRoundResult = null;
    this._pendingGameOver = null;
    this._syncStartedRound = null;
    this._roundSyncStarted = null;
    if (this.pano) {
      this.pano.setBlind(false);
      this.pano.setStatic(false);
      this.pano.setTunnelMode(false);
    }
    this.state = 'idle';
    this._over = false;
    this.mode = 'solo';
    this.role = 'solo';
  }

  /** Restaura manualmente la vista panorámica si el jugador sufre pantalla negra. */
  recoverPano() {
    console.log('GG-TLALTE: Recuperación forzada de panorámica ejecutada.');
    if (this._guestBlindFailsafe) {
      clearTimeout(this._guestBlindFailsafe);
      this._guestBlindFailsafe = null;
    }
    if (this.pano) {
      this.pano.recover(this.currentCoord);
    }
    if (this.state === 'playing') {
      this._roundActive = true;
      if (this.map) {
        this.map.setInteractive(true);
      }
    }
  }
}
