// ============================================================================
// app.js — Punto de entrada. Coordina UI, red, visor panorámico y juego.
// ============================================================================

import { $, formatKm, formatNumber, clamp } from './utils.js';
import { CONFIG } from './config.js';
import { audio } from './audio.js';
import { PanoramaViewer } from './panorama.js';
import { Minimap } from './minimap.js';
import { Network } from './net.js';
import { Game } from './game.js';
import { AsciiEarthBackground } from './ascii-earth.js';

const PLAYER_KEY = 'ggtlalte:playerName';
const ROOM_KEY = 'ggtlalte:activeRoom';
const API_URL = 'api.php';

// Logs de diagnóstico temporales.
const LOG = (...args) => console.log('[app]', ...args);

/* ----------------------------- Instancias ------------------------------ */
const pano = new PanoramaViewer('pano');
const minimap = new Minimap('minimap');
const net = new Network();
const game = new Game({ pano, map: minimap, net, audio });
const asciiEarth = new AsciiEarthBackground('ascii-earth');

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

  // El fondo orbital solo se anima en el menú principal.
  if (id === 'menu') asciiEarth.start();
  else asciiEarth.stop();
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
async function apiPost(action, body = {}) {
  try {
    const res = await fetch(`${API_URL}?action=${encodeURIComponent(action)}&_t=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return null;
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
    const res = await fetch(`${API_URL}?action=leaderboard&rounds=${rounds}&_t=${Date.now()}`, {
      cache: 'no-store',
    });
    const data = await res.json();
    if (data && data.ok) return data.entries || [];
  } catch (e) {
    console.error('Error cargando leaderboard:', e);
  }
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
  minimap.setInteractive(true);
}

function collapseMinimap() {
  const wrap = $('#minimapWrap');
  minimapPinned = false;
  wrap.classList.remove('pinned', 'expanded');
}

/* --------------------------- Render: HUD ------------------------------- */
function renderHud(hud) {
  const hudTop = $('.hud-top');
  if (hudTop) hudTop.classList.remove('over-map');
  collapseMinimap();
  minimap.setFullscreen(false);
  $('#resultPanel').classList.add('hidden');
  $('#resultPanel').classList.remove('result-overlay');
  $('#gameOverPanel').classList.add('hidden');
  const roundLabel = $('#hudRound');
  if (roundLabel) roundLabel.textContent = `RONDA ${hud.round}/${hud.total}`;

  const isMulti = hud.mode === 'multi';
  $('#hudScore').classList.toggle('hidden', isMulti);
  $('#hudHp').classList.toggle('hidden', !isMulti);

  if (!isMulti) {
    $('#hudScoreValue').textContent = formatNumber(hud.me.score);
  } else {
    renderMultiHp(hud.players);
  }

  if (hud.mode === 'multi') {
    const mult = hud.multiplier ? hud.multiplier.toFixed(1) : '1.0';
    $('#hudTimer').dataset.mult = `x${mult}`;
  } else {
    delete $('#hudTimer').dataset.mult;
  }
}

function hpColorClass(pct) {
  if (pct <= 25) return 'hp-low';
  if (pct <= 50) return 'hp-mid';
  return 'hp-high';
}

function renderMultiHp(players) {
  const box = $('#hudHp');
  if (!box) return;
  box.innerHTML = '';
  const colors = CONFIG.PLAYER_COLORS || [
    '#38bdf8', '#f87171', '#34d399', '#fbbf24',
    '#a78bfa', '#f472b6', '#2dd4bf', '#fb923c',
    '#a3e635', '#818cf8', '#e879f9', '#facc15'
  ];

  (players || []).forEach((p, i) => {
    const color = colors[i % colors.length];
    const row = document.createElement('div');
    row.className = 'hp-row';
    row.dataset.id = p.id;

    const name = document.createElement('span');
    name.className = 'hp-name';
    name.textContent = p.name;
    name.style.color = color;
    name.style.textShadow = `0 0 8px ${color}55, 0 1px 3px rgba(0,0,0,0.9)`;

    const bar = document.createElement('div');
    bar.className = 'hp-bar';
    bar.style.borderColor = `${color}45`;
    const fill = document.createElement('div');
    const hp = (typeof p.hp === 'number' && !isNaN(p.hp)) ? p.hp : CONFIG.MAX_HP;
    const pct = clamp((hp / CONFIG.MAX_HP) * 100, 0, 100);
    fill.className = 'hp-fill ' + hpColorClass(pct);
    fill.style.width = pct + '%';
    bar.appendChild(fill);

    const val = document.createElement('span');
    val.className = 'hp-val';
    val.textContent = Math.round(hp);

    const diff = document.createElement('span');
    diff.className = 'hp-diff';

    row.appendChild(name);
    row.appendChild(bar);
    row.appendChild(val);
    row.appendChild(diff);
    box.appendChild(row);
  });
}

/** Anima el descuento de vida al resolverse la ronda multijugador. */
function animateMultiHp(result) {
  const box = $('#hudHp');
  if (!box) return;

  (result.players || []).forEach((p) => {
    let row = box.querySelector(`.hp-row[data-id="${p.id}"]`);
    if (!row) {
      const rows = box.querySelectorAll('.hp-row');
      for (const r of rows) {
        const nameEl = r.querySelector('.hp-name');
        if (nameEl && nameEl.textContent === p.name) {
          row = r;
          break;
        }
      }
    }
    if (!row) return;

    const bar = row.querySelector('.hp-bar');
    const fill = row.querySelector('.hp-fill');
    const val = row.querySelector('.hp-val');
    let diff = row.querySelector('.hp-diff');
    if (!diff) {
      diff = document.createElement('span');
      diff.className = 'hp-diff';
      row.appendChild(diff);
    }
    if (!bar || !fill || !val) return;

    const damage = p.damage || 0;
    const afterPct = (p.hp / CONFIG.MAX_HP) * 100;

    if (damage <= 0) {
      diff.className = 'hp-diff safe';
      diff.textContent = '0 HP';
      fill.style.width = afterPct + '%';
      fill.className = 'hp-fill ' + hpColorClass(afterPct);
      val.textContent = Math.round(p.hp);
      return;
    }

    // Mostrar badge rojo con la cantidad de vida que pierde
    diff.className = 'hp-diff damage';
    diff.textContent = `-${formatNumber(damage)}`;

    const beforeHp = clamp(p.hp + damage, 0, CONFIG.MAX_HP);
    const beforePct = (beforeHp / CONFIG.MAX_HP) * 100;
    const damagePct = (damage / CONFIG.MAX_HP) * 100;

    // Estado previo + tramo rojo parpadeante
    fill.style.width = beforePct + '%';
    val.textContent = Math.round(beforeHp);

    const layer = document.createElement('div');
    layer.className = 'hp-damage';
    layer.style.left = afterPct + '%';
    layer.style.width = damagePct + '%';
    bar.appendChild(layer);

    setTimeout(() => {
      // Se aplica el daño real: desaparece la capa y la barra se contrae
      layer.remove();
      fill.style.width = afterPct + '%';
      fill.className = 'hp-fill ' + hpColorClass(afterPct);
      val.textContent = Math.round(p.hp);
    }, 1100);
  });
}

function renderTimer({ seconds, danger }) {
  const el = $('#hudTimer');
  if (seconds == null) {
    el.textContent = '';
  } else {
    el.textContent = String(Math.max(0, seconds));
  }
  el.classList.toggle('danger', !!danger);
}

function renderConfirm({ enabled }) {
  $('#confirmBtn').disabled = !enabled;
}

function renderWaiting({ waiting }) {
  $('#waitingBanner').classList.toggle('hidden', !waiting);
  if (waiting) collapseMinimap();
}

function renderCountdown({ seconds, guesserName }) {
  const banner = $('#countdownBanner');
  const num = $('#countdownNumber');
  const label = banner ? banner.querySelector('.countdown-label') : null;
  if (seconds == null || seconds <= 0) {
    banner.classList.add('hidden');
  } else {
    banner.classList.remove('hidden');
    num.textContent = `${seconds}s`;
    banner.classList.toggle('urgent', seconds <= 5);
    if (label) {
      if (game.myGuess) {
        label.textContent = 'Tiempo para tus rivales:';
      } else if (guesserName) {
        label.textContent = `¡${guesserName} ya adivinó!`;
      } else {
        label.textContent = '¡Ya adivinaron!';
      }
    }
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
  // Multijugador: mapa a pantalla completa + tarjeta flotante inferior con puntuación y daño.
  if (result.mode === 'solo') {
    minimap.setFullscreen(true);
    $('#resultPanel').classList.add('result-overlay');
    $('#resultPanel').classList.remove('result-multi', 'hidden');
  } else {
    minimap.setFullscreen(true);
    $('#resultPanel').classList.remove('result-overlay', 'hidden');
    $('#resultPanel').classList.add('result-multi');
    const hudTop = $('.hud-top');
    if (hudTop) hudTop.classList.add('over-map');
  }

  // Revela la respuesta en el mapa (fitBounds con el tamaño ya correcto).
  minimap.setInteractive(false);
  if (result.mode === 'multi') {
    minimap.revealMulti(result.players, result.real);
    animateMultiHp(result);
  } else {
    minimap.reveal({
      real: result.real,
      mine: result.mine,
      opp: result.opp,
    });
  }

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
    // Multijugador: tarjeta de resultados por ronda con daño exacto
    title.textContent = `Ronda ${result.round}/${result.total} · Multiplicador x${result.multiplier || 1}`;
    title.className = 'panel-title panel-title-neutral';

    const colors = CONFIG.PLAYER_COLORS || [
      '#38bdf8', '#f87171', '#34d399', '#fbbf24',
      '#a78bfa', '#f472b6', '#2dd4bf', '#fb923c',
      '#a3e635', '#818cf8', '#e879f9', '#facc15'
    ];

    stats.innerHTML = result.players.map((p, i) => {
      const color = colors[i % colors.length];
      const isPerfect = p.damage <= 0;
      const damageBadge = p.damage > 0
        ? `<span class="res-damage-badge hit">-${formatNumber(p.damage)} HP</span>`
        : `<span class="res-damage-badge safe">⭐ ¡PERFECTO! 0 HP</span>`;
      return `
        <div class="res-multi-row">
          <div class="res-multi-info">
            <div class="res-multi-name" style="color:${color};">
              <span class="res-color-dot" style="background:${color};"></span>
              ${escapeHtml(p.name)} ${isPerfect ? '⭐' : ''}
            </div>
            <div class="res-multi-meta">
              +${formatNumber(p.score)} pts · ${p.distance != null ? formatKm(p.distance) : 'sin guess'}
            </div>
          </div>
          ${damageBadge}
          <div class="res-hp-left">${formatNumber(p.hp)} HP</div>
        </div>
      `;
    }).join('');

    nextBtn.classList.add('hidden');
    note.classList.remove('hidden');
    note.textContent = 'Siguiente ronda en unos segundos…';
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
  const hudTop = $('.hud-top');
  if (hudTop) hudTop.classList.remove('over-map');
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
    // Multijugador: ranking final.
    if (result.won) {
      title.textContent = '¡VICTORIA!';
      title.className = 'panel-title panel-title-win';
    } else {
      title.textContent = 'Fin de partida';
      title.className = 'panel-title panel-title-neutral';
    }
    stats.innerHTML = result.players.map((p) =>
      statRow(
        `#${p.rank} ${p.name}`,
        `${formatNumber(p.score)} pts · ${formatNumber(p.hp)} HP`
      )
    ).join('');
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
  const hudTop = $('.hud-top');
  if (hudTop) hudTop.classList.remove('over-map');
  $('#resultPanel').classList.add('hidden');
  $('#resultPanel').classList.remove('result-overlay', 'result-multi');
  $('#gameOverPanel').classList.add('hidden');
  document.querySelectorAll('.hp-diff').forEach((el) => {
    el.className = 'hp-diff';
    el.textContent = '';
  });
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

  // Deduplicación estricta en el cliente para garantizar nombres únicos en el lobby
  const seenLobby = new Set();
  const cleanPlayers = [];
  for (const p of players) {
    const key = (p.name || '').trim().toLowerCase();
    if (key && !seenLobby.has(key)) {
      seenLobby.add(key);
      cleanPlayers.push(p);
    }
  }
  players = cleanPlayers;

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

      const actions = document.createElement('div');
      actions.className = 'player-item-actions';

      const badges = document.createElement('span');
      badges.className = 'badges';
      if (p.isHost) badges.innerHTML += '<span class="host-badge">anfitrión</span>';
      if (p.id === net.myId) badges.innerHTML += '<span class="you-badge">tú</span>';
      actions.appendChild(badges);

      // Botón de expulsar: visible solo para el host en jugadores que no son él mismo
      if (isHost && !p.isHost && p.id !== net.myId) {
        const kickBtn = document.createElement('button');
        kickBtn.className = 'btn-kick';
        kickBtn.title = `Expulsar a ${p.name}`;
        kickBtn.setAttribute('aria-label', `Expulsar a ${p.name}`);
        kickBtn.innerHTML = '✕';
        kickBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          audio.ensure();
          if (confirm(`¿Expulsar a ${p.name} de la sala?`)) {
            net.kickPlayer(p.id, p.name);
          }
        });
        actions.appendChild(kickBtn);
      }

      li.appendChild(name);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  const limit = net.limit || CONFIG.ROOM_MAX_PLAYERS;
  $('#playersCount').textContent = `${players.length} / ${limit}`;

  const roundsInfo = $('#roomRoundsInfo');
  if (roundsInfo) roundsInfo.textContent = `${net.rounds || CONFIG.DUEL_ROUNDS} rondas`;

  const startBtn = $('#startBtn');
  startBtn.classList.toggle('hidden', !isHost);
  const canStart = isHost && players.length >= 2;
  startBtn.disabled = !canStart;
  if (players.length < 2) {
    startBtn.textContent = isHost ? `Esperando rivales… (1/${limit})` : 'Esperando al anfitrión…';
  } else {
    startBtn.textContent = `Iniciar partida (${players.length}/${limit})`;
  }

  const deleteBtn = $('#deleteRoomBtn');
  if (deleteBtn) deleteBtn.classList.toggle('hidden', !isHost);

  const note = $('#lobbyNote');
  if (isHost) {
    if (players.length < 2) {
      note.textContent = 'Se necesitan al menos 2 jugadores para iniciar la partida.';
    } else if (players.length < limit) {
      note.textContent = `¡Listo para iniciar con ${players.length} jugadores! (O espera a que se unan más).`;
    } else {
      note.textContent = '¡Sala llena! Inicia la partida cuando quieras.';
    }
  } else {
    note.textContent = 'Esperando a que el anfitrión inicie la partida…';
  }
}

