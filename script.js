// Pega aquí tu API Key de Google Maps JavaScript API
// (https://console.cloud.google.com/apis/credentials)
const API_KEY = '';

const PLAYER_KEY = 'playerName';

let coordenadas = [];
let currentIndex = 0;
let panorama = null;
let gameStarted = false;
let toastTimer = null;

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
    document.getElementById('menuPlayerName').textContent = name;
    document.getElementById('menuOverlay').classList.remove('hidden');
}

function setupPlayerName() {
    const overlay = document.getElementById('nameOverlay');
    const input = document.getElementById('playerNameInput');
    const saved = localStorage.getItem(PLAYER_KEY);

    function saveName() {
        const name = input.value.trim();
        if (!name) return;
        localStorage.setItem(PLAYER_KEY, name);
        overlay.classList.add('hidden');
        updatePlayerLabel(name);
        showMenu(name);
    }

    if (saved) {
        overlay.classList.add('hidden');
        updatePlayerLabel(saved);
        showMenu(saved);
        return;
    }

    overlay.classList.remove('hidden');
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
    document.getElementById('menuOverlay').classList.add('hidden');
    if (gameStarted) return;
    gameStarted = true;
    load();
}

document.getElementById('soloBtn').addEventListener('click', startSolo);

document.getElementById('createBtn').addEventListener('click', () => {
    showToast('Crear sala: próximamente');
});

document.getElementById('joinBtn').addEventListener('click', () => {
    showToast('Unirse a sala: próximamente');
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

setupPlayerName();
