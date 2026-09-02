// ============================================================================
// app.js — Punto de entrada. Coordina UI, red, visor panorámico y juego.
// ============================================================================

import { $, formatKm, formatNumber } from './utils.js';
import { CONFIG } from './config.js';
import { audio } from './audio.js';
import { PanoramaViewer } from './panorama.js';
import { Minimap } from './minimap.js';
import { Network } from './net.js';
import { Game } from './game.js';

const PLAYER_KEY = 'ggtlalte:playerName';
const API_URL = 'api.php';

/* ----------------------------- Instancias ------------------------------ */
const pano = new PanoramaViewer('pano');
const minimap = new Minimap('minimap');
const net = new Network();
const game = new Game({ pano, map: minimap, net, audio });

/* ------------------------------ Estado UI ------------------------------ */
let meName = '';
let players = [];
let minimapPinned = false;
let viewersReady = false;
let dataPromise = null;

/* --------------------------- Utilidades DOM ---------------------------- */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.add('hidden'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.remove('hidden');
}

let toastTimer = null;
function showToast(message, kind = 'info') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function showError(message) {
  showToast(message, 'error');
}

function setLoadingText(text) {
  $('#loadingText').textContent = text;
}

/* --------------------------- API (PHP) ------------------------------- */
async function apiPost(action, data = {}) {
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
    return { ok: false, error: 'sin conexión con el servidor' };
  }
}

async function checkNameAvailable(name) {
  const json = await apiPost('check-name', { name });
  return !!(json && json.ok && json.available);
}

async function registerName(name) {
  return apiPost('register-name', { name });
}

async function saveScoreToLeaderboard(entry) {
  return apiPost('save-score', entry);
}

async function fetchLeaderboard(rounds) {
  try {
    const res = await fetch(`${API_URL}?action=leaderboard&rounds=${rounds}`);
    const data = await res.json();
    if (data && data.ok) return data.entries || [];
  } catch (e) {}
  return [];
}

/* --------------------------- Carga de datos ---------------------------- */
function ensureData() {
  if (!dataPromise) {
    dataPromise = game.loadData();
  }
  return dataPromise;
}

async function ensureViewers() {
  if (!viewersReady) {
    await pano.init();
    minimap.init();
    viewersReady = true;
  }
  minimap.refreshSize();
  // Refresco extra tras el primer layout, por si el contenedor aún no
  // tenía su tamaño final al inicializar Leaflet (evita tiles en blanco).
  requestAnimationFrame(() => minimap.refreshSize());
}

function gameInProgress() {
  return game.state === 'playing' || game.state === 'result';
}

/* --------------------------- Compás ------------------------------------ */
function updateCompass(heading) {
  const arrow = $('#compassArrow');
  if (!arrow) return;
  // El "N" apunta al norte: -heading (0° = mirando al norte => flecha arriba).
  arrow.style.transform = `rotate(${-((heading % 360) + 360) % 360}deg)`;
}

/* --------------------------- Minimapa ---------------------------------- */
function expandMinimap(force = true) {
  const wrap = $('#minimapWrap');
  if (force) {
    minimapPinned = true;
    wrap.classList.add('pinned');
  }
  wrap.classList.add('expanded');
  minimap.refreshSize();
}

function collapseMinimap() {
  const wrap = $('#minimapWrap');
  minimapPinned = false;
  wrap.classList.remove('pinned', 'expanded');
}

/* --------------------------- Render: HUD ------------------------------- */
function renderHud(hud) {
  collapseMinimap();
  minimap.setFullscreen(false);
  $('#resultPanel').classList.add('hidden');
  $('#resultPanel').classList.remove('result-overlay');
  $('#gameOverPanel').classList.add('hidden');
  const roundLabel = $('#hudRound');
  if (roundLabel) roundLabel.textContent = `RONDA ${hud.round}/${hud.total}`;

  const isDuel = hud.mode === 'duel';
  $('#hudScore').classList.toggle('hidden', isDuel);
  $('#hudHp').classList.toggle('hidden', !isDuel);

  if (!isDuel) {
    $('#hudScoreValue').textContent = formatNumber(hud.me.score);
  } else {
    updateHP(hud.me.hp, hud.opp.hp);
    $('#hpMeName').textContent = hud.me.name;
    $('#hpOppName').textContent = hud.opp.name;
  }

  if (hud.mode === 'duel') {
    const mult = hud.multiplier ? hud.multiplier.toFixed(1) : '1.0';
    $('#hudTimer').dataset.mult = `x${mult}`;
  } else {
    delete $('#hudTimer').dataset.mult;
  }
}

