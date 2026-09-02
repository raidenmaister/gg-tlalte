// ============================================================================
// game.js — Máquina de estados del juego: rondas, puntuación, HP y daño.
//
// Eventos emitidos hacia la UI (app.js):
//   'data'        {count}                         coordenadas cargadas
//   'hud'         {mode, round, total, me, opp, multiplier}
//   'timer'       {seconds, danger}
//   'confirm'     {enabled}                       botón confirmar habilitado
//   'waiting'     {waiting}                       ya adiviné, espero al rival
//   'countdown'   {seconds|null}                  banner cuenta regresiva rival
//   'result'      result                          resumen de ronda
//   'gameover'    result                          fin de partida
//   'toast'       {message, kind}
// ============================================================================

import { CONFIG, damageMultiplier } from './config.js';
import {
  haversineKm,
  scoreForDistance,
  computeDamage,
  pickIndices,
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

    this.mode = 'solo'; // 'solo' | 'duel'
    this.role = 'solo'; // 'solo' | 'host' | 'guest'
    this.state = 'idle';

    this.rounds = CONFIG.SOLO_ROUNDS;
    this.soloTotalSeconds = CONFIG.SOLO_MODES[CONFIG.SOLO_ROUNDS].totalSeconds;
    this.soloStartTime = 0;
    this.soloTimedOut = false;
    this.currentRound = 0;
    this.locations = [];      // índices dentro de coordenadas
    this.roundHeading = 0;
    this.currentCoord = null;

    this.myGuess = null;
    this.hostGuess = null;
    this.guestGuess = null;
    this.hostGuessed = false;
    this.guestGuessed = false;
    this.hostDeadline = 0;
    this.guestDeadline = 0;
    this.roundEnd = 0;

    this.hp = { me: CONFIG.MAX_HP, opp: CONFIG.MAX_HP };
    this.scores = { me: 0, opp: 0 };
    this.names = { me: '', opp: '' };

    this._resolved = false;
    this._over = false;
    this._hostStarted = false;
    this._roundActive = false;
    this.guestOffset = 0;   // reloj guest - reloj host (ms), estimado al inicio
    this._master = null;
    this._tick = null;
    this._countdown = null;
    this._prepare = null;
    this._resultTimer = null;
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
  startSolo(rounds = CONFIG.SOLO_ROUNDS) {
    const mode = CONFIG.SOLO_MODES[rounds] || CONFIG.SOLO_MODES[CONFIG.SOLO_ROUNDS];
    this._reset();
    this.mode = 'solo';
    this.role = 'solo';
    this.rounds = mode.rounds;
    this.soloTotalSeconds = mode.totalSeconds;
    this.soloStartTime = Date.now();
    this.locations = pickIndices(this.coordenadas.length, this.rounds);
    this._beginRound(1);
  }

  /** Host: inicia la partida y envía la semilla/orden al guest. */
  hostStart() {
    this._reset();
    this.mode = 'duel';
    this.role = 'host';
    this.rounds = CONFIG.DUEL_ROUNDS;
    this.names.me = this.meName;
    this.names.opp = this.net.remoteName || 'Rival';

    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.locations = pickIndices(this.coordenadas.length, this.rounds);

    this.net.send({
      type: 'start',
      seed,
      rounds: this.rounds,
      locations: this.locations,
      mode: 'duel',
      names: { host: this.names.me, guest: this.names.opp },
    });

    // Espera el 'ready' del guest antes de lanzar la ronda 1.
    this._hostStarted = false;
    this.emit('toast', { message: 'Esperando a que el rival cargue…', kind: 'info' });
  }

  /** Guest: recibe el mensaje 'start' del host. */
  guestOnStart(data) {
    this._reset();
    this.mode = 'duel';
    this.role = 'guest';
    this.rounds = data.rounds || CONFIG.DUEL_ROUNDS;
    this.locations = data.locations || [];
    this.names.me = data.names ? data.names.guest : this.meName;
    this.names.opp = data.names ? data.names.host : 'Anfitrión';
    // Espera el primer 'roundStart' del host.
    this.emit('toast', { message: '¡Comienza la partida!', kind: 'info' });
  }

  /* ------------------------------------------------------------------ */
  /* Bucle de rondas (común)                                             */
  /* ------------------------------------------------------------------ */
  _reset() {
    this._clearTimers();
    this.currentRound = 0;
    this.locations = [];
    this.myGuess = null;
    this.hostGuess = null;
    this.guestGuess = null;
    this.hostGuessed = false;
    this.guestGuessed = false;
    this.hp = { me: CONFIG.MAX_HP, opp: CONFIG.MAX_HP };
    this.scores = { me: 0, opp: 0 };
    this._resolved = false;
    this._over = false;
    this._hostStarted = false;
    this._roundActive = false;
    this.guestOffset = 0;
    this.currentCoord = null;
    this.soloTimedOut = false;
  }

  _beginRound(round) {
    this.currentRound = round;
    this.state = 'playing';
    this._resolved = false;
    this._roundActive = false;
    this.myGuess = null;
    this.hostGuess = null;
    this.guestGuess = null;
    this.hostGuessed = false;
    this.guestGuessed = false;

    const idx = this.locations[round - 1];
    const coord = this.coordenadas[idx];
    this.currentCoord = coord;

    if (this.role !== 'guest') {
      this.roundHeading = Math.floor(Math.random() * 360);
    }

    // Mostrar panorámica y preparar el minimapa (sin adivinar todavía).
    this.pano.setPano(coord.pano_id, this.roundHeading, 0);
    this.map.reset();
    this.map.setInteractive(false);

    this.emit('waiting', { waiting: false });
    this.emit('countdown', { seconds: null });
    this.emit('confirm', { enabled: false });
    this._emitHud();

    const now = Date.now();
    const prepareMs = this.mode === 'duel' ? CONFIG.PREPARE_DURATION * 1000 : 0;
    const startAt = now + prepareMs;

    if (this.role === 'host') {
      this.net.send({
        type: 'roundStart',
        round,
        locationIndex: idx,
        duration: CONFIG.ROUND_DURATION,
        heading: this.roundHeading,
        startAt,
        offset: this.guestOffset,
      });
      this._startPrepare(startAt, round);
    } else {
      // Solo: arranque inmediato.
      this._startPrepare(startAt, round);
    }
  }

  /**
   * Fase "prepárate": ambos jugadores ven el panorama y cuentan atrás hasta
   * `startAtLocal` (ya convertido al reloj local). Al llegar, activa la ronda.
   */
  _startPrepare(startAtLocal, round) {
    this._clearPrepare();
    const remaining = startAtLocal - Date.now();
    this.emit('prepare', { seconds: remaining > 0 ? Math.ceil(remaining / 1000) : 0 });

    if (remaining <= 0) {
      this._activateRound(round);
      return;
    }

    let last = -1;
    this._prepare = setInterval(() => {
      const left = startAtLocal - Date.now();
      const secs = Math.ceil(left / 1000);
      if (secs !== last) {
        last = secs;
        this.emit('prepare', { seconds: secs });
      }
      if (left <= 0) {
        this._clearPrepare();
        this._activateRound(round);
      }
    }, 100);
  }

  /** Activa el temporizador de adivinar y habilita el minimapa. */
  _activateRound(round) {
    this._roundActive = true;
    this.map.setInteractive(true);
    this.emit('prepare', { seconds: null });

    const now = Date.now();
    if (this.mode === 'solo') {
      // Temporizador global: tiempo máximo para TODAS las rondas.
      this.roundEnd = this.soloStartTime + this.soloTotalSeconds * 1000;
    } else {
      this.roundEnd = now + CONFIG.ROUND_DURATION * 1000;
    }
    this.emit('timer', {
      seconds: Math.max(0, Math.ceil((this.roundEnd - now) / 1000)),
      danger: false,
    });

    if (this.role === 'host') {
      this.hostDeadline = now + CONFIG.ROUND_DURATION * 1000;
      this.guestDeadline = now + CONFIG.ROUND_DURATION * 1000;
      this._startHostTimers();
    } else if (this.role === 'guest') {
      this._startGuestTimers();
    } else {
      this._startSoloTimers();
    }
  }

  _clearPrepare() {
    if (this._prepare) {
      clearInterval(this._prepare);
      this._prepare = null;
    }
  }

  /** Sincroniza el reloj con el guest (estima el offset guest - host). */
  _syncClock() {
    this.net.send({ type: 'sync', t0: Date.now() });
  }

  /* ------------------------------------------------------------------ */
  /* Colocación de marcador y confirmación                               */
  /* ------------------------------------------------------------------ */
  placePick(lat, lng) {
    if (this.state === 'result' || this._over || !this._roundActive) return;
    this.myGuess = { lat, lng };
    const guessed = this.role === 'host' ? this.hostGuessed : this.guestGuessed;
    if (this.role === 'solo') {
      this.emit('confirm', { enabled: true });
    } else if (!guessed) {
      this.emit('confirm', { enabled: true });
    }
  }

  confirmGuess() {
    if (this.mode === 'solo') {
      this._soloConfirm();
      return;
    }
    this._duelConfirm();
  }

  _soloConfirm() {
    if (this.state === 'result' || this._over || !this._roundActive) return;
    const guess = this.myGuess || null;
    this._clearTimers();
    const { distance, score } = this._score(guess);
    this.scores.me += score;

    const result = {
      mode: 'solo',
      round: this.currentRound,
      total: this.rounds,
      real: { lat: this.currentCoord.lat, lng: this.currentCoord.lng },
      mine: guess,
      opp: null,
      myScore: score,
      oppScore: null,
      myDistanceKm: distance,
      oppDistanceKm: null,
      damage: null,
      myDamageTaken: null,
      oppDamageTaken: null,
      multiplier: null,
      winner: null,
      won: null,
      myHp: null,
      oppHp: null,
      myTotalScore: this.scores.me,
      oppTotalScore: null,
      names: { me: this.meName, opp: null },
    };

    this.audio.confirm();
    this.emit('confirm', { enabled: false });
    this.emit('waiting', { waiting: false });
    this.state = 'result';
    this.emit('result', result);
  }

  _duelConfirm() {
    if (!this.myGuess || this.state === 'result' || this._over || !this._roundActive) return;
    this.audio.confirm();
    this._submitGuess(this.myGuess);
  }

  _submitGuess(guess) {
    if (this.role === 'host') {
      if (this.hostGuessed) return;
      this.hostGuessed = true;
      this.hostGuess = guess;
      this.emit('confirm', { enabled: false });
      this.emit('waiting', { waiting: true });
      this.emit('countdown', { seconds: null });
      this._clearCountdown();
      if (!this.guestGuessed) {
        const d = Date.now() + CONFIG.OPPONENT_COUNTDOWN * 1000;
        this.guestDeadline = Math.min(this.guestDeadline, d);
        this.net.send({ type: 'opponentGuessed' });
      }
    } else if (this.role === 'guest') {
      if (this.guestGuessed) return;
      this.guestGuessed = true;
      this.guestGuess = guess;
      this.emit('confirm', { enabled: false });
      this.emit('waiting', { waiting: true });
      this.emit('countdown', { seconds: null });
      this._clearCountdown();
      this.net.send({
        type: 'guess',
        round: this.currentRound,
        lat: guess ? guess.lat : null,
        lng: guess ? guess.lng : null,
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Temporizadores                                                      */
  /* ------------------------------------------------------------------ */
  _startHostTimers() {
    this._clearTimers();
    let lastSecond = -1;

    this._master = setInterval(() => {
      const now = Date.now();

      // Auto-submit por vencimiento del plazo (principal o de 15s).
      if (!this.hostGuessed && now >= this.hostDeadline) {
        this.hostGuessed = true;
        this.hostGuess = null;
        this._clearCountdown();
        this.emit('confirm', { enabled: false });
        this.emit('waiting', { waiting: true });
        this.emit('countdown', { seconds: null });
      }
      if (!this.guestGuessed && now >= this.guestDeadline) {
        this.guestGuessed = true;
        this.guestGuess = null;
      }

      // Tick del HUD (1 por segundo).
      const remaining = Math.max(0, Math.ceil((this.roundEnd - now) / 1000));
      if (remaining !== lastSecond) {
        lastSecond = remaining;
        this.emit('timer', { seconds: remaining, danger: remaining <= 5 });
        this.net.send({ type: 'tick', round: this.currentRound, remaining });
      }

      if (this.hostGuessed && this.guestGuessed && !this._resolved) {
        this._resolveDuelRound();
      }
    }, 200);
  }

  _startGuestTimers() {
    this._clearTimers();
    this._tick = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((this.roundEnd - Date.now()) / 1000));
      if (remaining <= 0 && !this.guestGuessed && !this._resolved) {
        // Respaldo: si el host no cerró la ronda, auto-submit sin guess.
        this.guestGuessed = true;
        this.guestGuess = null;
        this.emit('confirm', { enabled: false });
        this.net.send({ type: 'guess', round: this.currentRound, lat: null, lng: null });
      }
    }, 1000);
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
        this.soloTimedOut = true;
        this._endSoloGame(); // se acabó el tiempo total de la partida
      }
    }, 250);
  }

  _startCountdown() {
    this._clearCountdown();
    let s = CONFIG.OPPONENT_COUNTDOWN;
    this.emit('countdown', { seconds: s });
    this._countdown = setInterval(() => {
      s -= 1;
      if (s <= 0) {
        this._clearCountdown();
        this.emit('countdown', { seconds: null });
        if (!(this.role === 'host' ? this.hostGuessed : this.guestGuessed)) {
          this._submitGuess(null);
        }
      } else {
        this.emit('countdown', { seconds: s });
        if (s <= 5) this.audio.countdownTick();
      }
    }, 1000);
  }

  _clearCountdown() {
    if (this._countdown) {
      clearInterval(this._countdown);
      this._countdown = null;
    }
  }

  _clearTimers() {
    if (this._master) clearInterval(this._master);
    if (this._tick) clearInterval(this._tick);
    if (this._resultTimer) clearTimeout(this._resultTimer);
    this._clearCountdown();
    this._clearPrepare();
    this._master = null;
    this._tick = null;
    this._resultTimer = null;
  }

  /* ------------------------------------------------------------------ */
  /* Red (mensajes entrantes)                                            */
  /* ------------------------------------------------------------------ */
  handleNetworkMessage(data) {
    switch (data.type) {
      case 'ready':
        if (this.role === 'host' && !this._hostStarted) {
          this._hostStarted = true;
          // Sincroniza el reloj con el guest y luego arranca la ronda 1.
          this._syncClock();
        }
        break;
      case 'sync':
        // Guest: responder con su marca de tiempo local (para estimar offset).
        this.net.send({ type: 'sync_reply', t0: data.t0, t1: Date.now() });
        break;
      case 'sync_reply': {
        // Host: estima offset = relojGuest - relojHost.
        const t3 = Date.now();
        const t0 = data.t0 || t3;
        const t1 = data.t1 || t3;
        this.guestOffset = ((t1 - t0) - (t3 - t1)) / 2;
        this._beginRound(1);
        break;
      }
      case 'roundStart': {
        this.currentRound = data.round;
        this.state = 'playing';
        this.roundHeading = data.heading || 0;
        this._resolved = false;
        this._roundActive = false;
        this.myGuess = null;
        this.hostGuess = null;
        this.guestGuess = null;
        this.hostGuessed = false;
        this.guestGuessed = false;

        const coord = this.coordenadas[data.locationIndex];
        this.currentCoord = coord;
        this.pano.setPano(coord.pano_id, this.roundHeading, 0);
        this.map.reset();
        this.map.setInteractive(false);
        this.emit('waiting', { waiting: false });
        this.emit('countdown', { seconds: null });
        this.emit('confirm', { enabled: false });
        this._emitHud();

        // Convierte el startAt (reloj host) al reloj local del guest.
        const startAt = data.startAt || Date.now();
        const offset = data.offset || 0;
        this._startPrepare(startAt + offset, this.currentRound);
        break;
      }
      case 'tick':
        if (data.remaining !== undefined) {
          this.emit('timer', { seconds: data.remaining, danger: data.remaining <= 5 });
        }
        break;
      case 'opponentGuessed':
        if (!this.guestGuessed) this._startCountdown();
        break;
      case 'guess': {
        if (this.role !== 'host' || this.guestGuessed) break;
        this.guestGuessed = true;
        this.guestGuess =
          data.lat != null && data.lng != null
            ? { lat: data.lat, lng: data.lng }
            : null;
        if (!this.hostGuessed) {
          this.hostDeadline = Math.min(
            this.hostDeadline,
            Date.now() + CONFIG.OPPONENT_COUNTDOWN * 1000
          );
          this._startCountdown();
        }
        break;
      }
      case 'roundResult':
        this._onRoundResult(data);
        break;
      case 'gameOver':
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
  /* Resolución de ronda (duelo, host autoritativo)                      */
  /* ------------------------------------------------------------------ */
  _resolveDuelRound() {
    this._resolved = true;
    this._clearTimers();
    this.state = 'result';

    const real = { lat: this.currentCoord.lat, lng: this.currentCoord.lng };
    const hostScoreInfo = this._score(this.hostGuess);
    const guestScoreInfo = this._score(this.guestGuess);

    const hostScore = hostScoreInfo.score;
    const guestScore = guestScoreInfo.score;

    let winner = null;
    if (hostScore > guestScore) winner = 'host';
    else if (guestScore > hostScore) winner = 'guest';

    const damage = winner
      ? computeDamage(
          Math.max(hostScore, guestScore),
          Math.min(hostScore, guestScore),
          this.currentRound
        )
      : 0;

    let hostDamageTaken = 0;
    let guestDamageTaken = 0;
    if (winner === 'host') {
      guestDamageTaken = damage;
      this.hp.opp = clamp(this.hp.opp - damage, 0, CONFIG.MAX_HP);
    } else if (winner === 'guest') {
      hostDamageTaken = damage;
      this.hp.me = clamp(this.hp.me - damage, 0, CONFIG.MAX_HP);
    }

    this.scores.me += hostScore;
    this.scores.opp += guestScore;

    const neutral = {
      round: this.currentRound,
      total: this.rounds,
      real,
      host: {
        name: this.names.me,
        guess: this.hostGuess,
        score: hostScore,
        distance: hostScoreInfo.distance,
        hp: this.hp.me,
        damageTaken: hostDamageTaken,
      },
      guest: {
        name: this.names.opp,
        guess: this.guestGuess,
        score: guestScore,
        distance: guestScoreInfo.distance,
        hp: this.hp.opp,
        damageTaken: guestDamageTaken,
      },
      winner,
      damage,
      multiplier: damageMultiplier(this.currentRound),
    };

    this.net.send({ type: 'roundResult', ...neutral });
    this._showDuelResult(neutral);
    this._scheduleAdvance();
  }

  _showDuelResult(neutral) {
    const result = this._adaptResult(neutral);
    if (neutral.damage > 0) {
      if (result.won) this.audio.roundWin();
      else this.audio.roundLose();
    }
    this.emit('result', result);
  }

  _onRoundResult(neutral) {
    this._clearTimers();
    this.state = 'result';
    this.hp.me = this.role === 'host' ? neutral.host.hp : neutral.guest.hp;
    this.hp.opp = this.role === 'host' ? neutral.guest.hp : neutral.host.hp;
    this.scores.me = this.role === 'host' ? neutral.host.score + this.scores.me : neutral.guest.score + this.scores.me;
    this.scores.opp = this.role === 'host' ? neutral.guest.score + this.scores.opp : neutral.host.score + this.scores.opp;

    const result = this._adaptResult(neutral);
    if (neutral.damage > 0) {
      if (result.won) this.audio.roundWin();
      else this.audio.roundLose();
    }
    this.emit('result', result);
  }

  _adaptResult(neutral) {
    const isHost = this.role === 'host';
    const me = isHost ? neutral.host : neutral.guest;
    const opp = isHost ? neutral.guest : neutral.host;
    return {
      mode: 'duel',
      round: neutral.round,
      total: neutral.total,
      real: neutral.real,
      mine: me.guess,
      opp: opp.guess,
      myScore: me.score,
      oppScore: opp.score,
      myDistanceKm: me.distance,
      oppDistanceKm: opp.distance,
      damage: neutral.damage,
      myDamageTaken: me.damageTaken,
      oppDamageTaken: opp.damageTaken,
      multiplier: neutral.multiplier,
      winner: neutral.winner,
      won: neutral.winner === this.role,
      myHp: me.hp,
      oppHp: opp.hp,
      myTotalScore: this.scores.me,
      oppTotalScore: this.scores.opp,
      names: { me: me.name, opp: opp.name },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Avance de ronda y fin de partida                                    */
  /* ------------------------------------------------------------------ */
  _scheduleAdvance() {
    this._resultTimer = setTimeout(() => {
      if (this._over) return;
      // Fin por KO (vida a 0).
      if (this.hp.me <= 0 || this.hp.opp <= 0) {
        this._endGame('hp');
        return;
      }
      // Fin por rondas.
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

    let winner = null;
    if (this.hp.me > this.hp.opp) winner = this.role === 'host' ? 'host' : 'guest';
    else if (this.hp.opp > this.hp.me) winner = this.role === 'host' ? 'guest' : 'host';

    const neutral = {
      winner,
      reason,
      total: this.rounds,
      host: { name: this.names.me, hp: this.hp.me, score: this.scores.me },
      guest: { name: this.names.opp, hp: this.hp.opp, score: this.scores.opp },
    };

    if (this.role === 'host') {
      this.net.send({ type: 'gameOver', ...neutral });
    }

    const result = this._adaptGameOver(neutral);
    if (result.won) this.audio.victory();
    else if (result.won === false) this.audio.defeat();
    else this.audio.roundLose();
    this.emit('gameover', result);
  }

  _onGameOver(neutral) {
    this._over = true;
    this.state = 'gameover';
    this._clearTimers();
    const result = this._adaptGameOver(neutral);
    if (result.won) this.audio.victory();
    else if (result.won === false) this.audio.defeat();
    else this.audio.roundLose();
    this.emit('gameover', result);
  }

  _adaptGameOver(neutral) {
    const isHost = this.role === 'host';
    const me = isHost ? neutral.host : neutral.guest;
    const opp = isHost ? neutral.guest : neutral.host;
    return {
      mode: 'duel',
      total: neutral.total,
      reason: neutral.reason,
      won: neutral.winner === this.role,
      winner: neutral.winner,
      names: { me: me.name, opp: opp.name },
      myHp: me.hp,
      oppHp: opp.hp,
      myTotalScore: me.score,
      oppTotalScore: opp.score,
    };
  }

  /* ------------------------------------------------------------------ */
  /* HUD                                                                 */
  /* ------------------------------------------------------------------ */
  _emitHud() {
    this.emit('hud', {
      mode: this.mode,
      round: this.currentRound,
      total: this.rounds,
      multiplier: damageMultiplier(this.currentRound),
      me: {
        name: this.names.me || this.meName || 'Tú',
        hp: this.hp.me,
        hpMax: CONFIG.MAX_HP,
        score: this.scores.me,
      },
      opp:
        this.mode === 'duel'
          ? {
              name: this.names.opp || 'Rival',
              hp: this.hp.opp,
              hpMax: CONFIG.MAX_HP,
              score: this.scores.opp,
            }
          : null,
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
    const elapsed = this.soloTimedOut
      ? this.soloTotalSeconds * 1000
      : Date.now() - this.soloStartTime;
    this.emit('gameover', {
      mode: 'solo',
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
    this.state = 'idle';
    this._over = false;
  }
}
