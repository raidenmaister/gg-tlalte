// ============================================================================
// net.js — Capa de red P2P con PeerJS (WebRTC DataChannel).
//
// Topología estrella: el anfitrión se conecta 1:1 con cada invitado.
//   guest -> host: { type:'join', name }
//                  { type:'guess', round, lat, lng }   (lat/lng null = sin guess)
//   host -> guest: { type:'players', players:[...], config:{rounds,limit} }
//                  { type:'full' }
//                  { type:'start', seed, rounds, locations:[...], mode:'multi' }
//                  { type:'roundStart', round, locationIndex, duration }
//                  { type:'tick', round, remaining }
//                  { type:'opponentGuessed' }
//                  { type:'roundResult', ... }
//                  { type:'gameOver', ... }
//
// Salas públicas: el anfitrión se registra en `api.php` (listado + heartbeat).
// ============================================================================

import { CONFIG } from './config.js';
import { generateCode } from './utils.js';

const API_URL = 'api.php';

export class Network {
  /**
   * @param {object} callbacks
   *  - onStatus(state)            'connecting' | 'host' | 'guest' | 'closed' | 'error'
   *  - onGuestJoin(peerId, name)
   *  - onGuestLeave(peerId)       peerId null = el guest perdió al host
   *  - onPlayers(players, config)
   *  - onError(type)              'NO_EXISTE' | 'LLENA' | 'unavailable-id' | ...
   *  - onMessage(data, fromPeerId) mensaje decodificado
   */
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.peer = null;
    this.role = null;           // 'host' | 'guest'
    this.myId = null;
    this.roomCode = '';         // código corto (solo privado)
    this.roomId = '';           // ID completo de PeerJS (PREFIX + código)
    this.isPublic = false;
    this.remoteName = '';

    this.conns = new Map();     // peerId -> DataConnection ('__host__' en guest)
    this.guestNames = new Map();// peerId -> nombre

    this.rounds = CONFIG.DUEL_ROUNDS;
    this.limit = CONFIG.ROOM_MAX_PLAYERS;