function updateHP(myHp, oppHp) {
  const mePct = (myHp / CONFIG.MAX_HP) * 100;
  const oppPct = (oppHp / CONFIG.MAX_HP) * 100;
  const meFill = $('#hpMeFill');
  const oppFill = $('#hpOppFill');
  meFill.style.width = mePct + '%';
  oppFill.style.width = oppPct + '%';
  meFill.classList.toggle('low', mePct <= 25);
  oppFill.classList.toggle('low', oppPct <= 25);
  $('#hpMeVal').textContent = Math.round(myHp);
  $('#hpOppVal').textContent = Math.round(oppHp);
}

function renderTimer({ seconds, danger }) {
  const el = $('#hudTimer');
  el.textContent = String(Math.max(0, seconds));
  el.classList.toggle('danger', !!danger);
}

function renderConfirm({ enabled }) {
  $('#confirmBtn').disabled = !enabled;
}

function renderWaiting({ waiting }) {
  $('#waitingBanner').classList.toggle('hidden', !waiting);
}

function renderCountdown({ seconds }) {
  const banner = $('#countdownBanner');
  const num = $('#countdownNumber');
  if (seconds == null || seconds <= 0) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    num.textContent = String(seconds);
    banner.classList.toggle('urgent', seconds <= 5);
  }
}

function renderPrepare({ seconds }) {
  const banner = $('#prepareBanner');
  const num = $('#prepareNumber');
  const timer = $('#hudTimer');
  if (seconds == null || seconds <= 0) {
    banner.classList.add('hidden');
    timer.classList.remove('prepare');
  } else {
    banner.classList.remove('hidden');
    num.textContent = String(seconds);
    timer.classList.add('prepare');
    timer.textContent = String(seconds);
  }
}

/* --------------------------- Render: resultados ------------------------ */
function statRow(label, value, cls = '') {
  return `<div class="stat-row ${cls}">
    <span class="stat-label">${label}</span>
    <span class="stat-value">${value}</span>
  </div>`;
}

function renderResult(result) {
  resetGuessUI();
  $('#gameOverPanel').classList.add('hidden');

  // Solo: mapa a pantalla completa + botón flotante de "siguiente".
  // Duelo: mantiene el panel con la info y el minimapa expandido.
  if (result.mode === 'solo') {
    minimap.setFullscreen(true);
    $('#resultPanel').classList.add('result-overlay');
  } else {
    minimap.setFullscreen(false);
    $('#resultPanel').classList.remove('result-overlay');
    expandMinimap(true);
  }

  // Revela la respuesta en el mapa (fitBounds con el tamaño ya correcto).
  minimap.setInteractive(false);
  minimap.reveal({
    real: result.real,
    mine: result.mine,
    opp: result.opp,
  });

  const title = $('#resultTitle');
  const stats = $('#resultStats');
  const nextBtn = $('#resultNextBtn');
  const note = $('#resultNote');

  if (result.mode === 'solo') {
    title.textContent = `Ronda ${result.round}/${result.total}`;
    title.className = 'panel-title panel-title-neutral';
    stats.innerHTML = [
      statRow('Distancia', result.myDistanceKm != null ? formatKm(result.myDistanceKm) : '—'),
      statRow('Puntos', '+' + formatNumber(result.myScore)),
      statRow('Total', formatNumber(result.myTotalScore)),
    ].join('');
    nextBtn.classList.remove('hidden');
    nextBtn.textContent = result.round >= result.total ? 'Ver resultados →' : 'Siguiente ronda →';
    note.classList.add('hidden');
    $('#hudScoreValue').textContent = formatNumber(result.myTotalScore);
  } else {
    const won = result.won;
    if (won === null) {
      title.textContent = 'Empate';
      title.className = 'panel-title panel-title-neutral';
    } else if (won) {
      title.textContent = '¡Ganaste la ronda!';
      title.className = 'panel-title panel-title-win';
    } else {
      title.textContent = 'Perdiste la ronda';
      title.className = 'panel-title panel-title-lose';
    }

    stats.innerHTML = [
      statRow('Tú', `${formatNumber(result.myScore)} pts · ${result.myDistanceKm != null ? formatKm(result.myDistanceKm) : 'sin guess'}`),
      statRow(result.names.opp, `${formatNumber(result.oppScore)} pts · ${result.oppDistanceKm != null ? formatKm(result.oppDistanceKm) : 'sin guess'}`),
      statRow('Multiplicador', 'x' + result.multiplier.toFixed(1)),
      statRow('Daño infligido', result.damage > 0 ? '-' + formatNumber(result.damage) + ' HP' : '0'),
    ].join('');

    nextBtn.classList.add('hidden');
    note.classList.remove('hidden');
    note.textContent = 'Siguiente ronda en unos segundos…';
    updateHP(result.myHp, result.oppHp);
  }

  $('#resultPanel').classList.remove('hidden');
}

