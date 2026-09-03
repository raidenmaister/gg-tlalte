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

import { CONFIG } from './config.js?v=1.5.3';
import { generateCode } from './utils.js?v=1.5.3';

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

  /** Actualiza la lista de jugadores que recibe un invitado (deduplicada). */
  setGuestPlayers(players, config) {
    const seen = new Set();
    const cleanList = [];
    for (const p of (players || [])) {
      const key = (p.name || '').trim().toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        cleanList.push(p);
      }
    }
    this._guestPlayers = cleanList;
    if (config) {
      this.rounds = config.rounds;
      this.limit = config.limit;
      if (config.gameMode) this.gameMode = config.gameMode;
      if (config.temporalSeconds) this.temporalSeconds = config.temporalSeconds;
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
    LOG('_registerRoom', { id: this.roomId, name, limit: this.limit, isPublic, rounds: this.rounds, gameMode: this.gameMode });
    this._api('create', {
      id: this.roomId,
      name,
      limit: this.limit,
      isPublic: isPublic ? 1 : 0,
      rounds: this.rounds || CONFIG.DUEL_ROUNDS,
      gameMode: this.gameMode || 'normal',
      temporalSeconds: this.temporalSeconds || CONFIG.DEFAULT_TEMPORAL_SECONDS,
    }).then((res) => {
      if ((!res || !res.ok) && isPublic && this.cb.onError) {
        this.cb.onError('public-register');
      }
    });
    this._startHeartbeat();
    this._startPolling();
  }

  updateRoomStatus(status) {
    this.roomStatus = status;
    if (status === 'in_progress' || status === 'playing') {
      this._gameInProgress = true;
    } else if (status === 'waiting') {
      this._gameInProgress = false;
    }
    if (this.isHost && this.roomId) {
      const count = Math.max(1, this.players.length);
      this._api('update', { id: this.roomId, count, status }).catch(() => {});
    }
  }

  isGameInProgress() {
    if (typeof this.cb.isGameInProgress === 'function') {
      try { return !!this.cb.isGameInProgress(); } catch (e) {}
    }
    return !!this._gameInProgress;
  }

  isExistingActivePlayer(name) {
    if (typeof this.cb.isExistingActivePlayer === 'function') {
      try { return !!this.cb.isExistingActivePlayer(name); } catch (e) {}
    }
    const lower = (name || '').trim().toLowerCase();
    for (const [id, n] of this.guestNames.entries()) {
      if ((n || '').trim().toLowerCase() === lower) return true;
    }
    return false;
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this._heartbeat = setInterval(() => {
      if (this._closing || !this.roomId || !this.isHost) return;
      const count = Math.max(1, this.players.length);
      const status = this.isGameInProgress() ? 'in_progress' : (this.roomStatus || 'waiting');
      this._api('update', { id: this.roomId, count, status }).catch(() => {});
    }, 10000); // 10 segundos
  }

  _clearHeartbeat() {
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  _startPolling() {
    this._stopPolling();
    // Polling ligero (2.5s) que se apaga automáticamente cuando WebRTC P2P conecta con todos los clientes
    this._pollTimer = setInterval(async () => {
      if (this._closing || !this.roomId) return;
      // Si P2P ya está activo con todos los invitados (solo host), no gastar peticiones en PHP
      if (this.isHost && this._p2pConnected && this.conns.size >= this.guestNames.size && this.guestNames.size > 0) {
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
      } else if (res && !res.ok && !this.isHost && (res.error === 'sala no existe' || res.error === 'sala no encontrada' || res.error === 'sala cerrada')) {
        this._stopPolling();
        if (this.cb.onHostLeft) {
          this.cb.onHostLeft('El anfitrión abandonó o eliminó la sala.');
        } else if (this.cb.onGuestLeave) {
          this.cb.onGuestLeave(null);
        }
      }
    }, 2000);
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

    const peerId = fromPeerId || data.senderId;
    LOG('Incoming message:', data.type, 'from:', peerId, 'senderId:', data.senderId);

    if (data.type === 'join') {
      const name = (data.name || data.senderName || 'Anónimo').trim();
      if (this.role === 'host') {
        const lower = name.toLowerCase();

        // 0. Si la partida está en transcurso, NO permitir que un jugador externo se meta
        if (this.isGameInProgress()) {
          const isExisting = this.isExistingActivePlayer(name);
          if (!isExisting) {
            LOG('Partida en curso: rechazando a jugador externo', { name, peerId });
            this.sendTo(peerId, {
              type: 'in_progress',
              reason: 'La sala ya está en juego. No puedes unirte a una partida en curso.'
            });
            setTimeout(() => {
              const rejectedConn = this.conns.get(peerId);
              if (rejectedConn) {
                try { rejectedConn.close(); } catch (e) {}
                this.conns.delete(peerId);
              }
            }, 600);
            return;
          }
        }

        // 1. Verificar si este nombre ya estaba previamente en la sala
        let existingPeerId = null;
        for (const [oldPeerId, oldName] of this.guestNames.entries()) {
          if (oldName.trim().toLowerCase() === lower) {
            existingPeerId = oldPeerId;
            break;
          }
        }

        // 2. Calcular cuántos invitados únicos distintos hay actualmente
        const uniqueOtherGuests = new Set();
        for (const [id, n] of this.guestNames.entries()) {
          const nLower = n.trim().toLowerCase();
          if (nLower !== lower) {
            uniqueOtherGuests.add(nLower);
          }
        }

        // Capacidad total de invitados = limit - 1 (el anfitrión ocupa 1 slot)
        const maxGuestSlots = Math.max(1, this.limit - 1);

        // Si es un jugador nuevo y ya no hay cupos para nuevos invitados:
        if (!existingPeerId && uniqueOtherGuests.size >= maxGuestSlots) {
          LOG('Sala llena, rechazando a', name, { uniqueOthers: uniqueOtherGuests.size, maxGuestSlots });
          this.sendTo(peerId, { type: 'full' });
          setTimeout(() => {
            const rejectedConn = this.conns.get(peerId);
            if (rejectedConn) {
              try { rejectedConn.close(); } catch (e) {}
              this.conns.delete(peerId);
            }
          }, 500);
          return;
        }

        // 3. Si es reconexión o reemplazo de peerId anterior del mismo jugador:
        if (existingPeerId && existingPeerId !== peerId) {
          LOG('Actualizando conexión de invitado:', name, existingPeerId, '->', peerId);
          this.guestNames.delete(existingPeerId);
          const oldConn = this.conns.get(existingPeerId);
          if (oldConn) {
            try { oldConn.close(); } catch (e) {}
            this.conns.delete(existingPeerId);
          }
        }

        const isNew = !existingPeerId;
        this.guestNames.set(peerId, name);
        this.remoteName = name;
        if (isNew && this.cb.onGuestJoin) this.cb.onGuestJoin(peerId, name);
        this._syncPlayers();
      }
      return;
    }

    if (data.type === 'in_progress') {
      this.leave();
      this._emitError('EN_CURSO');
      return;
    }

    if (data.type === 'full') {
      this.leave();
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

    if (data.type === 'guestLeave') {
      if (this.role === 'host') {
        const pName = data.name || this.guestNames.get(peerId);
        this._handleGuestLeave(peerId, pName);
      }
      return;
    }

    if (data.type === 'hostLeft') {
      this._closing = true;
      this.leave();
      if (this.cb.onHostLeft) {
        this.cb.onHostLeft(data.reason || 'El anfitrión abandonó la partida.');
      } else if (this.cb.onGuestLeave) {
        this.cb.onGuestLeave(null);
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
    this.gameMode = opts.gameMode || 'normal';
    this.temporalSeconds = Number(opts.temporalSeconds) || CONFIG.DEFAULT_TEMPORAL_SECONDS;
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
    this.gameMode = saved.gameMode || 'normal';
    this.temporalSeconds = saved.temporalSeconds || CONFIG.DEFAULT_TEMPORAL_SECONDS;
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
        this.leave();
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
        this.leave();
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
    this._gameInProgress = false;
    this.roomStatus = 'waiting';
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
      LOG('P2P DataChannel abierto con éxito:', conn.peer);
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
        this._p2pConnected = false;
        // Si el host cerró la conexión P2P y no estamos en proceso de cierre voluntario,
        // el anfitrión abandonó o eliminó la sala.
        if (this.cb.onHostLeft) {
          this.cb.onHostLeft('El anfitrión abandonó o cerró la sala.');
        } else if (this.cb.onGuestLeave) {
          this.cb.onGuestLeave(null);
        }
      } else {
        const peerId = conn.peer;
        const pName = this.guestNames.get(peerId);
        this.conns.delete(peerId);
        if (this.guestNames.has(peerId)) {
          this.guestNames.delete(peerId);
          this._syncPlayers();
          if (this.cb.onGuestLeave) {
            this.cb.onGuestLeave(peerId, pName);
          }
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

    // Depuración activa de this.guestNames para eliminar duplicados huérfanos antes de transmitir
    const seen = new Set([this._localName.trim().toLowerCase()]);
    const toDelete = [];
    for (const [peerId, name] of this.guestNames.entries()) {
      const lower = (name || '').trim().toLowerCase();
      if (seen.has(lower)) {
        toDelete.push(peerId);
      } else {
        seen.add(lower);
      }
    }
    toDelete.forEach((id) => this.guestNames.delete(id));

    const players = this.players;
    const config = {
      rounds: this.rounds,
      limit: this.limit,
      gameMode: this.gameMode || 'normal',
      temporalSeconds: this.temporalSeconds || CONFIG.DEFAULT_TEMPORAL_SECONDS,
    };
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
  leave(reason = null) {
    if (this.isHost && !this._closing) {
      const msg = { type: 'hostLeft', reason: reason || 'El anfitrión abandonó la partida.' };
      try { this.broadcast(msg); } catch (e) {}
      if (this.roomId) {
        this._api('send-msg', { id: this.roomId, from: this.myId || 'host', to: 'all', payload: JSON.stringify(msg) });
        this._api('delete', { id: this.roomId });
      }
    } else if (!this.isHost && !this._closing) {
      const msg = { type: 'guestLeave', peerId: this.myId, name: this.myName };
      try { this.broadcast(msg); } catch (e) {}
      if (this.roomId) {
        this._api('send-msg', { id: this.roomId, from: this.myId || 'guest', to: 'host', payload: JSON.stringify(msg) });
      }
    }
    this._closing = true;
    this._clearHeartbeat();
    this._stopPolling();
    this._gameInProgress = false;
    this.roomStatus = 'waiting';
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
