// ============================================================================
// net.js — Capa de red P2P con PeerJS (WebRTC DataChannel).
//
// Protocolo (mensajes JSON sobre un DataChannel 1:1 host<->guest):
//   guest -> host: { type:'join', name }
//                  { type:'guess', round, lat, lng }   (lat/lng null = sin guess)
//   host -> guest: { type:'players', players }
//                  { type:'full' }
//                  { type:'start', seed, rounds, locations:[...], mode }
//                  { type:'roundStart', round, locationIndex, duration }
//                  { type:'tick', round, remaining }
//                  { type:'opponentGuessed' }
//                  { type:'roundResult', ... }
//                  { type:'gameOver', ... }
//
// Salas públicas: el anfitrión se registra en `api.php` (listado + heartbeat).
// El listado público es opcional y solo funciona con un servidor PHP.
// ============================================================================

import { CONFIG } from './config.js';
import { generateCode } from './utils.js';

const API_URL = 'api.php';

export class Network {
  /**
   * @param {object} callbacks
   *  - onStatus(state)            'connecting' | 'host' | 'guest' | 'closed' | 'error'
   *  - onGuestJoin(peerId, name)
   *  - onGuestLeave()
   *  - onError(type)              'NO_EXISTE' | 'LLENA' | 'unavailable-id' | ...
   *  - onMessage(data)            mensaje decodificado
   */
  constructor(callbacks = {}) {
    this.cb = callbacks;
    this.peer = null;
    this.conn = null;
    this.role = null;        // 'host' | 'guest'
    this.myId = null;
    this.roomCode = '';      // código corto (solo privado)
    this.roomId = '';        // ID completo de PeerJS (PREFIX + código)
    this.isPublic = false;
    this.remoteName = '';
    this._targetPeerId = '';
    this._publicCount = 1;
    this._heartbeat = null;
    this._retry = 0;
    this._closing = false;
  }

  get isHost() {
    return this.role === 'host';
  }

  get connected() {
    return !!(this.conn && this.conn.open);
  }

  /** Serializa y envía un mensaje al otro jugador. */
  send(obj) {
    if (this.conn && this.conn.open) {
      this.conn.send(JSON.stringify(obj));
    }
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
    this._api('create', { id: this.roomId, name, limit: 2 }).then((ok) => {
      if (!ok && this.cb.onError) this.cb.onError('public-register');
    });
    this._startHeartbeat();
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeat = setInterval(() => {
      this._api('update', { id: this.roomId, count: this._publicCount }).catch(
        () => {}
      );
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
      this._api('update', { id: this.roomId, count: this._publicCount }).catch(
        () => {}
      );
    }
  }

  /* ------------------------------ HOST ---------------------------------- */
  createRoom(name, isPublic = false) {
    this.role = 'host';
    this.isPublic = isPublic;
    this._generateHostId();
    this._openPeer(this.roomId, name);
  }

  /* ------------------------------ GUEST --------------------------------- */
  joinRoom(code, name) {
    this.role = 'guest';
    this.isPublic = false;
    this.roomCode = code;
    this._targetPeerId = CONFIG.PEER_PREFIX + code;
    this._openPeer(null, name);
  }

  joinPublicRoom(peerId, name) {
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
    this._retry = 0;
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
      this._wireConn(conn, true);
      conn.on('open', () => {
        conn.send(JSON.stringify({ type: 'join', name }));
        if (this.cb.onStatus) this.cb.onStatus('guest');
      });
    });

    this.peer.on('connection', (conn) => {
      if (this.role !== 'host') return;
      if (this.conn && this.conn.open) {
        // Ya hay un rival: rechazar conexiones extra.
        conn.send(JSON.stringify({ type: 'full' }));
        setTimeout(() => conn.close(), 300);
        return;
      }
      this._wireConn(conn, false);
    });

    this.peer.on('error', (err) => {
      const type = err && err.type ? err.type : 'unknown';
      if (type === 'unavailable-id' && this.role === 'host') {
        // El ID ya estaba en uso: regenerar y reintentar.
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
      // Pérdida de conexión con el servidor de señalización: reintentar.
      if (this.peer && !this.peer.destroyed) {
        try {
          this.peer.reconnect();
        } catch (e) {}
      }
    });
  }

  _wireConn(conn, isGuestSide) {
    this.conn = conn;

    conn.on('data', (raw) => {
      let data = raw;
      if (typeof raw === 'string') {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          data = { type: 'raw', raw };
        }
      }

      if (data.type === 'join') {
        this.remoteName = data.name;
        if (this.cb.onGuestJoin) this.cb.onGuestJoin(conn.peer, data.name);
        return;
      }
      if (data.type === 'full') {
        this._emitError('LLENA');
        return;
      }

      if (this.cb.onMessage) this.cb.onMessage(data);
    });

    conn.on('close', () => {
      if (this._closing) return;
      this.conn = null;
      if (isGuestSide) {
        // El host cerró o se perdió la conexión.
        if (this.cb.onGuestLeave) this.cb.onGuestLeave('host-left');
      } else {
        if (this.cb.onGuestLeave) this.cb.onGuestLeave('guest-left');
      }
    });

    conn.on('error', () => {
      if (this.cb.onError) this.cb.onError('data-channel');
    });
  }

  _emitError(type) {
    if (this.cb.onStatus) this.cb.onStatus('error');
    if (this.cb.onError) this.cb.onError(type);
  }

  /** Cierra la conexión y destruye el Peer. */
  leave() {
    this._closing = true;
    this._clearHeartbeat();
    if (this.role === 'host' && this.isPublic && this.roomId) {
      this._api('delete', { id: this.roomId }).catch(() => {});
    }
    if (this.conn) {
      try {
        this.conn.close();
      } catch (e) {}
      this.conn = null;
    }
    if (this.peer) {
      try {
        this.peer.destroy();
      } catch (e) {}
      this.peer = null;
    }
    this.role = null;
    this.myId = null;
    this.roomCode = '';
    this.roomId = '';
    this.isPublic = false;
    this.remoteName = '';
    if (this.cb.onStatus) this.cb.onStatus('closed');
  }
}