async function handleGameOver(result) {
  renderGameOver(result);
  if (result.mode === 'solo' && meName) {
    await saveScoreToLeaderboard({
      name: meName,
      rounds: result.total,
      points: result.myTotalScore,
      timeMs: result.timeMs || 0,
    });
  }
}

function renderGameOver(result) {
  resetGuessUI();
  $('#resultPanel').classList.add('hidden');
  $('#resultPanel').classList.remove('result-overlay');
  minimap.setFullscreen(false);
  minimap.setInteractive(false);

  const title = $('#gameOverTitle');
  const stats = $('#gameOverStats');

  if (result.mode === 'solo') {
    title.textContent = result.timedOut ? '¡Tiempo agotado!' : '¡Partida terminada!';
    title.className = 'panel-title panel-title-neutral';
    stats.innerHTML = [
      statRow('Puntos totales', formatNumber(result.myTotalScore)),
      statRow('Rondas', String(result.total)),
      statRow('Tiempo', result.timedOut ? 'Límite alcanzado' : formatTime(result.timeMs)),
    ].join('');
  } else {
    if (result.won === null) {
      title.textContent = 'Empate';
      title.className = 'panel-title panel-title-neutral';
    } else if (result.won) {
      title.textContent = '¡VICTORIA!';
      title.className = 'panel-title panel-title-win';
    } else {
      title.textContent = 'Derrota';
      title.className = 'panel-title panel-title-lose';
    }
    stats.innerHTML = [
      statRow(result.names.me, `${formatNumber(result.myTotalScore)} pts · ${formatNumber(result.myHp)} HP`),
      statRow(result.names.opp, `${formatNumber(result.oppTotalScore)} pts · ${formatNumber(result.oppHp)} HP`),
      statRow('Motivo', result.reason === 'hp' ? 'KO (vida a 0)' : 'Fin de rondas'),
    ].join('');
  }

  $('#gameOverPanel').classList.remove('hidden');
}

function resetGuessUI() {
  $('#waitingBanner').classList.add('hidden');
  $('#countdownBanner').classList.add('hidden');
  $('#prepareBanner').classList.add('hidden');
  $('#hudTimer').classList.remove('prepare');
  $('#confirmBtn').disabled = true;
}

function resetGameUI() {
  resetGuessUI();
  $('#resultPanel').classList.add('hidden');
  $('#resultPanel').classList.remove('result-overlay');
  $('#gameOverPanel').classList.add('hidden');
  minimap.setFullscreen(false);
  collapseMinimap();
}