    this._localName = '';
    this._guestPlayers = [];
    this._targetPeerId = '';
    this._publicCount = 1;
    this._heartbeat = null;
    this._closing = false;
  }

  get isHost() {
    return this.role === 'host';
  }

  get players() {
    if (this.isHost) {
      const list = [{ id: this.myId, name: this._localName || 'Anfitrión', isHost: true }];
      this.guestNames.forEach((name, peerId) => {
        list.push({ id: peerId, name, isHost: false });
      });
      return list;
    }
    return this._guestPlayers || [];
  }

  /** Envía un mensaje al host (solo guest). */
  send(obj) {
    const conn = this.conns.get('__host__');
    if (conn && conn.open) {
      conn.send(JSON.stringify(obj));
    }
  }

  /**
   * Envía un mensaje a todos los invitados (solo host).
   * Serializa UNA sola vez para no repetir JSON.stringify por cada peer.
   */
  broadcast(obj) {
    let raw = null;
    this.conns.forEach((conn, peerId) => {
      if (peerId === '__host__' || !conn || !conn.open) return;
      if (raw === null) raw = JSON.stringify(obj);
      conn.send(raw);
    });
  }

  /* ------------------------- API de salas públicas ---------------------- */
  async _api(action, data = {}) {
    try {
      const body = new URLSearchParams(data);
      body.set('action', action);
      const res = await fetch(API_URL, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const json = await res.json();
      return json && json.ok === true;
    } catch (e) {
      return false;
    }
  }

  /** Lista las salas públicas registradas en el servidor. */
  async listPublicRooms() {
    try {
      const res = await fetch(`${API_URL}?action=list`);
      const data = await res.json();
      if (data && data.ok) return data.rooms || [];
    } catch (e) {}
    return [];
  }

  _registerPublicRoom(name) {
    this._api('create', { id: this.roomId, name, limit: this.limit }).then((ok) => {
      if (!ok && this.cb.onError) this.cb.onError('public-register');
    });
    this._startHeartbeat();
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeat = setInterval(() => {
      this._api('update', { id: this.roomId, count: this._publicCount }).catch(() => {});
    }, 5000);
  }

  _clearHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  /** Actualiza el nº de jugadores de una sala pública (y lo publica). */
  updatePublicCount(count) {
    this._publicCount = Math.max(1, count || 1);
    if (this.isHost && this.isPublic && this.roomId) {
      this._api('update', { id: this.roomId, count: this._publicCount }).catch(() => {});
    }
  }

  /* ------------------------------ HOST ---------------------------------- */
  createRoom(name, isPublic = false, opts = {}) {
    this._localName = name;
    this.role = 'host';
    this.isPublic = isPublic;
    this.rounds = opts.rounds || CONFIG.DUEL_ROUNDS;
    this.limit = Math.min(
      CONFIG.ROOM_MAX_PLAYERS,
      Math.max(CONFIG.ROOM_MIN_PLAYERS, opts.limit || CONFIG.ROOM_MAX_PLAYERS)
    );
    this.conns.clear();
    this.guestNames.clear();
    this._generateHostId();
    this._openPeer(this.roomId, name);
  }

  /* ------------------------------ GUEST --------------------------------- */
  joinRoom(code, name) {
    this._localName = name;
    this.role = 'guest';
    this.isPublic = false;
    this.roomCode = code;
    this._targetPeerId = CONFIG.PEER_PREFIX + code;
    this._openPeer(null, name);
  }

  joinPublicRoom(peerId, name) {
    this._localName = name;
    this.role = 'guest';
    this.isPublic = true;
    this.roomCode = '';
    this._targetPeerId = peerId;
    this._openPeer(null, name);
  }

  _generateHostId() {
    if (this.isPublic) {
      this.roomId = CONFIG.PEER_PREFIX + generateCode(8);
      this.roomCode = '';
    } else {
      this.roomCode = generateCode();
      this.roomId = CONFIG.PEER_PREFIX + this.roomCode;
    }
  }

  _openPeer(peerId, name) {
    this._closing = false;
    if (this.cb.onStatus) this.cb.onStatus('connecting');

    this.peer = new Peer(peerId, { debug: 0 });

    this.peer.on('open', (id) => {
      this.myId = id;

      if (this.role === 'host') {
        if (this.cb.onStatus) this.cb.onStatus('host');
        if (this.isPublic) this._registerPublicRoom(name);
        return;
      }

      // Guest: conectar con el host.
      const conn = this.peer.connect(this._targetPeerId, { reliable: true });
      this.conns.set('__host__', conn);
      this._wireConn(conn, true);
      conn.on('open', () => {
        conn.send(JSON.stringify({ type: 'join', name }));
        if (this.cb.onStatus) this.cb.onStatus('guest');
      });
    });

    this.peer.on('connection', (conn) => {
      if (this.role !== 'host') return;

      // Rechazar si ya se alcanzó el límite.
      if (this.guestNames.size >= this.limit - 1) {
        conn.send(JSON.stringify({ type: 'full' }));
        setTimeout(() => conn.close(), 300);
        return;
      }

      this.conns.set(conn.peer, conn);
      this._wireConn(conn, false);
    });

    this.peer.on('error', (err) => {
      const type = err && err.type ? err.type : 'unknown';
      if (type === 'unavailable-id' && this.role === 'host') {
        this.peer.destroy();
        this._generateHostId();
        this._openPeer(this.roomId, name);
        return;
      }
      if (type === 'peer-unavailable' && this.role === 'guest') {
        this._emitError('NO_EXISTE');
        return;
      }
      this._emitError(type);
    });

    this.peer.on('disconnected', () => {
      if (this.peer && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (e) {}
      }
    });
  }

  _wireConn(conn, isGuestSide) {
    conn.on('data', (raw) => {
      let data = raw;
      if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch (e) { data = { type: 'raw', raw }; }
      }

      if (data.type === 'join') {
        const name = data.name || 'Anónimo';
        if (this.role === 'host') {
          if (this.guestNames.size >= this.limit - 1) {
            conn.send(JSON.stringify({ type: 'full' }));
            setTimeout(() => conn.close(), 300);
            return;
          }
          this.guestNames.set(conn.peer, name);
          this.remoteName = name;
          if (this.cb.onGuestJoin) this.cb.onGuestJoin(conn.peer, name);
          this._syncPlayers();
        }
        return;
      }

      if (data.type === 'full') {
        this._emitError('LLENA');
        return;
      }

      if (this.cb.onMessage) this.cb.onMessage(data, conn.peer);
    });

    conn.on('close', () => {
      if (this._closing) return;
      if (isGuestSide) {
        this.conns.delete('__host__');
        if (this.cb.onGuestLeave) this.cb.onGuestLeave(null);
      } else {
        const peerId = conn.peer;
        this.conns.delete(peerId);
        this.guestNames.delete(peerId);
        this.updatePublicCount(this.players.length);
        if (this.cb.onGuestLeave) this.cb.onGuestLeave(peerId);
      }
    });

    conn.on('error', () => {
      if (this.cb.onError) this.cb.onError('data-channel');
    });
  }

  _syncPlayers() {
    if (!this.isHost) return;
    const players = this.players;
    const config = { rounds: this.rounds, limit: this.limit };
    this.broadcast({ type: 'players', players, config });
    this.updatePublicCount(players.length);
    if (this.cb.onPlayers) this.cb.onPlayers(players, config);
  }

  _emitError(type) {
    if (this.cb.onStatus) this.cb.onStatus('error');
    if (this.cb.onError) this.cb.onError(type);
  }

  /** Cierra todas las conexiones y destruye el Peer. */
  leave() {
    this._closing = true;
    this._clearHeartbeat();
    if (this.role === 'host' && this.isPublic && this.roomId) {
      this._api('delete', { id: this.roomId }).catch(() => {});
    }
    this.conns.forEach((conn) => {
      try { conn.close(); } catch (e) {}
    });
    this.conns.clear();
    this.guestNames.clear();
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
    this.role = null;
    this.myId = null;
    this.roomCode = '';
    this.roomId = '';
    this.isPublic = false;
    this.remoteName = '';
    this._guestPlayers = [];
    if (this.cb.onStatus) this.cb.onStatus('closed');
  }
}
