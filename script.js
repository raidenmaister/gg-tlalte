// Pega aquí tu API Key de Google Maps JavaScript API
// (https://console.cloud.google.com/apis/credentials)
const API_KEY = '';

const PLAYER_KEY = 'playerName';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const API_URL = 'api.php';

let coordenadas = [];
let currentIndex = 0;
let panorama = null;
let gameStarted = false;
let toastTimer = null;

let playerName = '';
let peer = null;
let myId = null;
let isHost = false;
let isPublic = false;
let roomCode = '';
let roomId = '';
let roomLimit = 0;
let connections = [];
let hostConn = null;
let players = [];
let heartbeatTimer = null;

const OVERLAYS = ['nameOverlay', 'menuOverlay', 'createRoomOverlay', 'joinRoomOverlay', 'lobbyOverlay'];

function showOverlay(id) {
    OVERLAYS.forEach((s) => document.getElementById(s).classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function hideAllOverlays() {
    OVERLAYS.forEach((s) => document.getElementById(s).classList.add('hidden'));
}

function updatePlayerLabel(name) {
    document.getElementById('playerLabel').textContent = name;
}

function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function showMenu(name) {
    playerName = name;
    document.getElementById('menuPlayerName').textContent = name;
    showOverlay('menuOverlay');
}

function setupPlayerName() {
    const input = document.getElementById('playerNameInput');
    const saved = localStorage.getItem(PLAYER_KEY);

    function saveName() {
        const name = input.value.trim();
        if (!name) return;
        localStorage.setItem(PLAYER_KEY, name);
        updatePlayerLabel(name);
        showMenu(name);
    }

    if (saved) {
        updatePlayerLabel(saved);
        showMenu(saved);
        return;
    }

    showOverlay('nameOverlay');
    input.focus();
    document.getElementById('saveNameBtn').addEventListener('click', saveName);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') saveName();
    });
}

function showError(message) {
    const el = document.getElementById('error');
    el.textContent = message;
    el.style.display = 'block';
}

function updateCounter() {
    document.getElementById('counter').textContent =
        `${currentIndex + 1} / ${coordenadas.length}`;
}

function showPano(index) {
    if (!panorama || !coordenadas.length) return;
    currentIndex = index;
    const coord = coordenadas[index];
    panorama.setPano(coord.pano_id);
    panorama.setPov({ heading: 0, pitch: 0 });
    document.getElementById('panoSelect').value = String(index);
    updateCounter();
}

function populateSelect() {
    const select = document.getElementById('panoSelect');
    select.innerHTML = '';
    coordenadas.forEach((coord, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = `${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)} (${coord.date})`;
        select.appendChild(option);
    });
    select.addEventListener('change', (e) => {
        showPano(parseInt(e.target.value, 10));
    });
}

function initMap() {
    panorama = new google.maps.StreetViewPanorama(
        document.getElementById('pano'),
        {
            pano: coordenadas[0].pano_id,
            pov: { heading: 0, pitch: 0 },
            zoom: 1,
            motionTracking: false,
            motionTrackingControl: false,
            fullscreenControl: true,
            addressControl: false,
            linksControl: true,
            enableCloseButton: false,
            visible: true
        }
    );
    showPano(0);
}

function startSolo() {
    if (gameStarted) return;
    gameStarted = true;
    hideAllOverlays();
    load();
}

async function load() {
    try {
        const response = await fetch('coordenadas_validas.json');
        coordenadas = await response.json();
        if (!coordenadas.length) throw new Error('Sin coordenadas');
        populateSelect();
        await loadGoogleMaps();
    } catch (err) {
        showError('Error al cargar coordenadas_validas.json. Asegúrate de que esté en la misma carpeta.');
    }
}

