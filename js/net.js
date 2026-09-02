// ============================================================================
// net.js — Capa de red híbrida: WebRTC (PeerJS) + Fallback HTTP Relay (PHP).
//
// Diseñado para funcionar SIEMPRE:
// 1. Intenta canal WebRTC directo (DataChannel vía PeerJS) para mínima latencia.
// 2. En paralelo y como respaldo automático, usa `api.php` como relay HTTP
//    (polling transparente). Si ambos dispositivos están tras el mismo NAT
//    sin Hairpin, en redes móviles o con firewall, la partida funciona
//    exactamente igual y sin requerir servidores TURN adicionales ni VPS.
// ============================================================================

import { CONFIG } from './config.js';
import { generateCode } from './utils.js';

const API_URL = 'api.php';

// Logs de diagnóstico de red.
const LOG = (...args) => console.log('[net]', ...args);

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
    this.roomId = '';           // ID completo (PREFIX + código)
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
    this._connTimeout = null;

    // Capa de transporte HTTP relay (solo respaldo cuando P2P no está activo)
    this._p2pConnected = false;
    this._pollTimer = null;
    this._lastPollSeq = 0;
    this._seenMids = new Set();
  }

  get isHost() {
    return this.role === 'host';
  }

  get players() {
    if (this.isHost) {
      const hostName = (this._localName || 'Anfitrión').trim();
      const list = [{ id: this.myId || 'host', name: hostName, isHost: true }];
      const seenNames = new Set([hostName.toLowerCase()]);
      this.guestNames.forEach((name, peerId) => {
        const clean = (name || 'Anónimo').trim();
        const lower = clean.toLowerCase();
        if (!seenNames.has(lower)) {
          seenNames.add(lower);
          list.push({ id: peerId, name: clean, isHost: false });
        }
      });
      return list;
    }
    return this._guestPlayers || [];
  }

  /** Actualiza la lista de jugadores que recibe un invitado. */
  setGuestPlayers(players, config) {
    this._guestPlayers = players || [];
    if (config) {
      this.rounds = config.rounds;
      this.limit = config.limit;
    }
  }

  /** Envía un mensaje al host (solo guest). */
  send(obj) {
    if (!obj._mid) obj._mid = generateCode(8) + '-' + Date.now();
    obj.senderId = this.myId;
    obj.senderName = this._localName;
    const conn = this.conns.get('__host__');
    let sentP2P = false;
    if (conn && conn.open) {
      try {
        conn.send(JSON.stringify(obj));
        sentP2P = true;
      } catch (e) {
        LOG('send P2P error, enviando por HTTP', e);
      }
    }
    // Si no hay P2P abierto o está negociando, enviar por relay HTTP
    if (!sentP2P && this.roomId) {
      this._api('send-msg', {
        id: this.roomId,
        from: this.myId || 'guest',
        to: this._targetPeerId || 'host',
        payload: JSON.stringify(obj),
      });
    }
  }

  /**
   * Envía un mensaje a todos los invitados (solo host).
   */
  broadcast(obj) {
    if (!obj._mid) obj._mid = generateCode(8) + '-' + Date.now();
    obj.senderId = this.myId;
    obj.senderName = this._localName;
    let raw = null;
    let p2pCount = 0;
    this.conns.forEach((conn, peerId) => {
      if (peerId === '__host__' || !conn || !conn.open) return;
      if (raw === null) raw = JSON.stringify(obj);
      try {
        conn.send(raw);
        p2pCount++;
      } catch (e) {}
    });

    // Si hay invitados que no tienen canal P2P abierto o no hay ninguno,
    // se transmite por el relay HTTP
    if (this.roomId && (p2pCount < this.guestNames.size || p2pCount === 0)) {
      this._api('send-msg', {
        id: this.roomId,
        from: this.myId || 'host',
        to: 'all',
        payload: JSON.stringify(obj),
      });
    }
  }

  /** Envía un mensaje a un peer específico (host -> guest o viceversa). */
  sendTo(peerId, obj) {
    if (!obj._mid) obj._mid = generateCode(8) + '-' + Date.now();
    obj.senderId = this.myId;
    obj.senderName = this._localName;
    const conn = this.conns.get(peerId);
    if (conn && conn.open) {
      try {
        conn.send(JSON.stringify(obj));
        return;
      } catch (e) {}
    }
    if (this.roomId) {
      this._api('send-msg', {
        id: this.roomId,
        from: this.myId || (this.isHost ? 'host' : 'guest'),
        to: peerId,
        payload: JSON.stringify(obj),
      });
    }
  }

  /**
   * Host expulsa a un jugador de la sala.
   * @param {string} peerId ID del peer a expulsar.
   * @param {string} [playerName] Nombre del jugador expulsado.
   */
  kickPlayer(peerId, playerName = '') {
    if (!this.isHost) return;
    LOG('kickPlayer', { peerId, playerName });
    const targetName = (playerName || '').trim().toLowerCase();

    // 1. Enviar orden de expulsión al invitado
    if (peerId) {
      this.sendTo(peerId, {
        type: 'kicked',
        reason: 'El anfitrión te expulsó de la sala',
      });
    }

    // 2. Cerrar la conexión y eliminar todas las instancias de ese jugador
    for (const [id, name] of this.guestNames.entries()) {
      if (id === peerId || (targetName && name.trim().toLowerCase() === targetName)) {
        const conn = this.conns.get(id);
        if (conn) {
          try {
            conn.send(JSON.stringify({ type: 'kicked', reason: 'El anfitrión te expulsó de la sala' }));
            conn.close();
          } catch (e) {}
          this.conns.delete(id);
        }
        this.guestNames.delete(id);
      }
    }

    // 3. Sincronizar nueva lista de jugadores con los restantes y el servidor PHP
    this._syncPlayers();

    if (this.cb.onGuestLeave) {
      this.cb.onGuestLeave(peerId, playerName);
    }
  }

  /* ------------------------- API PHP y Relay ---------------------------- */
  async _api(action, data = {}) {
    try {
      const body = new URLSearchParams(data);
      body.set('action', action);
      const res = await fetch(API_URL, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      return await res.json();
    } catch (e) {
      LOG('_api error', action, e);
      return null;
    }
  }

  /** Lista las salas públicas registradas en el servidor. */
  async listPublicRooms() {
    try {
      const res = await fetch(`${API_URL}?action=list`);
      const data = await res.json();
      if (data && data.ok) return data.rooms || [];
    } catch (e) {
      LOG('listPublicRooms ERROR', e);
    }
    return [];
  }

  _registerRoom(name, isPublic) {
    LOG('_registerRoom', { id: this.roomId, name, limit: this.limit, isPublic });
    this._api('create', {
      id: this.roomId,
      name,
      limit: this.limit,
      isPublic: isPublic ? 1 : 0,
    }).then((res) => {
      if ((!res || !res.ok) && isPublic && this.cb.onError) {
        this.cb.onError('public-register');
      }
    });
    this._startHeartbeat();
    this._startPolling();
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    // Las salas privadas NO gastan peticiones en PHP (100% P2P)
    if (!this.isPublic) return;
    this._heartbeat = setInterval(() => {
      if (!this.isPublic || this._closing) return;
      const count = this.isHost ? Math.max(1, this.players.length) : this._publicCount;
      this._api('update', { id: this.roomId, count }).catch(() => {});
    }, 10000); // 10 segundos = solo 6 hits por minuto
  }

  _clearHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  _startPolling() {
    this._stopPolling();
    // Polling ligero (2.5s) que se apaga automáticamente cuando WebRTC P2P conecta
    this._pollTimer = setInterval(async () => {
      if (this._closing || !this.roomId) return;
      // Si P2P ya está activo, no gastar CPU ni peticiones en PHP
      if (this._p2pConnected && this.conns.size > 0) {
        this._stopPolling();
        return;
      }
      const res = await this._api('poll-msgs', {
        id: this.roomId,
        peerId: this.myId || '',
        since: this._lastPollSeq || 0,
      });

      if (res && res.ok && Array.isArray(res.messages)) {
        if (typeof res.lastSeq === 'number' && res.lastSeq > this._lastPollSeq) {
          this._lastPollSeq = res.lastSeq;
        }
        for (const msg of res.messages) {
          try {
            const data = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
            this._handleIncoming(data, msg.from);
          } catch (e) {
            LOG('Error parseando mensaje', e);
          }
        }
      }
    }, 2500);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    this._lastPollSeq = 0;
  }

  updatePublicCount(count) {
    this._publicCount = Math.max(1, count || 1);
    if (this.isHost && this.roomId) {
      this._api('update', { id: this.roomId, count: this._publicCount }).catch(() => {});
    }
  }

  /* --------------------------- Procesamiento común ---------------------- */
  _handleIncoming(data, fromPeerId) {
    if (!data || typeof data !== 'object') return;

    // Deduplicación de mensajes (WebRTC vs HTTP)
    if (data._mid) {
      if (this._seenMids.has(data._mid)) return;
      this._seenMids.add(data._mid);
      if (this._seenMids.size > 300) {
        const first = this._seenMids.values().next().value;
        this._seenMids.delete(first);
      }
    }

    const peerId = data.senderId || fromPeerId;
    LOG('Incoming message:', data.type, 'from:', peerId);

    if (data.type === 'join') {
      const name = (data.name || data.senderName || 'Anónimo').trim();
      if (this.role === 'host') {
        const lower = name.toLowerCase();
        // Soporte de reconexión / deduplicación: si ya existía un invitado con este mismo nombre,
        // reemplazamos el peerId anterior por el nuevo sin bloquearlo por 'full'.
        for (const [oldPeerId, oldName] of this.guestNames.entries()) {
          if (oldName.trim().toLowerCase() === lower && oldPeerId !== peerId) {
            LOG('Reconexión / deduplicación de invitado:', name, 'reemplazando', oldPeerId, 'por', peerId);
            this.guestNames.delete(oldPeerId);
            const oldConn = this.conns.get(oldPeerId);
            if (oldConn) {
              try { oldConn.close(); } catch (e) {}
              this.conns.delete(oldPeerId);
            }
          }
        }

        if (this.guestNames.size >= this.limit - 1 && !this.guestNames.has(peerId)) {
          this.sendTo(peerId, { type: 'full' });
          return;
        }
        const isNew = !this.guestNames.has(peerId);
        this.guestNames.set(peerId, name);
        this.remoteName = name;
        if (isNew && this.cb.onGuestJoin) this.cb.onGuestJoin(peerId, name);
        this._syncPlayers();
      }
      return;
    }

    if (data.type === 'full') {
      this._emitError('LLENA');
      return;
    }

    if (data.type === 'players') {
      if (this.role === 'guest') {
        this.setGuestPlayers(data.players, data.config);
        if (this.cb.onStatus) this.cb.onStatus('guest');
        if (this.cb.onPlayers) this.cb.onPlayers(data.players, data.config);
        if (this._connTimeout) {
          clearTimeout(this._connTimeout);
          this._connTimeout = null;
        }
      }
      return;
    }

    if (data.type === 'kicked') {
      this._closing = true;
      this.leave();
      if (this.cb.onKicked) {
        this.cb.onKicked(data.reason || 'El anfitrión te expulsó de la sala');
      }
      return;
    }

    if (this.cb.onMessage) this.cb.onMessage(data, peerId);
  }

  /* ------------------------------ HOST ---------------------------------- */
  createRoom(name, isPublic = false, opts = {}) {
    LOG('createRoom', { name, isPublic, opts });
    this._resetConnection();
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

    // Registra la sala en api.php e inicia polling
    this._registerRoom(name, isPublic);

    // Intenta abrir PeerJS en paralelo
    this._openPeer(this.roomId, name);
  }

  rejoinHostRoom(saved) {
    LOG('rejoinHostRoom', saved);
    this._resetConnection();
    this._localName = saved.name || 'Anfitrión';
    this.role = 'host';
    this.isPublic = !!saved.isPublic;
    this.roomCode = saved.roomCode || '';
    this.roomId = saved.roomId || '';
    this.rounds = saved.rounds || CONFIG.DUEL_ROUNDS;
    this.limit = Math.min(
      CONFIG.ROOM_MAX_PLAYERS,
      Math.max(CONFIG.ROOM_MIN_PLAYERS, saved.limit || CONFIG.ROOM_MAX_PLAYERS)
    );
    this.conns.clear();
    this.guestNames.clear();

    this._registerRoom(this._localName, this.isPublic);
    this._openPeer(this.roomId, this._localName);
  }

  /* ------------------------------ GUEST --------------------------------- */
  joinRoom(code, name) {
    LOG('joinRoom', { code, name, target: CONFIG.PEER_PREFIX + code });
    this._resetConnection();
    this._localName = name;
    this.role = 'guest';
    this.isPublic = false;
    this.roomCode = code;
    this.roomId = CONFIG.PEER_PREFIX + code;
    this._targetPeerId = this.roomId;
    this.myId = 'guest-' + generateCode(6);

    if (this.cb.onStatus) this.cb.onStatus('connecting');

    // Iniciar polling y enviar join por HTTP de inmediato
    this._startPolling();
    this.send({ type: 'join', name });

    // Intento de conexión WebRTC en paralelo
    this._openPeer(null, name);

    // Timeout de seguridad: solo si tras 15s no hay respuesta ni por P2P ni por HTTP
    this._connTimeout = setTimeout(() => {
      if (!this._guestPlayers || this._guestPlayers.length === 0) {
        LOG('guest conn timeout (15s sin respuesta) → peer-unavailable');
        this._emitError('peer-unavailable');
      }
    }, 15000);
  }

  joinPublicRoom(peerId, name) {
    LOG('joinPublicRoom', { peerId, name });
    this._resetConnection();
    this._localName = name;
    this.role = 'guest';
    this.isPublic = true;
    this.roomCode = '';
    this.roomId = peerId;
    this._targetPeerId = peerId;
    this.myId = 'guest-' + generateCode(6);

    if (this.cb.onStatus) this.cb.onStatus('connecting');

    // Iniciar polling y enviar join por HTTP de inmediato
    this._startPolling();
    this.send({ type: 'join', name });

    // Intento de conexión WebRTC en paralelo
    this._openPeer(null, name);

    // Timeout de seguridad: solo si tras 15s no hay respuesta
    this._connTimeout = setTimeout(() => {
      if (!this._guestPlayers || this._guestPlayers.length === 0) {
        LOG('guest conn timeout (15s sin respuesta) → peer-unavailable');
        this._emitError('peer-unavailable');
      }
    }, 15000);
  }

  _resetConnection() {
    this._closing = false;
    this._clearHeartbeat();
    this._stopPolling();
    if (this._connTimeout) {
      clearTimeout(this._connTimeout);
      this._connTimeout = null;
    }
    this.conns.clear();
    this.guestNames.clear();
    this._guestPlayers = [];
    this._targetPeerId = '';
    this._publicCount = 1;
    this.myId = null;
    this.roomId = '';
    this._seenMids.clear();
    if (this.peer) {
      try { this.peer.destroy(); } catch (e) {}
      this.peer = null;
    }
  }

  _generateHostId() {
    if (this.isPublic) {
      this.roomId = CONFIG.PEER_PREFIX + generateCode(8);
      this.roomCode = '';
    } else {
      this.roomCode = generateCode();
      this.roomId = CONFIG.PEER_PREFIX + this.roomCode;
    }
    this.myId = this.roomId;
  }

  /* --------------------------- PeerJS (WebRTC) -------------------------- */
  _openPeer(peerId, name) {
    if (typeof Peer === 'undefined') {
      LOG('PeerJS no disponible, usando transporte HTTP');
      return;
    }

    try {
      this.peer = new Peer(peerId, {
        debug: 1,
        config: { iceServers: CONFIG.ICE_SERVERS },
      });
    } catch (e) {
      LOG('Error instanciando PeerJS', e);
      return;
    }

    this.peer.on('open', (id) => {
      LOG('peer open', id);
      if (this.role === 'host') {
        this.myId = id;
        if (this.cb.onStatus) this.cb.onStatus('host');
        return;
      }

      // Guest: intentar conectar con el host vía DataChannel
      LOG('guest → intentando DataChannel P2P al host', this._targetPeerId);
      const conn = this.peer.connect(this._targetPeerId, { reliable: true });
      this.conns.set('__host__', conn);
      this._wireConn(conn, true);

      conn.on('open', () => {
        LOG('guest DataChannel open!');
        // Enviar join por P2P también
        conn.send(JSON.stringify({ type: 'join', name }));
      });
    });

    this.peer.on('connection', (conn) => {
      LOG('peer connection entrante P2P', conn.peer);
      if (this.role !== 'host') return;

      if (this.guestNames.size >= this.limit - 1) {
        conn.send(JSON.stringify({ type: 'full' }));
        setTimeout(() => conn.close(), 300);
        return;
      }

      this.conns.set(conn.peer, conn);
      this._wireConn(conn, false);
    });

    this.peer.on('error', (err) => {
      LOG('PeerJS error (no crítico gracias a fallback HTTP):', err && err.type);
    });

    this.peer.on('disconnected', () => {
      if (this.peer && !this.peer.destroyed) {
        try { this.peer.reconnect(); } catch (e) {}
      }
    });
  }

  _wireConn(conn, isGuestSide) {
    conn.on('open', () => {
      LOG('P2P DataChannel abierto con éxito:', conn.peer, '-> Polling HTTP detenido (0% uso de PHP)');
      this._p2pConnected = true;
      this._stopPolling();
      if (isGuestSide) {
        conn.send(JSON.stringify({ type: 'join', name: this._localName }));
      }
    });

    conn.on('data', (raw) => {
      let data = raw;
      if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch (e) { data = { type: 'raw', raw }; }
      }
      this._handleIncoming(data, conn.peer);
    });

    conn.on('close', () => {
      LOG('conn close P2P', conn.peer);
      if (this._closing) return;
      if (isGuestSide) {
        this.conns.delete('__host__');
      } else {
        this.conns.delete(conn.peer);
        if (this.guestNames.has(conn.peer)) {
          this.guestNames.delete(conn.peer);
          this._syncPlayers();
        }
      }
      if (this.conns.size === 0) {
        this._p2pConnected = false;
        // Si aún estamos en la sala y se cayó P2P, reanudar polling ligero de emergencia
        if (!this._closing && this.roomId) {
          this._startPolling();
        }
      }
    });

    conn.on('error', (err) => {
      LOG('conn error P2P (tráfico continuará por HTTP)', err);
    });
  }

  _syncPlayers() {
    if (!this.isHost) return;
    const players = this.players;
    const config = { rounds: this.rounds, limit: this.limit };
    LOG('_syncPlayers', { count: players.length });
    this.broadcast({ type: 'players', players, config });
    this.updatePublicCount(players.length);
    if (this.cb.onPlayers) this.cb.onPlayers(players, config);
  }

  _emitError(type) {
    LOG('_emitError', type);
    if (this.cb.onStatus) this.cb.onStatus('error');
    if (this.cb.onError) this.cb.onError(type);
  }

  /** Cierra todas las conexiones y destruye el Peer. */
  leave() {
    this._closing = true;
    this._clearHeartbeat();
    this._stopPolling();
    if (this._connTimeout) {
      clearTimeout(this._connTimeout);
      this._connTimeout = null;
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
    this._seenMids.clear();
    if (this.cb.onStatus) this.cb.onStatus('closed');
  }
}
