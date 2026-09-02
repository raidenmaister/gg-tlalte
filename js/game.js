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

    this.mode = 'solo'; // 'solo' | 'multi'
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
    this.soloStartTime = 0;
    this.locations = pickIndices(this.coordenadas.length, this.rounds);
    this._beginRound(1);
  }

  /** Host: inicia la partida y envía la semilla/orden a los invitados. */
  hostStart() {
    this._reset();
    this.mode = 'multi';
    this.role = 'host';
    this.rounds = this.net.rounds || CONFIG.DUEL_ROUNDS;

    this.players = this.net.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: 0,
      hp: CONFIG.MAX_HP,
      guess: null,
      guessed: false,
    }));

    const seed = (Math.random() * 0xffffffff) >>> 0;
    this.locations = pickIndices(this.coordenadas.length, this.rounds);

    this.net.broadcast({
      type: 'start',
      seed,
      rounds: this.rounds,
      locations: this.locations,
      mode: 'multi',
      players: this.players.map((p) => ({ id: p.id, name: p.name })),
    });

    this._hostStarted = true;
    this._readyCount = 1; // el host ya está listo

    // No permitir iniciar un duelo si el anfitrión está solo
    if (this.players.length <= 1) {
      this.emit('toast', { message: 'Se necesitan al menos 2 jugadores para iniciar.', kind: 'error' });
      return;
    }

    // Timeout de seguridad: si en 3.5 segundos algún invitado tarda en cargar o responder 'ready',
    // arranca la ronda de todas formas para que la partida nunca se quede congelada.
    clearTimeout(this._readyTimer);
    this._readyTimer = setTimeout(() => {
      if (this.state !== 'playing' && this._hostStarted) {
        this._beginRound(1);
      }
    }, 3500);

    this.emit('toast', { message: 'Iniciando partida…', kind: 'info' });
  }

  /** Guest: recibe el mensaje 'start' del host. */
  guestOnStart(data) {
    this._reset();
    this.mode = 'multi';
    this.role = 'guest';
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
  }

  _beginRound(round) {
    this.currentRound = round;
    this.state = 'playing';
    this._resolved = false;
    this._roundActive = false;
    this.myGuess = null;

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

    this.pano.setPano(coord.pano_id, this.roundHeading, 0);
    this.map.reset();
    this.map.setInteractive(false);

    this.emit('waiting', { waiting: false });
    this.emit('confirm', { enabled: false });
    this._emitHud();

    if (this.mode === 'solo') {
      // En solitario el reloj global no arranca hasta que el panorama esté
      // visible, para no quemar tiempo en una pantalla de carga.
      this.pano.waitForReady()
        .catch(() => {})
        .then(() => this._startSoloRoundTimer(round));
      return;
    }

    const prepSecs = CONFIG.PREPARE_DURATION || 3;

    if (this.role === 'host') {
      this.net.broadcast({
        type: 'roundStart',
        round,
        locationIndex: idx,
        heading: this.roundHeading,
        prepareSeconds: prepSecs,
        players: this.players.map((p) => ({
          id: p.id,
          name: p.name,
          hp: typeof p.hp === 'number' && !isNaN(p.hp) ? p.hp : CONFIG.MAX_HP,
          score: p.score || 0,
        })),
      });
      this._startPrepare(prepSecs, round);
    } else {
      this._startPrepare(prepSecs, round);
    }
  }

  /** Arranca la fase de adivinar en solitario (una vez cargada la imagen). */
  _startSoloRoundTimer(round) {
    if (this.state !== 'playing' || this.currentRound !== round) return;
    // El reloj global de la partida solo se fija en la primera ronda.
    // En rondas posteriores ya viene corriendo y no debe reiniciarse.
    if (!this.soloStartTime) this.soloStartTime = Date.now();
    this._activateRound(round);
  }

  /**
   * Fase "prepárate": cuenta atrás fija de 3 segundos (sin depender del reloj del SO).
   */
  _startPrepare(durationSeconds, round) {
    this._clearPrepare();
    let left = durationSeconds || CONFIG.PREPARE_DURATION || 3;
    this.emit('prepare', { seconds: left });

    this._prepare = setInterval(() => {
      left--;
      if (left > 0) {
        this.emit('prepare', { seconds: left });
      } else {
        this._clearPrepare();
        this._activateRound(round);
      }
    }, 1000);
  }

  /** Activa el temporizador de adivinar y habilita el minimapa. */
  _activateRound(round) {
    this._roundActive = true;
    this.map.setInteractive(true);
    this.emit('prepare', { seconds: null });

    const now = Date.now();
    if (this.mode === 'solo') {
      this.roundEnd = this.soloStartTime + this.soloTotalSeconds * 1000;
    } else {
      // Multijugador: sin límite de tiempo por ronda.
      this.roundEnd = 0;
    }
    this.emit('timer', {
      seconds: this.mode === 'solo' ? Math.max(0, Math.ceil((this.roundEnd - now) / 1000)) : null,
      danger: false,
    });

    if (this.role === 'host') {
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

  /* ------------------------------------------------------------------ */
  /* Colocación de marcador y confirmación                               */
  /* ------------------------------------------------------------------ */
  placePick(lat, lng) {
    if (this.state === 'result' || this._over || !this._roundActive) return;
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
    if (!this.myGuess || this.state === 'result' || this._over || !this._roundActive) return;
    this.audio.confirm();
    this._submitGuess(this.myGuess);
  }

  _submitGuess(guess) {
    let me = this.players.find((p) => p.id === this.net.myId);
    if (!me && this.role === 'host') {
      me = this.players.find((p) => p.isHost || p.id === this.net.roomId);
    }
    if (!me && this.players.length === 2 && this.role === 'guest') {
      me = this.players.find((p) => p.id !== this.net.roomId && !p.isHost);
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
        lat: guess ? guess.lat : null,
        lng: guess ? guess.lng : null,
      });
    } else if (this.role === 'host') {
      if (this._allGuessed()) {
        this._clearHurry();
        this._resolveMultiRound();
      } else {
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
    this.net.broadcast({
      type: 'hurryStart',
      round: this.currentRound,
      seconds,
      guesserName,
    });
    this._runHurryCountdown(seconds, guesserName);
  }

  _onHurryStart(data) {
    if (this._resolved) return;
    this._hurryActive = true;
    const seconds = data.seconds || CONFIG.OPPONENT_COUNTDOWN || 15;
    const guesserName = data.guesserName || '';
    this._runHurryCountdown(seconds, guesserName);
  }

  _runHurryCountdown(totalSeconds, guesserName = '') {
    this._clearHurryTimer();
    let left = totalSeconds;
    this.emit('countdown', { seconds: left, guesserName });
    this._hurry = setInterval(() => {
      left--;
      if (left >= 0) {
        this.emit('countdown', { seconds: left, guesserName });
      }
      if (left <= 0) {
        this._clearHurry();
        this.emit('countdown', { seconds: null });
        if (this.role === 'host' && !this._resolved) {
          this.players.forEach((p) => {
            if (!p.guessed) {
              p.guessed = true;
              p.guess = null;
            }
          });
          this._resolveMultiRound();
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
    this._clearPrepare();
    this._clearHurry();
    this._master = null;
    this._tick = null;
    this._resultTimer = null;
    this._readyTimer = null;
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
        this.currentRound = data.round;
        this.state = 'playing';
        this.roundHeading = data.heading || 0;
        this._resolved = false;
        this._roundActive = false;
        this.myGuess = null;

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
        this.pano.setPano(coord.pano_id, this.roundHeading, 0);
        this.map.reset();
        this.map.setInteractive(false);
        this.emit('waiting', { waiting: false });
        this.emit('confirm', { enabled: false });
        this._emitHud();

        const prepSecs = data.prepareSeconds || CONFIG.PREPARE_DURATION || 3;
        this._startPrepare(prepSecs, this.currentRound);
        break;
      }
      case 'tick':
        if (data.remaining !== undefined) {
          this.emit('timer', { seconds: data.remaining, danger: data.remaining <= 5 });
        }
        break;
      case 'guess': {
        if (this.role !== 'host') break;
        let p = this.players.find((x) => x.id === fromPeerId || (data.senderId && x.id === data.senderId));
        if (!p && this.players.length === 2) {
          p = this.players.find((x) => x.id !== this.net.myId && !x.isHost);
        }
        if (p && !p.guessed) {
          p.guessed = true;
          p.guess = (data.lat != null && data.lng != null)
            ? { lat: data.lat, lng: data.lng }
            : null;
        }
        if (this._allGuessed() && !this._resolved) {
          this._clearHurry();
          this._resolveMultiRound();
        } else if (!this._resolved && !this._hurryActive) {
          // El primer jugador en adivinar dispara el contador de 15s para los demás con su nombre
          this._startHurry(p ? p.name : 'Un rival');
        }
        break;
      }
      case 'hurryStart':
        this._onHurryStart(data);
        break;
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
  /* Resolución de ronda (multijugador, host autoritativo)               */
  /* ------------------------------------------------------------------ */
  _resolveMultiRound() {
    this._resolved = true;
    this._clearTimers();
    this.state = 'result';

    const real = { lat: this.currentCoord.lat, lng: this.currentCoord.lng };
    const scored = this.players.map((p) => {
      const info = this._score(p.guess);
      p.score += info.score;
      return { ...p, distance: info.distance, roundScore: info.score };
    });

    const roundMult = damageMultiplier(this.currentRound);

    const results = scored.map((p) => {
      let damage = 0;
      if (p.guess == null) {
        // Si no adivinó: penalización moderada (por defecto 1200 HP) en vez de 5000 puntos
        damage = Math.round((CONFIG.NO_GUESS_PENALTY || 1200) * roundMult);
      } else if (p.roundScore < CONFIG.BASE_SCORE) {
        damage = Math.round((CONFIG.BASE_SCORE - p.roundScore) * roundMult * 0.45);
        damage = Math.min(damage, Math.round((CONFIG.MAX_ROUND_DAMAGE || 1800) * roundMult));
      }
      p.hp = clamp(p.hp - damage, 0, CONFIG.MAX_HP);
      return {
        id: p.id,
        name: p.name,
        guess: p.guess,
        score: p.roundScore,
        totalScore: p.score,
        distance: p.distance,
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
      const p = this.players.find((x) => x.id === r.id);
      if (p) {
        p.score = r.totalScore;
        p.hp = r.hp;
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
      wonRound: me.score >= CONFIG.BASE_SCORE,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Avance de ronda y fin de partida                                    */
  /* ------------------------------------------------------------------ */
  _scheduleAdvance() {
    this._resultTimer = setTimeout(() => {
      if (this._over) return;

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
      round: this.currentRound,
      total: this.rounds,
      multiplier: damageMultiplier(this.currentRound),
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
