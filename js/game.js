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

import { CONFIG, damageMultiplier, getNoGuessPenalty } from './config.js';
import {
  haversineKm,
  scoreForDistance,
  computeDamage,
  pickIndices,
  pickSeparatedIndices,
  clamp,
} from './utils.js';

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

    this.gameMode = 'normal'; // 'normal' | 'static' | 'temporal'
    this.temporalSeconds = CONFIG.DEFAULT_TEMPORAL_SECONDS || 3;

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

    this._guestReady = true;       // se pone a false durante guestOnStart hasta que esté listo
    this._pendingRoundStart = null; // encola mensajes si llegan antes de que el guest esté listo
    this._pendingHurryStart = null;
    this._pendingRoundResult = null;
    this._pendingGameOver = null;
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
  startSolo(rounds = CONFIG.SOLO_ROUNDS, gameMode = 'normal', temporalSeconds = CONFIG.DEFAULT_TEMPORAL_SECONDS) {
    const mode = CONFIG.SOLO_MODES[rounds] || CONFIG.SOLO_MODES[CONFIG.SOLO_ROUNDS];
    this._reset();
    this.mode = 'solo';
    this.role = 'solo';
    this.gameMode = gameMode || 'normal';
    this.temporalSeconds = Number(temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
    this.rounds = mode.rounds;
    this.soloTotalSeconds = mode.totalSeconds;
    this.soloRemainingSeconds = mode.totalSeconds;
    this.soloStartTime = 0;
    this.soloRoundStartTime = 0;
    this.soloTotalPlayedMs = 0;
    // Selección aleatoria garantizando al menos 161m entre panorámicas consecutivas
    this.locations = pickSeparatedIndices(this.coordenadas, this.rounds, 0.161);
    this._beginRound(1);
  }

  /** Host: inicia la partida y envía la semilla/orden a los invitados. */
  hostStart(gameMode = 'normal', temporalSeconds = CONFIG.DEFAULT_TEMPORAL_SECONDS) {
    this._reset();
    this.mode = 'multi';
    this.role = 'host';
    this.gameMode = gameMode || 'normal';
    this.temporalSeconds = Number(temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
    this.rounds = this.net.rounds || CONFIG.DUEL_ROUNDS;

    this.players = this.net.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hp: CONFIG.MAX_HP,
      guess: null,
      guessed: false,
    }));

    // No permitir iniciar un duelo si el anfitrión está solo
    if (this.players.length <= 1) {
      this.emit('toast', { message: 'Se necesitan al menos 2 jugadores para iniciar.', kind: 'error' });
      return;
    }

    const seed = (Math.random() * 0xffffffff) >>> 0;
    // Selección aleatoria garantizando al menos 161m entre panorámicas consecutivas
    this.locations = pickSeparatedIndices(this.coordenadas, this.rounds, 0.161);

    this.net.broadcast({
      type: 'start',
      seed,
      rounds: this.rounds,
      locations: this.locations,
      mode: 'multi',
      gameMode: this.gameMode,
      temporalSeconds: this.temporalSeconds,
      players: this.players.map((p) => ({ id: p.id, name: p.name })),
    });

    this._hostStarted = true;
    this.emit('toast', { message: 'Iniciando partida…', kind: 'info' });

    // Iniciar ronda 1 de inmediato tras 400ms para que la partida nunca se quede en negro
    clearTimeout(this._readyTimer);
    this._readyTimer = setTimeout(() => {
      this._beginRound(1);
    }, 400);
  }

  /** Guest: recibe el mensaje 'start' del host. */
  guestOnStart(data) {
    this._reset();
    this.mode = 'multi';
    this.role = 'guest';
    this.gameMode = data.gameMode || 'normal';
    this.temporalSeconds = Number(data.temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
    this.rounds = data.rounds || CONFIG.DUEL_ROUNDS;
    this.locations = data.locations || [];
    this.players = (data.players || []).map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hp: CONFIG.MAX_HP,
      guess: null,
      guessed: false,
    }));
    const myClean = (this.meName || '').trim().toLowerCase();
    const mePlayer = this.players.find((p) => (p.name || '').trim().toLowerCase() === myClean);
    if (mePlayer && mePlayer.id) {
      this.net.myId = mePlayer.id;
    }
    this.emit('toast', { message: '¡Comienza la partida!', kind: 'info' });
    this._guestReady = false;
    this._pendingRoundStart = null;
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
      this._pendingHurryStart = null;
      this._pendingRoundResult = null;
      this._pendingGameOver = null;
      this._onGameOver(data);
      return;
    }
    if (this._pendingRoundResult) {
      const data = this._pendingRoundResult;
      this._pendingRoundStart = null;
      this._pendingHurryStart = null;
      this._pendingRoundResult = null;
      this._onRoundResult(data);
      return;
    }
    if (this._pendingRoundStart) {
      const data = this._pendingRoundStart;
      this._pendingRoundStart = null;
      this.handleNetworkMessage(data, null);
      if (this._pendingHurryStart) {
        const hurry = this._pendingHurryStart;
        this._pendingHurryStart = null;
        this._onHurryStart(hurry);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Bucle de rondas (común)                                             */
  /* ------------------------------------------------------------------ */
  _reset() {
    this._clearTimers();
    this._clearTemporal();
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
    this._resolved = false;
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
    }
  }

  _beginRound(round) {
    this.currentRound = round;
    this.state = 'playing';
    this._resolved = false;
    this._roundActive = false;
    this.myGuess = null;
    this._clearTemporal();

    this.players.forEach((p) => {
      p.guess = null;
      p.guessed = false;
    });

    const idx = this.locations[round - 1];
    const coord = this.coordenadas[idx];
    this.currentCoord = coord;

    if (this.role !== 'guest') {
      this.roundHeading = Math.floor(Math.random() * 360);
    }

    // Configurar modo estático/bloqueo de arrastre (modos estático y temporal)
    this.pano.setStatic(this.gameMode === 'static' || this.gameMode === 'temporal');
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
      // En solitario: cortina de carga activa hasta decodificar la imagen
      this.pano.setBlind(true, 'Cargando ubicación…', 'Preparando la imagen 360°', true);
      this.pano.setPano(coord.pano_id, this.roundHeading, 0);

      this.pano.waitForReady()
        .catch(() => {})
        .then(() => {
          if (this.state !== 'playing' || this.currentRound !== round) return;
          this.pano.setBlind(false);
          this._startSoloRoundTimer(round);
          if (this.gameMode === 'temporal') {
            this._startTemporalCountdown(this.temporalSeconds);
          }
        });
      return;
    }

    // Multijugador: Barrera de sincronización anti-trampas
    this.pano.setBlind(true, 'Sincronizando jugadores…', 'Cargando la panorámica en segundo plano', true);
    this.pano.setPano(coord.pano_id, this.roundHeading, 0);

    if (this.role === 'host') {
      this._panoReadyPeers = new Set();
      if (this._syncTimeout) clearTimeout(this._syncTimeout);

      // Notificar a los invitados para que preparen y carguen la misma vista
      this.net.broadcast({
        type: 'roundStart',
        round,
        locationIndex: idx,
        heading: this.roundHeading,
        gameMode: this.gameMode,
        temporalSeconds: this.temporalSeconds,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          hp: typeof p.hp === 'number' && !isNaN(p.hp) ? p.hp : CONFIG.MAX_HP,
          score: p.score || 0,
        })),
      });

      // El anfitrión también espera a que su propio visor decodifique
      this.pano.waitForReady()
        .catch(() => {})
        .then(() => {
          this._panoReadyPeers.add(this.net.myId);
          this._checkAllPanoReady(round);
        });

      // Timeout de seguridad de 6s en caso de que algún jugador tenga lag severo
      this._syncTimeout = setTimeout(() => {
        this._triggerSyncStart(round);
      }, 6000);
    }
  }

  /** Host: comprueba si todos los jugadores reportaron imagen lista para dar la salida al unísono. */
  _checkAllPanoReady(round) {
    if (this.role !== 'host' || this._resolved || this.currentRound !== round) return;
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
    this._onSyncStart({ round, prepareSeconds: prepSecs });
  }

  _onSyncStart(data) {
    if (this.currentRound !== data.round) return;
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
        // Destapar la imagen al mismo milisegundo para todos
        this.pano.setBlind(false);
        this._activateRound(round);
        if (this.gameMode === 'temporal') {
          this._startTemporalCountdown(this.temporalSeconds);
        }
      }
    }, 1000);
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
    this.myGuess = { lat, lng };
    this.emit('confirm', { enabled: true });
  }

  confirmGuess() {
    if (this.mode === 'solo') {
      this._soloConfirm();
      return;
    }
    this._multiConfirm();
  }

  _soloConfirm() {
    if (this.state === 'result' || this._over) return;
    const guess = this.myGuess || null;
    this._clearTimers();
    this._clearTemporal();
    this.pano.setBlind(false);
    this.pano.setStatic(false);
    this.emit('temporalBlind', { active: false });

    // Descontar únicamente el tiempo jugado en la ronda activa (pausa el reloj durante los resultados)
    const elapsedSec = this.soloRoundStartTime ? (Date.now() - this.soloRoundStartTime) / 1000 : 0;
    this.soloRemainingSeconds = Math.max(0, this.soloRemainingSeconds - elapsedSec);
    this.soloTotalPlayedMs += Math.round(elapsedSec * 1000);
    this.emit('timer', { seconds: Math.ceil(this.soloRemainingSeconds), danger: false });

    const { distance, score } = this._score(guess);
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
    };

    this.audio.confirm();
    this.emit('confirm', { enabled: false });
    this.emit('waiting', { waiting: false });
    this.state = 'result';
    this.emit('result', result);
  }

  _multiConfirm() {
    if (!this.myGuess || this.state === 'result' || this._over) return;
    this.audio.confirm();
    this._submitGuess(this.myGuess);
  }

  _submitGuess(guess) {
    const myClean = (this.meName || '').trim().toLowerCase();
    let me = this.players.find((p) =>
      (this.net.myId && p.id === this.net.myId) ||
      (myClean && (p.name || '').trim().toLowerCase() === myClean)
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
      me.guess = guess;
    }
    this.emit('confirm', { enabled: false });
    this.emit('waiting', { waiting: true });

    if (this.role === 'guest') {
      this.net.send({
        type: 'guess',
        round: this.currentRound,
        lat: guess ? Number(guess.lat) : null,
        lng: guess ? Number(guess.lng) : null,
        name: this.meName,
        senderId: me ? me.id : this.net.myId,
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
    // Asigna el timestamp límite para el temporizador maestro de rescate del anfitrión (BUG-06)
    this.hurryEnd = Date.now() + (totalSeconds + 3) * 1000;
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
        const myClean = (this.meName || '').trim().toLowerCase();
        const me = this.players.find((p) =>
          (this.net.myId && p.id === this.net.myId) ||
          (myClean && (p.name || '').trim().toLowerCase() === myClean)
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

          // Tolerancia de red de 2.5 segundos para recibir paquetes de invitados en tránsito
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
          }, 2500);
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

  /** Elimina a un jugador desconectado durante la partida. */
  removePlayer(peerId) {
    if (!peerId) return;
    this.players = this.players.filter((p) => p.id !== peerId);
    if (this.players.length === 1 && !this._over) {
      this._endGame('forfeit');
      return;
    }
    if (this.players.length > 0 && this.players.every((p) => p.guessed) && !this._resolved) {
      this._resolveMultiRound();
    }
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
    this._clearPrepare();
    this._clearHurry();
    this._clearTemporal();
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
        this.temporalSeconds = Number(data.temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
        this._resolved = false;
        this._roundActive = false;
        this.myGuess = null;
        this._clearTemporal();

        // Configurar modo estático según regla
        this.pano.setStatic(this.gameMode === 'static');

        if (data.players && Array.isArray(data.players)) {
          this.players = data.players.map((dp) => ({
            id: dp.id,
            name: dp.name,
            score: dp.score || 0,
            hp: typeof dp.hp === 'number' && !isNaN(dp.hp) ? dp.hp : CONFIG.MAX_HP,
            guess: null,
            guessed: false,
          }));
        } else {
          this.players.forEach((p) => {
            p.guess = null;
            p.guessed = false;
            if (typeof p.hp !== 'number' || isNaN(p.hp)) p.hp = CONFIG.MAX_HP;
          });
        }

        const coord = this.coordenadas[data.locationIndex];
        this.currentCoord = coord;
        this.pano.setStatic(this.gameMode === 'static' || this.gameMode === 'temporal');
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

        // Barrera anti-trampas: cortina activa mientras se carga el panorama
        this.pano.setBlind(true, 'Sincronizando jugadores…', 'Cargando la panorámica en segundo plano', true);
        this.pano.setPano(coord.pano_id, this.roundHeading, 0);

        this.pano.waitForReady()
          .catch(() => {})
          .then(() => {
            if (this.state !== 'playing' || this.currentRound !== data.round) return;
            this.pano.setBlind(true, 'Esperando a los demás jugadores…', 'La ronda iniciará en sincronía');
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
        this._onSyncStart(data);
        break;
      }
      case 'tick':
        if (data.remaining !== undefined) {
          this.emit('timer', { seconds: data.remaining, danger: data.remaining <= 5 });
        }
        break;
      case 'guess': {
        if (this.role !== 'host') break;
        const senderName = (data.name || data.senderName || '').trim().toLowerCase();
        let p = this.players.find((x) => {
          const xName = (x.name || '').trim().toLowerCase();
          if (fromPeerId && x.id === fromPeerId) return true;
          if (data.senderId && x.id === data.senderId) return true;
          if (senderName && xName && xName === senderName) return true;
          return false;
        });
        if (!p && this.players.length === 2) {
          p = this.players.find((x) => {
            const xName = (x.name || '').trim().toLowerCase();
            const myClean = (this.meName || '').trim().toLowerCase();
            return x.id !== this.net.myId && xName !== myClean;
          });
        }
        if (p && (!p.guessed || p.guess == null)) {
          p.guessed = true;
          p.guess = (data.lat != null && data.lng != null && !isNaN(Number(data.lat)) && !isNaN(Number(data.lng)))
            ? { lat: Number(data.lat), lng: Number(data.lng) }
            : null;
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
    return { distance: d, score: scoreForDistance(d) };
  }

  /* ------------------------------------------------------------------ */
  /* Resolución de ronda (multijugador, host autoritativo)               */
  /* ------------------------------------------------------------------ */
  _resolveMultiRound() {
    if (this._resolved) return;
    this._resolved = true;
    this._clearTimers();
    this.state = 'result';

    const real = { lat: this.currentCoord.lat, lng: this.currentCoord.lng };
    const roundMult = damageMultiplier(this.currentRound);
    const penalty = getNoGuessPenalty(this.currentRound);

    // Actualizamos directamente en this.players para que el daño y los puntos persistan
    const results = this.players.map((p) => {
      const info = this._score(p.guess);
      p.score += info.score;

      let damage = 0;
      if (p.guess == null) {
        // Al no adivinar: 100 la 1ª ronda, 150 la 2ª, 200 la 3ª, etc. (+50 por ronda)
        damage = penalty;
      } else if (info.score < CONFIG.BASE_SCORE) {
        // Si adivinó, penalización proporcional a la desviación sin exceder la penalización por no adivinar
        const scoreDeficit = (CONFIG.BASE_SCORE - info.score) / CONFIG.BASE_SCORE;
        damage = Math.round(scoreDeficit * penalty);
      }
      // Aplica el multiplicador de daño según la ronda (BUG-04)
      damage = Math.round(damage * roundMult);
      p.hp = clamp(p.hp - damage, 0, CONFIG.MAX_HP);
      return {
        id: p.id,
        name: p.name,
        guess: p.guess,
        score: info.score,
        totalScore: p.score,
        distance: info.distance,
        hp: p.hp,
        damage,
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
    if (neutral.players.some((p) => p.damage > 0)) {
      if (result.wonRound) this.audio.roundWin();
      else this.audio.roundLose();
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
      }
    });

    const result = this._adaptResult(neutral);
    if (neutral.players.some((p) => p.damage > 0)) {
      if (result.wonRound) this.audio.roundWin();
      else this.audio.roundLose();
    }
    this.emit('result', result);
  }

  _adaptResult(neutral) {
    const me = neutral.players.find((p) => p.id === this.net.myId) || neutral.players[0];
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
      multiplier: neutral.multiplier,
      penalty: neutral.penalty || getNoGuessPenalty(neutral.round),
      wonRound: me.score >= CONFIG.BASE_SCORE,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Avance de ronda y fin de partida                                    */
  /* ------------------------------------------------------------------ */
  _scheduleAdvance() {
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
    const me = neutral.players.find((p) => p.id === this.net.myId) || neutral.players[0];
    return {
      mode: 'multi',
      total: neutral.total,
      reason: neutral.reason,
      players: neutral.players,
      me,
      rank: me.rank,
      won: me.rank === 1,
      myTotalScore: me.score,
      myHp: me.hp,
    };
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */
  _emitHud() {
    const me = this.players.find((p) => p.id === this.net.myId) || null;
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
    this.pano.setBlind(false);
    this.pano.setStatic(false);
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
    this._clearTemporal();
    if (this.pano) {
      this.pano.setBlind(false);
      this.pano.setStatic(false);
    }
    this.state = 'idle';
    this._over = false;
  }
}