/* --------------------------- Render: lobby ----------------------------- */
function renderLobby() {
  const isHost = net.role === 'host';
  const isPublic = !!net.isPublic;

  $('#roomCodeValue').textContent = net.roomCode || '----';
  $('#roomCodeSection').classList.toggle('hidden', isPublic);
  $('#copyCodeBtn').classList.toggle('hidden', !(isHost && !isPublic));
  $('#lobbyTitle').textContent = isPublic
    ? 'Sala pública'
    : isHost
      ? 'Sala privada'
      : 'Sala';

  const list = $('#playersList');
  list.innerHTML = '';

  if (!players.length) {
    list.innerHTML = '<li class="player-item muted">Conectando…</li>';
  } else {
    players.forEach((p) => {
      const li = document.createElement('li');
      li.className = 'player-item';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;

      const badges = document.createElement('span');
      badges.className = 'badges';
      if (p.isHost) badges.innerHTML += '<span class="host-badge">anfitrión</span>';
      if (p.id === net.myId) badges.innerHTML += '<span class="you-badge">tú</span>';

      li.appendChild(name);
      li.appendChild(badges);
      list.appendChild(li);
    });
  }

  $('#playersCount').textContent = `${players.length} / 2`;

  const startBtn = $('#startBtn');
  startBtn.classList.toggle('hidden', !isHost);
  startBtn.disabled = !(isHost && players.length >= 2);

  const note = $('#lobbyNote');
  if (isHost) {
    note.textContent = players.length >= 2
      ? 'Todo listo. ¡Inicia la partida!'
      : (isPublic ? 'Sala pública. Espera a que alguien se una…' : 'Comparte el código y espera a tu rival…');
  } else {
    note.textContent = 'Esperando a que el anfitrión inicie la partida…';
  }
}

/* --------------------------- Salas públicas ---------------------------- */
async function fetchPublicRooms() {
  const rooms = await net.listPublicRooms();
  renderPublicList(rooms);
}