/* --------------------------- Salas públicas ---------------------------- */
async function fetchPublicRooms() {
  LOG('fetchPublicRooms');
  const rooms = await net.listPublicRooms();
  LOG('fetchPublicRooms → salas', rooms);
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
    const savedRoomStr = localStorage.getItem(ROOM_KEY);
    let isMyOldRoom = false;
    if (savedRoomStr) {
      try {
        const saved = JSON.parse(savedRoomStr);
        if (saved && saved.roomId === room.id) isMyOldRoom = true;
      } catch (e) {}
    }
    const full = limit > 0 && count >= limit && !isMyOldRoom;
    btn.disabled = full;
    btn.textContent = isMyOldRoom ? 'Reconectarse' : (full ? 'Llena' : 'Unirse');
    if (isMyOldRoom) {
      btn.classList.add('btn-reconnect');
    }
    LOG('renderPublicList sala', { id: room.id, name: room.name, limit, count, full, isMyOldRoom });
    btn.addEventListener('click', () => {
      LOG('click Unirse sala pública', { id: room.id, meName });
      audio.ensure();
      net.joinPublicRoom(room.id, meName);
    });

    li.appendChild(info);
    li.appendChild(btn);
    list.appendChild(li);
  });
}

/* --------------------------- Red --------------------------------------- */
function handleNetMessage(data, fromPeerId) {
  LOG('handleNetMessage', { data, fromPeerId });
  if (data.type === 'players') {
    players = data.players || [];
    if (data.config) {
      net.rounds = data.config.rounds;
      net.limit = data.config.limit;
    }
    net.setGuestPlayers(players, data.config);
    // Asegura que el invitado entre al lobby en cuanto recibe la lista,
    // independientemente del orden en que llegue el estado 'guest'.
    if (net.role === 'guest') showScreen('lobby');
    renderLobby();
    return;
  }
  if (data.type === 'start') {
    game.guestOnStart(data);
    guestPrepareStart();
    return;
  }
  if (data.type === 'kicked') {
    localStorage.removeItem(ROOM_KEY);
    net.leave();
    resetToMenu(data.reason || 'El anfitrión te expulsó de la sala');
    return;
  }
  game.handleNetworkMessage(data, fromPeerId);
}