function loadGoogleMaps() {
    return new Promise((resolve, reject) => {
        if (window.google && google.maps) {
            initMap();
            resolve();
            return;
        }
        let key = API_KEY.trim();
        if (!key) {
            key = prompt('Pega tu Google Maps API Key:');
        }
        if (!key) {
            showError('Se necesita una API Key de Google Maps para cargar la panorámica.');
            reject(new Error('Sin API Key'));
            return;
        }
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&v=weekly`;
        script.async = true;
        script.onload = () => {
            try {
                initMap();
                resolve();
            } catch (e) {
                reject(e);
            }
        };
        script.onerror = () => {
            showError('No se pudo cargar la API de Google Maps. Revisa tu API Key.');
            reject(new Error('API load failed'));
        };
        document.head.appendChild(script);
    });
}

function generateCode() {
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return code;
}

function generatePublicId() {
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return id;
}

async function postData(action, data) {
    try {
        const body = new URLSearchParams(data);
        body.set('action', action);
        const res = await fetch(API_URL, {
            method: 'POST',
            body,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        const json = await res.json();
        return json.ok === true;
    } catch (e) {
        return false;
    }
}

async function fetchPublicRooms() {
    try {
        const res = await fetch(`${API_URL}?action=list`);
        const data = await res.json();
        if (data.ok) renderPublicList(data.rooms);
    } catch (e) {}
}

function renderPublicList(rooms) {
    const list = document.getElementById('publicList');
    const empty = document.getElementById('publicEmpty');
    list.innerHTML = '';

    if (!rooms.length) {
        empty.style.display = 'block';
        return;
    }
    empty.style.display = 'none';

    rooms.forEach((room) => {
        const li = document.createElement('li');
        li.className = 'public-room';

        const info = document.createElement('div');
        info.className = 'public-room-info';

        const name = document.createElement('span');
        name.className = 'public-room-name';
        name.textContent = room.name;

        const meta = document.createElement('span');
        meta.className = 'public-room-meta';
        meta.textContent = `${room.count}/${room.limit > 0 ? room.limit : '\u221E'} jugadores`;

        info.appendChild(name);
        info.appendChild(meta);

        const btn = document.createElement('button');
        btn.className = 'join-public-btn';
        const full = room.limit > 0 && room.count >= room.limit;
        btn.disabled = full;
        btn.textContent = full ? 'Llena' : 'Unirse';
        btn.addEventListener('click', () => joinPublicRoom(room));

        li.appendChild(info);
        li.appendChild(btn);
        list.appendChild(li);
    });
}

function renderLobby() {
    const hasCode = !!roomCode;
    document.getElementById('roomCodeSection').style.display = hasCode ? '' : 'none';
    document.getElementById('roomCodeValue').textContent = roomCode || '----';
    document.getElementById('roomCodeHint').textContent = isHost
        ? 'Comparte este código para que otros se unan'
        : 'Código de la sala';

    document.getElementById('lobbyTitle').textContent = isPublic
        ? 'Sala pública'
        : (isHost ? 'Sala privada' : 'Sala');

    const limitText = roomLimit > 0 ? roomLimit : '\u221E';
    document.getElementById('playersCount').textContent =
        `${players.length} / ${limitText}`;

    const list = document.getElementById('playersList');
    list.innerHTML = '';

    if (!isHost && players.length === 0) {
        const li = document.createElement('li');
        li.className = 'player-item';
        li.textContent = 'Conectando\u2026';
        li.style.color = '#888';
        list.appendChild(li);
        return;
    }

    players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'player-item';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = p.name;
        li.appendChild(name);

        const badges = document.createElement('span');
        badges.className = 'badges';
        if (p.isHost) {
            const host = document.createElement('span');
            host.className = 'host-badge';
            host.textContent = 'anfitri\u00f3n';
            badges.appendChild(host);
        }
        if (p.id === myId) {
            const you = document.createElement('span');
            you.className = 'you-badge';
            you.textContent = 't\u00fa';
            badges.appendChild(you);
        }
        li.appendChild(badges);

        list.appendChild(li);
    });
}

function broadcastPlayers() {
    const msg = { type: 'players', players, hostId: roomId, limit: roomLimit };
    connections.forEach((c) => {
        if (c.open) c.send(msg);
    });
}

function updateRoomRegistry() {
    if (!isHost || !isPublic || !roomId) return;
    postData('update', { id: roomId, count: players.length });
}

function startHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(updateRoomRegistry, 5000);
}

function handleHostData(conn, data) {
    if (data.type === 'join') {
        const existing = players.find((p) => p.id === conn.peer);
        if (!existing) {
            if (roomLimit > 0 && players.length >= roomLimit) {
                if (conn.open) conn.send({ type: 'full' });
                conn.close();
                return;
            }
            players.push({ id: conn.peer, name: data.name, isHost: false });
        } else {
            existing.name = data.name;
        }
        broadcastPlayers();
        renderLobby();
        updateRoomRegistry();
    }
}

function createRoom(publicRoom) {
    isHost = true;
    isPublic = publicRoom;
    players = [];
    connections = [];
    hostConn = null;

    if (publicRoom) {
        roomCode = '';
        roomId = generatePublicId();
    } else {
        roomCode = generateCode();
        roomId = roomCode;
    }
    myId = roomId;
    players.push({ id: roomId, name: playerName, isHost: true });

    showOverlay('lobbyOverlay');
    renderLobby();

    peer = new Peer(roomId);
    peer.on('open', () => {
        renderLobby();
        if (isPublic) {
            postData('create', { id: roomId, name: playerName, limit: roomLimit })
                .then((ok) => {
                    if (!ok) showToast('No se pudo registrar la sala p\u00fablica');
                });
            startHeartbeat();
        }
    });
    peer.on('connection', (conn) => {
        connections.push(conn);
        conn.on('data', (data) => handleHostData(conn, data));
        conn.on('close', () => {
            connections = connections.filter((c) => c !== conn);
            players = players.filter((p) => p.id !== conn.peer);
            broadcastPlayers();
            renderLobby();
            updateRoomRegistry();
        });
        conn.on('error', () => {});
    });
    peer.on('disconnected', () => {
        peer.reconnect();
    });
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') {
            peer.destroy();
            createRoom(publicRoom);
        } else {
            showToast('Error de conexi\u00f3n: ' + err.type);
        }
    });
}

function connectToRoom(peerId) {
    isHost = false;
    roomId = peerId;
    players = [];
    connections = [];
    hostConn = null;

    showOverlay('lobbyOverlay');
    renderLobby();

    peer = new Peer();
    peer.on('open', () => {
        myId = peer.id;
        hostConn = peer.connect(peerId, { reliable: true });
        hostConn.on('open', () => {
            hostConn.send({ type: 'join', name: playerName });
        });
        hostConn.on('data', (data) => {
            if (data.type === 'players') {
                players = data.players;
                if (typeof data.limit === 'number') roomLimit = data.limit;
                renderLobby();
            } else if (data.type === 'full') {
                showToast('La sala est\u00e1 llena');
                leaveRoom();
            }
        });
        hostConn.on('close', () => {
            showToast('La sala se cerr\u00f3');
            leaveRoom();
        });
        hostConn.on('error', () => {
            showToast('No se pudo conectar a la sala');
            leaveRoom();
        });
    });
    peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
            showToast('No existe esa sala');
            leaveRoom();
        } else {
            showToast('Error de conexi\u00f3n: ' + err.type);
        }
    });
}

function joinPublicRoom(room) {
    isPublic = true;
    roomCode = '';
    roomLimit = room.limit || 0;
    connectToRoom(room.id);
}

function joinPrivateRoom(code) {
    isPublic = false;
    roomCode = code;
    connectToRoom(code);
}

function leaveRoom() {
    if (isHost && isPublic && roomId) {
        postData('delete', { id: roomId });
    }
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    if (hostConn) {
        try { hostConn.close(); } catch (e) {}
        hostConn = null;
    }
    connections.forEach((c) => {
        try { c.close(); } catch (e) {}
    });
    connections = [];
    if (peer) {
        try { peer.destroy(); } catch (e) {}
        peer = null;
    }
    players = [];
    isHost = false;
    isPublic = false;
    roomCode = '';
    roomId = '';
    myId = null;
    roomLimit = 0;
    showOverlay('menuOverlay');
}

function selectLimit(value) {
    roomLimit = value;
    document.querySelectorAll('.limit-btn').forEach((btn) => {
        btn.classList.toggle('selected', parseInt(btn.dataset.limit, 10) === value);
    });
}

document.getElementById('soloBtn').addEventListener('click', startSolo);

document.getElementById('createBtn').addEventListener('click', () => {
    showOverlay('createRoomOverlay');
});

document.getElementById('joinBtn').addEventListener('click', () => {
    document.getElementById('joinCodeInput').value = '';
    showOverlay('joinRoomOverlay');
    fetchPublicRooms();
    setTimeout(() => document.getElementById('joinCodeInput').focus(), 0);
});

document.getElementById('publicRoomBtn').addEventListener('click', () => createRoom(true));
document.getElementById('privateRoomBtn').addEventListener('click', () => createRoom(false));

document.getElementById('createBackBtn').addEventListener('click', () => showOverlay('menuOverlay'));
document.getElementById('joinBackBtn').addEventListener('click', () => showOverlay('menuOverlay'));
document.getElementById('leaveBtn').addEventListener('click', leaveRoom);

document.getElementById('joinRoomBtn').addEventListener('click', () => {
    const input = document.getElementById('joinCodeInput');
    const code = input.value.trim().toUpperCase();
    if (code.length !== 4) {
        showToast('El c\u00f3digo debe tener 4 caracteres');
        return;
    }
    joinPrivateRoom(code);
});

document.getElementById('joinCodeInput').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

document.querySelectorAll('.limit-btn').forEach((btn) => {
    btn.addEventListener('click', () => selectLimit(parseInt(btn.dataset.limit, 10)));
});

document.getElementById('prevBtn').addEventListener('click', () => {
    if (currentIndex > 0) showPano(currentIndex - 1);
});

document.getElementById('nextBtn').addEventListener('click', () => {
    if (currentIndex < coordenadas.length - 1) showPano(currentIndex + 1);
});

document.getElementById('randomBtn').addEventListener('click', () => {
    showPano(Math.floor(Math.random() * coordenadas.length));
});

setInterval(() => {
    const joinOverlay = document.getElementById('joinRoomOverlay');
    if (!joinOverlay.classList.contains('hidden')) fetchPublicRooms();
}, 3000);

setupPlayerName();