function formatTime(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, '0')}` : `0:${String(r).padStart(2, '0')}`;
}

function renderLeaderboard() {
  const list = $('#leaderboardList');
  const empty = $('#leaderboardEmpty');
  list.innerHTML = '<p class="empty-hint">Cargando…</p>';
  empty.classList.add('hidden');

  fetchLeaderboard(leaderboardRounds).then((entries) => {
    list.innerHTML = '';
    if (!entries || !entries.length) {
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    entries.forEach((entry, i) => {
      const li = document.createElement('div');
      li.className = 'lb-row' + (i === 0 ? ' top1' : i === 1 ? ' top2' : i === 2 ? ' top3' : '');

      const rank = document.createElement('span');
      rank.className = 'lb-rank';
      rank.textContent = String(i + 1);

      const main = document.createElement('div');
      main.className = 'lb-main';

      const name = document.createElement('span');
      name.className = 'lb-name';
      name.textContent = entry.name || 'Anónimo';

      const meta = document.createElement('span');
      meta.className = 'lb-meta';
      meta.textContent = `${formatNumber(entry.points)} pts · ${formatTime(entry.timeMs)}`;

      main.appendChild(name);
      main.appendChild(meta);

      const score = document.createElement('div');
      score.className = 'lb-score';
      const val = document.createElement('span');
      val.className = 'lb-score-value';
      val.textContent = formatNumber(entry.score);
      const label = document.createElement('span');
      label.className = 'lb-score-label';
      label.textContent = 'PTS';
      score.appendChild(val);
      score.appendChild(label);

      li.appendChild(rank);
      li.appendChild(main);
      li.appendChild(score);
      list.appendChild(li);
    });
  });
}

function renderPublicList(rooms) {
  const list = $('#publicList');
  const empty = $('#publicEmpty');
  list.innerHTML = '';

  if (!rooms || !rooms.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  rooms.forEach((room) => {
    const li = document.createElement('li');
    li.className = 'public-room';

    const info = document.createElement('div');
    info.className = 'public-room-info';

    const name = document.createElement('span');
    name.className = 'public-room-name';
    name.textContent = room.name || 'Anónimo';

    const meta = document.createElement('span');
    meta.className = 'public-room-meta';
    const limit = Number(room.limit) || 2;
    const count = Number(room.count) || 0;
    meta.textContent = `${count}/${limit} jugadores`;

    info.appendChild(name);
    info.appendChild(meta);

    const btn = document.createElement('button');
    btn.className = 'join-public-btn';
    const full = limit > 0 && count >= limit;
    btn.disabled = full;
    btn.textContent = full ? 'Llena' : 'Unirse';
    btn.addEventListener('click', () => {
      audio.ensure();
      net.joinPublicRoom(room.id, meName);
    });

    li.appendChild(info);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* --------------------------- Red --------------------------------------- */
function handleNetMessage(data) {
  if (data.type === 'players') {
    players = data.players || [];
    if (data.hostName) net.remoteName = data.hostName;
    renderLobby();
    return;
  }
  if (data.type === 'start') {
    game.guestOnStart(data);
    guestPrepareStart();
    return;
  }
  game.handleNetworkMessage(data);
}

async function guestPrepareStart() {
  try {
    await ensureData();
    showScreen('game');
    resetGameUI();
    await ensureViewers();
    net.send({ type: 'ready' });
  } catch (err) {
    showError('No se pudo preparar la partida: ' + err.message);
  }
}

/* --------------------------- Flujo principal --------------------------- */
let soloRounds = 5;
let leaderboardRounds = 5;

async function startSolo(rounds = soloRounds) {
  soloRounds = rounds;
  audio.ensure();
  try {
    setLoadingText('Cargando ubicaciones…');
    showScreen('loading');
    await ensureData();
    showScreen('game');
    resetGameUI();
    await ensureViewers();
    game.meName = meName;
    game.startSolo(rounds);
  } catch (err) {
    showError('Error al cargar: ' + err.message);
    showScreen('menu');
  }
}

async function hostStartGame() {
  audio.ensure();
  $('#startBtn').disabled = true;
  try {
    setLoadingText('Preparando partida…');
    showScreen('loading');
    await ensureData();
    showScreen('game');
    resetGameUI();
    await ensureViewers();
    game.meName = meName;
    game.hostStart();
  } catch (err) {
    showError('Error al cargar: ' + err.message);
    showScreen('lobby');
    renderLobby();
  }
}

function createRoom(isPublic = false) {
  audio.ensure();
  net.createRoom(meName, isPublic);
}

function joinRoom(code) {
  audio.ensure();
  net.joinRoom(code, meName);
}

function resetToMenu(message) {
  game.abort();
  if (message) showToast(message, 'error');
  resetGameUI();
  showScreen('menu');
  $('#menuPlayerName').textContent = meName;
}

function leaveEverything() {
  net.leave();
}

/* --------------------------- Wiring ------------------------------------ */
function wire() {
  // --- Nombre ---
  const nameInput = $('#playerNameInput');
  const saveName = async () => {
    const name = nameInput.value.trim();
    if (!name) {
      showToast('Escribe un nombre', 'error');
      return;
    }
    $('#saveNameBtn').disabled = true;
    const available = await checkNameAvailable(name);
    if (!available) {
      $('#saveNameBtn').disabled = false;
      showToast('Ese nombre ya existe, elige otro', 'error');
      return;
    }
    const reg = await registerName(name);
    $('#saveNameBtn').disabled = false;
    if (!reg || !reg.ok) {
      showToast(reg && reg.error ? reg.error : 'No se pudo registrar el nombre', 'error');
      return;
    }
    meName = name;
    localStorage.setItem(PLAYER_KEY, name);
    audio.ensure();
    audio.click();
    $('#menuPlayerName').textContent = meName;
    showScreen('menu');
  };
  $('#saveNameBtn').addEventListener('click', saveName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName();
  });

  // --- Menú ---
  $('#soloBtn').addEventListener('click', () => {
    audio.ensure();
    showScreen('solo');
  });
  $('#createBtn').addEventListener('click', () => {
    audio.ensure();
    showScreen('create');
  });
  $('#joinBtn').addEventListener('click', () => {
    $('#joinCodeInput').value = '';
    showScreen('join');
    fetchPublicRooms();
    setTimeout(() => $('#joinCodeInput').focus(), 50);
  });
  $('#leaderboardBtn').addEventListener('click', () => {
    audio.ensure();
    showScreen('leaderboard');
    setLeaderboardTab(5);
  });

  // --- Selección de rondas (solitario) ---
  document.querySelectorAll('.solo-rounds-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      audio.ensure();
      startSolo(Number(btn.dataset.rounds));
    });
  });
  $('#soloBackBtn').addEventListener('click', () => showScreen('menu'));

  // --- Leaderboard ---
  function setLeaderboardTab(rounds) {
    leaderboardRounds = rounds;
    document.querySelectorAll('.lb-tab').forEach((tab) => {
      tab.classList.toggle('active', Number(tab.dataset.rounds) === rounds);
    });
    renderLeaderboard();
  }
  document.querySelectorAll('.lb-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      audio.ensure();
      setLeaderboardTab(Number(tab.dataset.rounds));
    });
  });
  $('#leaderboardBackBtn').addEventListener('click', () => showScreen('menu'));

  // --- Crear sala (pública / privada) ---
  $('#createPublicBtn').addEventListener('click', () => createRoom(true));
  $('#createPrivateBtn').addEventListener('click', () => createRoom(false));
  $('#createBackBtn').addEventListener('click', () => showScreen('menu'));

  // --- Sonido ---
  const soundBtn = $('#soundBtn');
  const updateSoundBtn = () => {
    soundBtn.textContent = audio.enabled ? '🔊' : '🔇';
  };
  soundBtn.addEventListener('click', () => {
    audio.ensure();
    audio.toggle();
    updateSoundBtn();
  });
  updateSoundBtn();

  // --- Unirse ---
  const joinCodeInput = $('#joinCodeInput');
  joinCodeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  const doJoin = () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (code.length !== CONFIG.CODE_LENGTH) {
      showToast('El código debe tener 4 caracteres', 'error');
      return;
    }
    joinRoom(code);
  };
  $('#joinRoomBtn').addEventListener('click', doJoin);
  joinCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  $('#joinBackBtn').addEventListener('click', () => showScreen('menu'));

  // --- Lobby ---
  $('#startBtn').addEventListener('click', hostStartGame);
  $('#leaveLobbyBtn').addEventListener('click', () => {
    leaveEverything();
    resetToMenu();
  });
  $('#copyCodeBtn').addEventListener('click', () => {
    const code = net.roomCode;
    if (!code) return;
    const copy = (text) => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          () => showToast('Código copiado'),
          () => fallbackCopy(text)
        );
      } else {
        fallbackCopy(text);
      }
    };
    const fallbackCopy = (text) => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        showToast('Código copiado');
      } catch (e) {
        showToast('No se pudo copiar', 'error');
      }
      document.body.removeChild(ta);
    };
    copy(code);
  });

  // --- Juego ---
  $('#confirmBtn').addEventListener('click', () => game.confirmGuess());
  $('#recenterBtn').addEventListener('click', () => {
    pano.recenter();
    audio.click();
  });
  $('#leaveGameBtn').addEventListener('click', () => {
    if (game.mode === 'duel') leaveEverything();
    resetToMenu('Partida abandonada');
  });
  $('#resultNextBtn').addEventListener('click', () => {
    $('#resultPanel').classList.add('hidden');
    $('#resultPanel').classList.remove('result-overlay');
    minimap.setFullscreen(false);
    game.nextRound();
  });
  $('#gameOverBtn').addEventListener('click', () => {
    if (game.mode === 'duel') leaveEverything();
    resetToMenu();
  });

  // --- Minimapa (colapsable) ---
  const wrap = $('#minimapWrap');
  wrap.addEventListener('mouseenter', () => {
    wrap.classList.add('expanded');
    minimap.refreshSize();
  });
  wrap.addEventListener('mouseleave', () => {
    if (!minimapPinned) wrap.classList.remove('expanded');
  });
  $('#minimapToggle').addEventListener('click', () => {
    minimapPinned = !minimapPinned;
    wrap.classList.toggle('pinned', minimapPinned);
    wrap.classList.toggle('expanded', minimapPinned);
    minimap.refreshSize();
  });
}

/* --------------------------- Eventos del juego -------------------------- */
function wireGame() {
  game.on('hud', renderHud);
  game.on('timer', renderTimer);
  game.on('confirm', renderConfirm);
  game.on('waiting', renderWaiting);
  game.on('countdown', renderCountdown);
  game.on('prepare', renderPrepare);
  game.on('result', renderResult);
  game.on('gameover', handleGameOver);
  game.on('toast', ({ message, kind }) => showToast(message, kind));
}

function wireNet() {
  net.cb.onStatus = (status) => {
    if (status === 'host') {
      players = [{ id: net.myId, name: meName, isHost: true }];
      showScreen('lobby');
      renderLobby();
      showToast('Sala creada');
    } else if (status === 'guest') {
      players = [];
      showScreen('lobby');
      renderLobby();
      showToast('Conectando…');
    } else if (status === 'connecting') {
      showToast('Conectando…');
    }
  };

  net.cb.onGuestJoin = (peerId, name) => {
    net.remoteName = name;
    players = [
      { id: net.myId, name: meName, isHost: true },
      { id: peerId, name, isHost: false },
    ];
    renderLobby();
    net.send({ type: 'players', players, hostName: meName });
    net.updatePublicCount(players.length);
    audio.join();
    showToast(`${name} se unió a la sala`);
  };

  net.cb.onGuestLeave = (reason) => {
    if (net.role === 'host') {
      if (reason === 'guest-left') {
        players = players.filter((p) => p.isHost);
        net.updatePublicCount(players.length);
        if (gameInProgress()) {
          leaveEverything();
          resetToMenu('El rival abandonó la partida');
          return;
        }
        renderLobby();
        showToast('El rival se fue', 'error');
      }
    } else {
      // Guest perdió al host.
      leaveEverything();
      resetToMenu('El anfitrión se desconectó');
    }
  };

  net.cb.onError = (type) => {
    if (type === 'NO_EXISTE') {
      showToast('No existe esa sala', 'error');
      leaveEverything();
      showScreen('join');
    } else if (type === 'LLENA') {
      showToast('La sala está llena', 'error');
      leaveEverything();
      showScreen('menu');
    } else if (type === 'unavailable-id') {
      showToast('Regenerando código…');
    } else if (type === 'public-register') {
      showToast('No se pudo registrar la sala pública (requiere servidor PHP)', 'error');
    } else {
      showToast('Error de conexión: ' + type, 'error');
    }
  };

  net.cb.onMessage = handleNetMessage;
}

/* --------------------------- Inicio ------------------------------------- */
function boot() {
  wire();
  wireGame();
  wireNet();

  // Compás: actualiza al rotar la cámara.
  pano.callbacks.onPovChange = (heading) => updateCompass(heading);

  // Colocar marcador en el minimapa.
  minimap.callbacks.onPick = (lat, lng) => {
    game.placePick(lat, lng);
    audio.place();
  };

  // Desbloqueo de audio al primer gesto.
  document.addEventListener('pointerdown', () => audio.ensure(), { once: true });

  // Refresca el listado de salas públicas mientras la pantalla de unirse está abierta.
  setInterval(() => {
    const joinEl = document.getElementById('screen-join');
    if (joinEl && !joinEl.classList.contains('hidden')) fetchPublicRooms();
  }, 3000);

  const saved = localStorage.getItem(PLAYER_KEY);
  if (saved) {
    meName = saved;
    $('#menuPlayerName').textContent = saved;
    // Asegura que el nombre siga registrado en el servidor (por si el JSON
    // se reinició o se desplegó desde cero).
    checkNameAvailable(saved).then((available) => {
      if (available) registerName(saved).catch(() => {});
    });
    showScreen('menu');
  } else {
    showScreen('name');
    setTimeout(() => $('#playerNameInput').focus(), 50);
  }
}

boot();