async function guestPrepareStart() {
  try {
    await ensureData();
    showScreen('game');
    resetGameUI();
    await ensureViewers();
    setTimeout(() => {
      pano.refresh();
      if (game.currentCoord) {
        pano.setPano(game.currentCoord.pano_id, game.roundHeading || 0, 0);
      }
    }, 60);
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
    setTimeout(() => pano.refresh(), 60);
    game.meName = meName;
    game.startSolo(rounds);
  } catch (err) {
    showError('Error al cargar: ' + err.message);
    showScreen('menu');
  }
}

async function hostStartGame() {
  audio.ensure();
  if (players.length < 2) {
    showToast('Se necesitan al menos 2 jugadores para iniciar.', 'error');
    return;
  }
  $('#startBtn').disabled = true;
  try {
    setLoadingText('Preparando partida…');
    showScreen('loading');
    await ensureData();
    showScreen('game');
    resetGameUI();
    await ensureViewers();
    setTimeout(() => pano.refresh(), 60);
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
  const rounds = Number($('#roomRounds').value) || CONFIG.DUEL_ROUNDS;
  const limit = Number($('#roomLimit').value) || CONFIG.ROOM_MAX_PLAYERS;
  LOG('createRoom', { isPublic, meName, rounds, limit });
  net.createRoom(meName, isPublic, { rounds, limit });
}

function persistActiveRoom() {
  if (!net.role || (!net.roomId && !net.roomCode)) {
    localStorage.removeItem(ROOM_KEY);
    return;
  }
  localStorage.setItem(ROOM_KEY, JSON.stringify({
    name: meName,
    role: net.role,
    roomId: net.roomId,
    roomCode: net.roomCode,
    isPublic: net.isPublic,
    rounds: net.rounds,
    limit: net.limit,
  }));
}

function leaveRoom() {
  // Sale de la sala sin eliminarla: la sala anfitriona se conserva para que
  // al recargar la página puedas reincorporarte a ella.
  leaveEverything();
  resetToMenu();
}

function deleteRoom() {
  // Elimina la sala del servidor y la persistencia local.
  if (net.role === 'host' && net.isPublic && net.roomId) {
    apiPost('delete', { id: net.roomId }).catch(() => {});
  }
  net.leave();
  localStorage.removeItem(ROOM_KEY);
  resetToMenu('Sala eliminada');
}

function joinRoom(code) {
  LOG('joinRoom (app)', { code, meName });
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
  localStorage.removeItem(ROOM_KEY);
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
    LOG('doJoin', { code });
    if (code.length !== CONFIG.CODE_LENGTH) {
      showToast('El código debe tener 4 caracteres', 'error');
      return;
    }
    players = [];
    showScreen('lobby');
    renderLobby();
    joinRoom(code);
  };
  $('#joinRoomBtn').addEventListener('click', doJoin);
  joinCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doJoin();
  });
  $('#joinBackBtn').addEventListener('click', () => showScreen('menu'));

  // --- Lobby ---
  $('#startBtn').addEventListener('click', hostStartGame);
  $('#leaveLobbyBtn').addEventListener('click', leaveRoom);
  $('#deleteRoomBtn').addEventListener('click', deleteRoom);
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
  $('#confirmBtn').addEventListener('click', () => {
    collapseMinimap();
    game.confirmGuess();
  });
  $('#leaveGameBtn').addEventListener('click', () => {
    if (game.mode === 'multi') leaveEverything();
    resetToMenu('Partida abandonada');
  });
  $('#resultNextBtn').addEventListener('click', () => {
    $('#resultPanel').classList.add('hidden');
    $('#resultPanel').classList.remove('result-overlay');
    minimap.setFullscreen(false);
    game.nextRound();
  });
  $('#gameOverBtn').addEventListener('click', () => {
    if (game.mode === 'multi') leaveEverything();
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
  wrap.addEventListener('click', () => {
    if (!wrap.classList.contains('expanded')) {
      expandMinimap(true);
    }
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
    LOG('onStatus', status, { role: net.role, myId: net.myId, isPublic: net.isPublic });
    if (status === 'host') {
      players = [{ id: net.myId, name: meName, isHost: true }];
      persistActiveRoom();
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
    LOG('onGuestJoin', { peerId, name });
    players = net.players;
    renderLobby();
    audio.join();
    showToast(`${name} se unió a la sala`);
  };

  net.cb.onPlayers = (list, config) => {
    LOG('onPlayers', { list, config });
    players = list;
    persistActiveRoom();
    renderLobby();
  };

  net.cb.onGuestLeave = (peerId) => {
    LOG('onGuestLeave', { peerId, role: net.role });
    if (net.role === 'host') {
      players = net.players;
      renderLobby();
      if (gameInProgress()) {
        game.removePlayer(peerId);
        if (players.length < CONFIG.ROOM_MIN_PLAYERS) {
          leaveEverything();
          resetToMenu('No quedan suficientes jugadores');
          return;
        }
      }
      showToast('Un jugador abandonó la sala', 'error');
    } else {
      // Guest perdió al host.
      leaveEverything();
      resetToMenu('El anfitrión se desconectó');
    }
  };

  net.cb.onKicked = (reason) => {
    localStorage.removeItem(ROOM_KEY);
    leaveEverything();
    resetToMenu(reason || 'El anfitrión te expulsó de la sala');
  };

  net.cb.onError = (type) => {
    LOG('onError', type);
    leaveEverything();
    if (type === 'NO_EXISTE') {
      resetToMenu('La sala ya no existe o finalizó');
    } else if (type === 'LLENA') {
      resetToMenu('La sala está llena');
    } else if (type === 'unavailable-id') {
      showToast('Regenerando código…');
    } else if (type === 'public-register') {
      showToast('No se pudo registrar la sala pública', 'error');
    } else if (type === 'peer-unavailable') {
      resetToMenu('La sala no respondió o ya no está disponible');
    } else {
      resetToMenu('Error de conexión: ' + type);
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

  // Captura errores globales y promesas rechazadas para que nada quede silencioso.
  window.addEventListener('error', (e) => {
    LOG('window error', e.message, e.filename, e.lineno, e.colno, e.error);
  });
  window.addEventListener('unhandledrejection', (e) => {
    LOG('unhandledrejection', e.reason);
  });

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

    // Si había una sala anfitriona o invitada activa, reincorpórate a ella tras recargar.
    const savedRoom = localStorage.getItem(ROOM_KEY);
    if (savedRoom) {
      try {
        const room = JSON.parse(savedRoom);
        if (room && room.role === 'host' && room.roomId) {
          net.rejoinHostRoom(room);
          return;
        } else if (room && room.role === 'guest') {
          setLoadingText('Reconectando a la sala…');
          showScreen('loading');

          // Timeout de seguridad: si la sala ya no existe o no responde en 4 segundos, volver al menú
          let reconTimeout = setTimeout(() => {
            leaveEverything();
            resetToMenu('La sala anterior ya no existe');
          }, 4000);

          const origOnPlayers = net.cb.onPlayers;
          net.cb.onPlayers = (list, config) => {
            clearTimeout(reconTimeout);
            if (origOnPlayers) origOnPlayers(list, config);
          };

          if (room.isPublic && room.roomId) {
            net.joinPublicRoom(room.roomId, meName);
          } else if (room.roomCode) {
            net.joinRoom(room.roomCode, meName);
          }
          return;
        }
      } catch (e) {
        localStorage.removeItem(ROOM_KEY);
      }
    }
    showScreen('menu');
  } else {
    showScreen('name');
    setTimeout(() => $('#playerNameInput').focus(), 50);
  }
}

boot();
