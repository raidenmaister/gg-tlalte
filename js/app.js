// ============================================================================
// app.js — Punto de entrada. Coordina UI, red, visor panorámico y juego.
// ============================================================================

import { $, formatKm, formatNumber, clamp, escapeHtml } from './utils.js';
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

  // El fondo orbital y de estrellas persiste entre todos los menús (Req 3)
  const isMenu = ['name', 'menu', 'solo', 'create', 'join', 'leaderboard', 'lobby'].includes(id);
  if (isMenu) {
    asciiEarth.start();
  } else {
    asciiEarth.stop();
  }

  // El badge BETA v1.0.0 solo se muestra en los menús (Req 4)
  const badge = document.getElementById('versionBadge');
  if (badge) {
    badge.classList.toggle('hidden', !isMenu);
  }
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

async function fetchLeaderboard(rounds, mode = leaderboardMode || 'normal') {
  try {
    const res = await fetch(`${API_URL}?action=leaderboard&rounds=${rounds}&mode=${mode}&_t=${Date.now()}`, {
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
    dataPromise = game.loadData().catch((err) => {
      dataPromise = null;
      throw err;
    });
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

  const roundEl = $('#hudRound');
  if (isMulti && hud.penalty) {
    roundEl.textContent = `RONDA ${hud.round}/${hud.total} · SIN GUESS: -${hud.penalty} PTS`;
  } else {
    roundEl.textContent = `RONDA ${hud.round}/${hud.total}`;
  }

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
  if (players && players.length > 10) {
    box.classList.add('many-players');
  } else {
    box.classList.remove('many-players');
  }
  const colors = CONFIG.PLAYER_COLORS;

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
        if (nameEl && nameEl.textContent.trim() === (p.name || '').trim()) {
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
      diff.textContent = '0 pts';
      fill.style.width = afterPct + '%';
      fill.className = 'hp-fill ' + hpColorClass(afterPct);
      val.textContent = Math.round(p.hp);
      return;
    }

    // Mostrar badge con la cantidad de puntos que pierde
    diff.className = 'hp-diff damage';
    diff.textContent = `-${formatNumber(damage)} pts`;

    // Número flotante de combate que sube y se desvanece
    const floatEl = document.createElement('div');
    floatEl.className = 'hp-floating-damage';
    floatEl.textContent = `-${formatNumber(damage)} pts`;
    row.appendChild(floatEl);
    setTimeout(() => floatEl.remove(), 2500);

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

function renderCountdown({ seconds, guesserName, penalty }) {
  const banner = $('#countdownBanner');
  const num = $('#countdownNumber');
  const label = banner ? banner.querySelector('.countdown-label') : null;
  const sub = banner ? banner.querySelector('.countdown-sub') : null;
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
    if (sub) {
      if (!game.myGuess && penalty) {
        sub.innerHTML = `¡Adivina ahora o perderás <strong>${penalty} puntos</strong>!`;
        sub.classList.remove('hidden');
      } else {
        sub.classList.add('hidden');
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
    const penaltyText = result.penalty ? ` · Penalización base: -${result.penalty} pts` : '';
    title.textContent = `Ronda ${result.round}/${result.total}${penaltyText}`;
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
        ? `<span class="res-damage-badge hit">Pierde: -${formatNumber(p.damage)} pts</span>`
        : `<span class="res-damage-badge safe">⭐ ¡A salvo! 0 pts</span>`;
      return `
        <div class="res-multi-row">
          <div class="res-multi-info">
            <div class="res-multi-name" style="color:${color};">
              <span class="res-color-dot" style="background:${color};"></span>
              ${escapeHtml(p.name)} ${isPerfect ? '⭐' : ''}
            </div>
            <div class="res-multi-meta">
              ${p.guess ? `+${formatNumber(p.score)} pts · ${p.distance != null ? formatKm(p.distance) : ''}` : '<span class="res-no-guess">⚠️ No adivinó a tiempo</span>'}
            </div>
          </div>
          ${damageBadge}
          <div class="res-hp-left">${formatNumber(p.hp)} pts</div>
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
      gameMode: result.gameMode || 'normal',
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
      title.textContent = result.reason === 'forfeit' ? '¡VICTORIA POR ABANDONO!' : '¡VICTORIA!';
      title.className = 'panel-title panel-title-win';
    } else {
      title.textContent = result.reason === 'forfeit' ? 'Rival desconectado' : 'Fin de partida';
      title.className = 'panel-title panel-title-neutral';
    }
    stats.innerHTML = result.players.map((p) =>
      statRow(
        `#${p.rank} ${p.name}`,
        `${formatNumber(p.score)} pts · ${formatNumber(p.hp)} pts de vida`
      )
    ).join('');
  }

  $('#gameOverPanel').classList.remove('hidden');
}

function resetGuessUI() {
  $('#waitingBanner').classList.add('hidden');
  $('#countdownBanner').classList.add('hidden');
  $('#prepareBanner').classList.add('hidden');
  const tempBanner = $('#temporalBanner');
  if (tempBanner) tempBanner.classList.add('hidden');
  $('#hudTimer').classList.remove('prepare');
  $('#confirmBtn').disabled = true;
  if (pano) {
    pano.setBlind(false);
    pano.setStatic(false);
  }
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

  // Deduplicación estricta para la vista del lobby
  const seenLobby = new Set();
  const displayPlayers = [];
  for (const p of players) {
    const key = (p.name || '').trim().toLowerCase();
    if (key && !seenLobby.has(key)) {
      seenLobby.add(key);
      displayPlayers.push(p);
    }
  }

  const list = $('#playersList');
  list.innerHTML = '';

  if (!displayPlayers.length) {
    list.innerHTML = '<li class="player-item muted">Conectando…</li>';
  } else {
    displayPlayers.forEach((p, i) => {
      const li = document.createElement('li');
      li.className = 'player-item';

      const playerColor = (CONFIG.PLAYER_COLORS && CONFIG.PLAYER_COLORS[i % CONFIG.PLAYER_COLORS.length]) || '#38bdf8';

      const main = document.createElement('div');
      main.className = 'player-main';

      const pin = document.createElement('span');
      pin.className = 'player-pin-badge';
      pin.style.color = playerColor;
      pin.title = `Color de partida: ${playerColor}`;
      pin.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z"/>
      </svg>`;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name;

      main.appendChild(pin);
      main.appendChild(name);

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

      li.appendChild(main);
      li.appendChild(actions);
      list.appendChild(li);
    });
  }

  const limit = net.limit || CONFIG.ROOM_MAX_PLAYERS;
  $('#playersCount').textContent = `${displayPlayers.length} / ${limit}`;

  const roundsInfo = $('#roomRoundsInfo');
  if (roundsInfo) roundsInfo.textContent = `${net.rounds || CONFIG.DUEL_ROUNDS} rondas`;

  const startBtn = $('#startBtn');
  startBtn.classList.toggle('hidden', !isHost);
  const canStart = isHost && displayPlayers.length >= 2;
  startBtn.disabled = !canStart;
  if (displayPlayers.length < 2) {
    startBtn.textContent = isHost ? `Esperando rivales… (${displayPlayers.length}/${limit})` : 'Esperando al anfitrión…';
  } else {
    startBtn.textContent = `Iniciar partida (${displayPlayers.length}/${limit})`;
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

  fetchLeaderboard(leaderboardRounds, leaderboardMode).then((entries) => {
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
      game.meName = meName;
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
    game.meName = meName;
    game.guestOnStart(data);
    guestPrepareStart();
    return;
  }
  if (data.type === 'hostLeft') {
    leaveEverything();
    resetToMenu(data.reason || 'El anfitrión abandonó la partida. La sala fue cerrada.');
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
    game.meName = meName;
    await ensureData();
    showScreen('game');
    resetGameUI();
    await ensureViewers();
    // Refrescar tamaño y visibilidad del StreetView
    pano.refresh();
    // Marcar al guest como listo de inmediato para procesar roundStart sin retrasos
    game.guestSetReady();
    net.send({ type: 'ready' });
  } catch (err) {
    showError('No se pudo preparar la partida: ' + err.message);
  }
}

/* --------------------------- Flujo principal --------------------------- */
let soloRounds = 5;
let leaderboardRounds = 5;
let leaderboardMode = 'normal';
let currentSoloMode = 'normal';
let currentSoloTemporalSecs = CONFIG.DEFAULT_TEMPORAL_SECONDS || 3;
let currentMultiMode = 'normal';
let currentMultiTemporalSecs = CONFIG.DEFAULT_TEMPORAL_SECONDS || 3;

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
    game.startSolo(rounds, currentSoloMode, currentSoloTemporalSecs);
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
    game.hostStart(currentMultiMode, currentMultiTemporalSecs);
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
  LOG('createRoom', { isPublic, meName, rounds, limit, currentMultiMode, currentMultiTemporalSecs });
  net.createRoom(meName, isPublic, {
    rounds,
    limit,
    gameMode: currentMultiMode,
    temporalSeconds: currentMultiTemporalSecs,
  });
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
  if (net.role === 'host') {
    try { net.broadcast({ type: 'hostLeft', reason: 'El anfitrión cerró la sala.' }); } catch (e) {}
    if (net.roomId) apiPost('delete', { id: net.roomId }).catch(() => {});
  }
  leaveEverything();
  resetToMenu('Saliste de la sala');
}

function deleteRoom() {
  if (net.role === 'host') {
    try { net.broadcast({ type: 'hostLeft', reason: 'El anfitrión eliminó la sala.' }); } catch (e) {}
    if (net.roomId) apiPost('delete', { id: net.roomId }).catch(() => {});
  }
  leaveEverything();
  resetToMenu('Sala eliminada');
}

function joinRoom(code) {
  LOG('joinRoom (app)', { code, meName });
  game.meName = meName;
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
    game.meName = name;
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
    if (typeof setLeaderboardMode === 'function') setLeaderboardMode('normal');
    setLeaderboardTab(5);
  });

  // --- Modos de juego (solitario) ---
  document.querySelectorAll('#soloModeSelector .mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloModeSelector .mode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSoloMode = btn.dataset.mode || 'normal';
      const desc = CONFIG.GAME_MODES[currentSoloMode]?.desc || '';
      const descEl = $('#soloModeDesc');
      if (descEl) descEl.textContent = desc;
      const tempConf = $('#soloTemporalConfig');
      if (tempConf) tempConf.classList.toggle('hidden', currentSoloMode !== 'temporal');
    });
  });
  document.querySelectorAll('#soloTempPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloTempPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSoloTemporalSecs = Number(btn.dataset.sec) || 3;
    });
  });

  // --- Selección de rondas (solitario) ---
  let selectedSoloRounds = 5;
  document.querySelectorAll('#soloRoundsSelector .round-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloRoundsSelector .round-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSoloRounds = Number(btn.dataset.rounds) || 5;
    });
  });
  $('#soloStartBtn').addEventListener('click', () => {
    audio.ensure();
    startSolo(selectedSoloRounds);
  });
  $('#soloBackBtn').addEventListener('click', () => showScreen('menu'));

  // --- Leaderboard ---
  function setLeaderboardMode(mode) {
    leaderboardMode = mode;
    document.querySelectorAll('.lb-mode-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    });
    renderLeaderboard();
  }
  document.querySelectorAll('.lb-mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      audio.ensure();
      setLeaderboardMode(tab.dataset.mode);
    });
  });

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

  // --- Modos de juego (multijugador / crear sala) ---
  document.querySelectorAll('#multiModeSelector .mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiModeSelector .mode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMultiMode = btn.dataset.mode || 'normal';
      const desc = CONFIG.GAME_MODES[currentMultiMode]?.desc || '';
      const descEl = $('#multiModeDesc');
      if (descEl) descEl.textContent = desc;
      const tempConf = $('#multiTemporalConfig');
      if (tempConf) tempConf.classList.toggle('hidden', currentMultiMode !== 'temporal');
    });
  });
  document.querySelectorAll('#multiTempPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiTempPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMultiTemporalSecs = Number(btn.dataset.sec) || 3;
    });
  });

  // --- Visibilidad de sala (pública / privada) ---
  let isRoomPublic = true;
  document.querySelectorAll('#createVisibilitySelector .vis-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#createVisibilitySelector .vis-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      isRoomPublic = btn.dataset.public === 'true';
      const descEl = $('#createVisibilityDesc');
      if (descEl) {
        descEl.textContent = isRoomPublic
          ? 'Cualquiera puede unirse desde la lista de salas públicas.'
          : 'Solo personas con el código de acceso pueden unirse.';
      }
    });
  });

  // --- Rondas para crear sala ---
  document.querySelectorAll('#createRoundsSelector .round-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#createRoundsSelector .round-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const val = Number(btn.dataset.rounds) || 5;
      const inp = $('#roomRounds');
      if (inp) inp.value = val;
    });
  });

  // --- Tamaño máximo de sala (stepper y presets) ---
  let currentRoomLimit = 8;
  const updateRoomLimitDisplay = (val) => {
    currentRoomLimit = Math.max(2, Math.min(CONFIG.ROOM_MAX_PLAYERS || 25, val));
    const inp = $('#roomLimit');
    if (inp) inp.value = currentRoomLimit;
    const disp = $('#roomLimitDisplay');
    if (disp) disp.textContent = `${currentRoomLimit} jugadores`;
    document.querySelectorAll('#roomLimitPresets .preset-pill').forEach((pill) => {
      pill.classList.toggle('active', Number(pill.dataset.val) === currentRoomLimit);
    });
  };

  const limitMinusBtn = $('#roomLimitMinus');
  if (limitMinusBtn) {
    limitMinusBtn.addEventListener('click', () => updateRoomLimitDisplay(currentRoomLimit - 1));
  }
  const limitPlusBtn = $('#roomLimitPlus');
  if (limitPlusBtn) {
    limitPlusBtn.addEventListener('click', () => updateRoomLimitDisplay(currentRoomLimit + 1));
  }
  document.querySelectorAll('#roomLimitPresets .preset-pill').forEach((pill) => {
    pill.addEventListener('click', () => updateRoomLimitDisplay(Number(pill.dataset.val)));
  });

  // --- Botón Crear sala ---
  $('#createRoomConfirmBtn').addEventListener('click', () => createRoom(isRoomPublic));
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
    if (game.mode === 'multi') {
      if (net.role === 'host') {
        try { net.broadcast({ type: 'hostLeft', reason: 'El anfitrión abandonó la partida. La sala fue cerrada.' }); } catch (e) {}
        if (net.roomId) apiPost('delete', { id: net.roomId }).catch(() => {});
        setTimeout(() => {
          leaveEverything();
          resetToMenu('Has abandonado la partida');
        }, 50);
        return;
      }
      leaveEverything();
    }
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
  const panel = $('#minimapPanel');

  // Refresca Leaflet sin saturar la GPU en equipos modestos
  let _minimapResizeTimeout = null;
  function startMinimapRefresh() {
    stopMinimapRefresh();
    if (wrap.classList.contains('fullscreen')) return;
    _minimapResizeTimeout = setTimeout(() => {
      minimap.refreshSize();
    }, 130);
  }
  function stopMinimapRefresh() {
    if (_minimapResizeTimeout) {
      clearTimeout(_minimapResizeTimeout);
      _minimapResizeTimeout = null;
    }
  }

  panel.addEventListener('transitionend', (e) => {
    if (e.target === panel && (e.propertyName === 'width' || e.propertyName === 'height')) {
      stopMinimapRefresh();
      minimap.refreshSize();
    }
  });

  panel.addEventListener('mouseenter', () => {
    wrap.classList.add('expanded');
    startMinimapRefresh();
    minimap.setInteractive(true);
  });
  panel.addEventListener('mouseleave', () => {
    if (!minimapPinned) {
      wrap.classList.remove('expanded');
      startMinimapRefresh();
    }
  });

  // Al hacer clic en el panel del mapa se fija (pinned) para que no se cierre accidentalmente.
  panel.addEventListener('click', () => {
    expandMinimap(true);
  });

  // Al tocar o hacer clic fuera del minimapa (en la vista 360), se desancla y colapsa.
  document.addEventListener('pointerdown', (e) => {
    if (minimapPinned && !e.target.closest('#minimapWrap') && !e.target.closest('#resultPanel') && !e.target.closest('.hud-top')) {
      collapseMinimap();
      startMinimapRefresh();
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
  game.on('temporalTimer', ({ seconds }) => {
    const banner = $('#temporalBanner');
    const num = $('#temporalNumber');
    if (!banner || !num) return;
    if (seconds == null || seconds <= 0) {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
      num.textContent = `${seconds}s`;
    }
  });
  game.on('temporalBlind', ({ active }) => {
    if (active) {
      expandMinimap(true);
    }
  });
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
      resetToMenu('El anfitrión abandonó la partida. La sala fue cerrada.');
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

  // Si el anfitrión cierra o recarga la pestaña, notifica y cierra la sala
  window.addEventListener('beforeunload', () => {
    if (net.role === 'host' && (net.roomId || net.roomCode)) {
      try { net.broadcast({ type: 'hostLeft', reason: 'El anfitrión cerró la ventana.' }); } catch (e) {}
      if (net.roomId) {
        const data = new FormData();
        data.append('id', net.roomId);
        navigator.sendBeacon('api.php?action=delete', data);
      }
    }
  });
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
    game.meName = saved;
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
