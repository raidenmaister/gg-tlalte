// ============================================================================
// app.js — Punto de entrada. Coordina UI, red, visor panorámico y juego.
// ============================================================================

import { $, formatKm, formatNumber, clamp, escapeHtml, detectPotatoMode } from './utils.js?v=1.7.7';
import { CONFIG } from './config.js?v=1.7.7';
import { audio } from './audio.js?v=1.7.7';
import { PanoramaViewer } from './panorama.js?v=1.7.7';
import { Minimap } from './minimap.js?v=1.7.7';
import { Network } from './net.js?v=1.7.7';
import { Game } from './game.js?v=1.7.7';
import { AsciiEarthBackground } from './ascii-earth.js?v=1.7.7';

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
    if (audio && audio.userInteracted) {
      audio.startMenuMusic();
    }
  } else {
    asciiEarth.stop();
    if (audio) {
      audio.stopMenuMusic();
    }
  }

  // El badge de versión solo se muestra en los menús
  const badge = document.getElementById('versionBadge');
  if (badge) {
    badge.classList.toggle('hidden', !isMenu);
  }

  // Si salimos de los menús hacia el juego, cerrar modal de changelog si estaba abierto
  if (!isMenu) {
    const modal = document.getElementById('changelogModal');
    if (modal) modal.classList.add('hidden');
  }
}

let toastTimer = null;
function showToast(message, kind = 'info', duration = 2800) {
  const toast = $('#toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), duration);
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

    const ghost = document.createElement('div');
    ghost.className = 'hp-ghost';

    const fill = document.createElement('div');
    const hp = (typeof p.hp === 'number' && !isNaN(p.hp)) ? p.hp : CONFIG.MAX_HP;
    const pct = clamp((hp / CONFIG.MAX_HP) * 100, 0, 100);
    fill.className = 'hp-fill ' + hpColorClass(pct);
    fill.style.width = pct + '%';
    ghost.style.width = pct + '%';
    bar.appendChild(ghost);
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
    let ghost = row.querySelector('.hp-ghost');
    if (!ghost && bar) {
      ghost = document.createElement('div');
      ghost.className = 'hp-ghost';
      bar.insertBefore(ghost, fill);
    }
    const val = row.querySelector('.hp-val');
    let diff = row.querySelector('.hp-diff');
    if (!diff) {
      diff = document.createElement('span');
      diff.className = 'hp-diff';
      row.appendChild(diff);
    }
    if (!bar || !fill || !val) return;

    const damage = p.damage || 0;
    const healed = p.healed || 0;
    const afterPct = clamp((p.hp / CONFIG.MAX_HP) * 100, 0, 100);

    if (healed > 0) {
      diff.className = 'hp-diff heal';
      diff.textContent = `+${formatNumber(healed)} HP`;

      const floatEl = document.createElement('div');
      floatEl.className = 'hp-floating-damage heal';
      floatEl.textContent = `+${formatNumber(healed)} HP`;
      row.appendChild(floatEl);
      setTimeout(() => floatEl.remove(), 2500);

      fill.style.width = afterPct + '%';
      if (ghost) ghost.style.width = afterPct + '%';
      fill.className = 'hp-fill ' + hpColorClass(afterPct);
      val.textContent = Math.round(p.hp);
      return;
    }

    const beforeHp = clamp(p.hp + damage, 0, Math.max(CONFIG.MAX_HP, p.hp + damage));
    const beforePct = clamp((beforeHp / CONFIG.MAX_HP) * 100, 0, 100);

    if (damage <= 0) {
      diff.className = 'hp-diff safe';
      diff.textContent = '0 pts';
      fill.style.width = afterPct + '%';
      if (ghost) ghost.style.width = afterPct + '%';
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

    // 1. Ambas barras comienzan en el porcentaje previo
    if (ghost) ghost.style.width = beforePct + '%';
    fill.style.width = beforePct + '%';
    val.textContent = Math.round(beforeHp);

    // 2. A los 200ms la barra verde se retrae, revelando claramente la sección roja de vida perdida
    setTimeout(() => {
      fill.style.width = afterPct + '%';
      fill.className = 'hp-fill ' + hpColorClass(afterPct);
      val.textContent = Math.round(p.hp);
    }, 200);

    // 3. A los 850ms, la barra roja se drena suavemente hasta alcanzar el nuevo valor
    setTimeout(() => {
      if (ghost) ghost.style.width = afterPct + '%';
    }, 850);
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
  // Multijugador: mapa a pantalla completa sin panel bloqueante (visibilidad total de chinchetas y daño en barras HUD).
  if (result.mode === 'solo') {
    minimap.setFullscreen(true);
    $('#resultPanel').classList.add('result-overlay');
    $('#resultPanel').classList.remove('result-multi', 'hidden');
  } else {
    minimap.setFullscreen(true);
    $('#resultPanel').classList.add('hidden');
    $('#resultPanel').classList.remove('result-overlay', 'result-multi');
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
    const rows = [
      statRow('Distancia', result.myDistanceKm != null ? formatKm(result.myDistanceKm) : '—'),
      statRow('Puntos', '+' + formatNumber(result.myScore)),
    ];
    if (result.isPerfect) {
      const phaseStr = result.blurPhase != null
        ? (result.blurPhase === 0 ? ' (Enfocado)' : ` (Fase ${result.blurPhase}/5)`)
        : '';
      rows.push(statRow('⭐ ¡PERFECT!', `≤ 25m${phaseStr}`));
    }
    if (result.perfectStreak >= 2) {
      rows.push(`<div class="stat-row stat-streak"><span class="stat-label">🔥 Racha Perfects</span><span class="stat-value">x${result.perfectStreak}</span></div>`);
    }
    rows.push(statRow('Total', formatNumber(result.myTotalScore)));
    stats.innerHTML = rows.join('');
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
      let damageBadge = '';
      if (p.healed && p.healed > 0) {
        damageBadge = `<span class="res-damage-badge heal">💚 Cura: +${formatNumber(p.healed)} HP</span>`;
      } else if (p.damage > 0) {
        damageBadge = `<span class="res-damage-badge hit">Pierde: -${formatNumber(p.damage)} pts</span>`;
      } else {
        damageBadge = `<span class="res-damage-badge safe">⭐ ¡A salvo! 0 pts</span>`;
      }
      const streakBadge = (p.perfectStreak && p.perfectStreak >= 2)
        ? `<span class="res-streak-badge">🔥 x${p.perfectStreak}</span>`
        : '';
      return `
        <div class="res-multi-row">
          <div class="res-multi-info">
            <div class="res-multi-name" style="color:${color};">
              <span class="res-color-dot" style="background:${color};"></span>
              ${escapeHtml(p.name)} ${p.isPerfect ? '⭐' : ''} ${streakBadge}
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

  if (result.mode === 'solo') {
    $('#resultPanel').classList.remove('hidden');
  }
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
  const tunnelBanner = $('#tunnelBanner');
  if (tunnelBanner) tunnelBanner.classList.add('hidden');
  const blurBanner = $('#blurBanner');
  if (blurBanner) blurBanner.classList.add('hidden');
  $('#hudTimer').classList.remove('prepare');
  $('#confirmBtn').disabled = true;
  if (pano) {
    pano.setStatic(false);
  }
}

function resetGameUI() {
  resetGuessUI();
  if (pano) {
    pano.setBlind(false);
    pano.setStatic(false);
    if (typeof pano.setTunnelMode === 'function') pano.setTunnelMode(false);
    if (typeof pano.setBlurMode === 'function') pano.setBlurMode(false);
  }
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

  const chatBadge = $('#chatPlayersCountBadge');
  if (chatBadge) {
    chatBadge.textContent = `${displayPlayers.length} en línea`;
  }

  const roundsInfo = $('#roomRoundsInfo');
  if (roundsInfo) {
    let modeText = 'Modo Normal';
    if (net.gameMode === 'static') modeText = 'Modo Estático';
    else if (net.gameMode === 'temporal') modeText = `Modo Temporal (${net.temporalSeconds || 3}s)`;
    else if (net.gameMode === 'tunnel') modeText = `Zoom Progresivo (${net.tunnelSeconds || 3}s)`;
    else if (net.gameMode === 'static_tunnel') modeText = `Estático con Zoom (${net.tunnelSeconds || 3}s)`;
    else if (net.gameMode === 'blur') modeText = `Normal Borroso (${net.blurSeconds || 3}s)`;
    else if (net.gameMode === 'static_blur') modeText = `Estático Borroso (${net.blurSeconds || 3}s)`;
    roundsInfo.textContent = `${modeText} · ${net.rounds || CONFIG.DUEL_ROUNDS} rondas`;
  }

  const startBtn = $('#startBtn');
  startBtn.classList.toggle('hidden', !isHost);
  const canStart = isHost && displayPlayers.length >= 2;
  startBtn.disabled = !canStart;
  if (displayPlayers.length < 2) {
    startBtn.textContent = isHost ? `Esperando rivales… (${displayPlayers.length}/${limit})` : 'Esperando al anfitrión…';
  } else {
    startBtn.textContent = `Iniciar partida (${displayPlayers.length}/${limit})`;
  }

  const leaveBtn = $('#leaveLobbyBtn');
  if (leaveBtn) {
    leaveBtn.disabled = false;
    leaveBtn.textContent = 'Salir de la sala';
  }

  const deleteBtn = $('#deleteRoomBtn');
  if (deleteBtn) {
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'Eliminar sala';
    deleteBtn.classList.toggle('hidden', !isHost);
  }

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

/* -------------------------- Chat Grupal del Lobby -------------------------- */
const typingUsers = new Map(); // key -> { name, timeoutId }
let myTypingTimeout = null;
let isMyTyping = false;

function formatLocalTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function appendLobbyChatMessage({ senderName, text, timestamp, isMe = false, isSystem = false }) {
  const list = $('#chatMessagesList');
  if (!list) return;

  const msgDiv = document.createElement('div');
  const roleClass = isSystem ? 'msg-system' : (isMe ? 'msg-me' : 'msg-other');
  msgDiv.className = `chat-msg ${roleClass}`;

  if (isSystem) {
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'msg-body';
    bodyDiv.textContent = text;
    msgDiv.appendChild(bodyDiv);
  } else {
    const metaDiv = document.createElement('div');
    metaDiv.className = 'msg-header';

    const senderSpan = document.createElement('span');
    senderSpan.className = 'msg-author';
    senderSpan.textContent = senderName;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = formatLocalTime(timestamp);

    metaDiv.appendChild(senderSpan);
    metaDiv.appendChild(timeSpan);

    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'msg-body';
    bodyDiv.textContent = text;

    msgDiv.appendChild(metaDiv);
    msgDiv.appendChild(bodyDiv);
  }

  list.appendChild(msgDiv);

  // Auto-scroll al final del contenedor de mensajes
  const wrap = $('#chatMessagesWrap');
  if (wrap) {
    wrap.scrollTop = wrap.scrollHeight;
  }
}

function sendLobbyChatMessage() {
  const input = $('#chatInput');
  if (!input) return;
  const rawText = input.value.trim();
  if (!rawText) return;

  const text = rawText.slice(0, 200);
  input.value = '';

  // Cancelar indicador de escritura local
  notifyMyTyping(false);

  const timestamp = Date.now();
  const senderName = meName || 'Anónimo';

  appendLobbyChatMessage({
    senderName,
    text,
    timestamp,
    isMe: true,
  });

  const payload = {
    type: 'lobbyChat',
    senderName,
    text,
    timestamp,
    senderId: net.myId || 'me',
  };

  if (net.role === 'host') {
    net.broadcast(payload);
  } else if (net.role === 'guest') {
    net.send(payload);
  }
}

function notifyMyTyping(isTyping) {
  if (isMyTyping === isTyping) return;
  isMyTyping = isTyping;

  const payload = {
    type: 'lobbyTyping',
    senderName: meName || 'Anónimo',
    isTyping,
    senderId: net.myId || 'me',
  };

  if (net.role === 'host') {
    net.broadcast(payload);
  } else if (net.role === 'guest') {
    net.send(payload);
  }
}

function onChatInputChange() {
  const input = $('#chatInput');
  if (!input) return;

  if (input.value.trim().length > 0) {
    notifyMyTyping(true);
    clearTimeout(myTypingTimeout);
    myTypingTimeout = setTimeout(() => {
      notifyMyTyping(false);
    }, 2500);
  } else {
    clearTimeout(myTypingTimeout);
    notifyMyTyping(false);
  }
}

function handleLobbyChatMsg(data, fromPeerId) {
  if (!data) return;

  // Si somos host y el mensaje vino de un invitado, retransmitir a los demás invitados
  if (net.role === 'host') {
    net.broadcast(data, fromPeerId);
  }

  // Quitar al remitente del indicador de tipeo
  const typingKey = fromPeerId || data.senderId || data.senderName;
  if (typingKey && typingUsers.has(typingKey)) {
    const existing = typingUsers.get(typingKey);
    if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);
    typingUsers.delete(typingKey);
    renderTypingIndicator();
  }

  // Ignorar ecos propios si llegaran a reflejarse
  if (data.senderId === net.myId || (data.senderName === meName && !data.isSystem)) {
    return;
  }

  appendLobbyChatMessage({
    senderName: data.senderName || 'Anónimo',
    text: data.text || '',
    timestamp: data.timestamp || Date.now(),
    isMe: false,
    isSystem: !!data.isSystem,
  });

  // Notificación de sonido sutil si está habilitado
  if (audio && audio.enabled && typeof audio.click === 'function') {
    try { audio.click(); } catch (e) {}
  }
}

function handleLobbyTypingMsg(data, fromPeerId) {
  const key = fromPeerId || data.senderId || data.senderName;
  if (!key || key === net.myId) return;

  // Si somos host, retransmitir a los demás invitados
  if (net.role === 'host') {
    net.broadcast({
      type: 'lobbyTyping',
      senderName: data.senderName,
      isTyping: data.isTyping,
      senderId: key,
    }, fromPeerId);
  }

  if (data.isTyping) {
    const existing = typingUsers.get(key);
    if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);

    const timeoutId = setTimeout(() => {
      typingUsers.delete(key);
      renderTypingIndicator();
    }, 3200);

    typingUsers.set(key, { name: data.senderName, timeoutId });
  } else {
    const existing = typingUsers.get(key);
    if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);
    typingUsers.delete(key);
  }

  renderTypingIndicator();
}

function renderTypingIndicator() {
  const indicator = $('#chatTypingIndicator');
  const nameText = $('#typingNameText');
  if (!indicator || !nameText) return;

  const names = Array.from(typingUsers.values()).map(u => u.name);
  if (names.length === 0) {
    indicator.classList.add('hidden');
  } else {
    indicator.classList.remove('hidden');
    if (names.length === 1) {
      nameText.textContent = `${names[0]} está escribiendo…`;
    } else if (names.length === 2) {
      nameText.textContent = `${names[0]} y ${names[1]} están escribiendo…`;
    } else {
      nameText.textContent = 'Varios jugadores están escribiendo…';
    }
  }
}

function destroyLobbyChat() {
  // Limpiar temporizador de mi propio tipeo
  if (myTypingTimeout) {
    clearTimeout(myTypingTimeout);
    myTypingTimeout = null;
  }
  isMyTyping = false;

  // Limpiar temporizadores de tipeo de otros usuarios
  for (const [, user] of typingUsers.entries()) {
    if (user && user.timeoutId) clearTimeout(user.timeoutId);
  }
  typingUsers.clear();

  // Ocultar indicador
  const indicator = $('#chatTypingIndicator');
  if (indicator) indicator.classList.add('hidden');

  // Limpiar input de texto y ocultar teclado móvil
  const input = $('#chatInput');
  if (input) {
    input.value = '';
    try { input.blur(); } catch (e) {}
  }

  // Destruir historial del chat y resetear a estado limpio
  const list = $('#chatMessagesList');
  if (list) {
    list.innerHTML = `
      <div class="chat-msg msg-system">
        <div class="msg-body">¡Bienvenidos a la sala! Puedes chatear antes de iniciar.</div>
      </div>
    `;
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

    const meta = document.createElement('div');
    meta.className = 'public-room-meta';
    const limit = Number(room.limit) || 2;
    const count = Number(room.count) || 0;
    const rounds = Number(room.rounds) || 5;

    let modeLabel = '🎮 Normal';
    if (room.gameMode === 'static_tunnel') {
      const secs = Number(room.tunnelSeconds) || 3;
      modeLabel = `🛑 Estático + 🔍 Zoom (${secs}s)`;
    } else if (room.gameMode === 'tunnel') {
      const secs = Number(room.tunnelSeconds) || 3;
      modeLabel = `🎮 Normal + 🔍 Zoom (${secs}s)`;
    } else if (room.gameMode === 'static_blur') {
      const secs = Number(room.blurSeconds) || 3;
      modeLabel = `🛑 Estático + 🌫️ Borroso (${secs}s)`;
    } else if (room.gameMode === 'blur') {
      const secs = Number(room.blurSeconds) || 3;
      modeLabel = `🎮 Normal + 🌫️ Borroso (${secs}s)`;
    } else if (room.gameMode === 'static') {
      modeLabel = '🛑 Estático';
    } else if (room.gameMode === 'temporal') {
      const secs = Number(room.temporalSeconds) || 3;
      modeLabel = `⏱️ Temporal (${secs}s)`;
    }

    const playersTag = document.createElement('span');
    playersTag.className = 'public-room-tag';
    playersTag.textContent = `${count}/${limit} jugadores`;

    const modeTag = document.createElement('span');
    modeTag.className = 'public-room-tag public-room-tag-mode';
    modeTag.textContent = modeLabel;

    const roundsTag = document.createElement('span');
    roundsTag.className = 'public-room-tag public-room-tag-rounds';
    roundsTag.textContent = `${rounds} partidas`;

    meta.appendChild(playersTag);
    meta.appendChild(modeTag);
    meta.appendChild(roundsTag);

    const inProgress = room.status === 'in_progress' || room.status === 'playing';
    if (inProgress) {
      const statusTag = document.createElement('span');
      statusTag.className = 'public-room-tag public-room-tag-status in-progress';
      statusTag.textContent = '⚔️ En juego';
      meta.appendChild(statusTag);
    }

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
    btn.disabled = inProgress ? !isMyOldRoom : full;
    btn.textContent = isMyOldRoom
      ? 'Reconectarse'
      : (inProgress ? 'En juego' : (full ? 'Llena' : 'Unirse'));
    if (isMyOldRoom) {
      btn.classList.add('btn-reconnect');
    } else if (inProgress) {
      btn.classList.add('btn-in-game');
    }
    LOG('renderPublicList sala', { id: room.id, name: room.name, limit, count, full, inProgress, isMyOldRoom });
    btn.addEventListener('click', () => {
      if (inProgress && !isMyOldRoom) {
        showToast('La sala ya está en juego. No puedes unirte a una partida en curso.', 'error');
        return;
      }
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
function handleHostDeparture(reason) {
  if (gameInProgress() && game.mode === 'multi' && game.players.length === 2) {
    // Si es 1vs1 y el anfitrión abandona la partida, el jugador restante gana por abandono
    game.abort();
    leaveEverything();
    resetToMenu('¡Victoria por abandono! El anfitrión abandonó la partida.', 'info');
    return;
  }
  leaveEverything();
  resetToMenu(reason || 'El anfitrión abandonó la partida. La sala fue cerrada.');
}

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
    if (net.role === 'guest' && game.state === 'idle') showScreen('lobby');
    renderLobby();
    return;
  }
  if (data.type === 'lobbyChat') {
    handleLobbyChatMsg(data, fromPeerId);
    return;
  }
  if (data.type === 'lobbyTyping') {
    handleLobbyTypingMsg(data, fromPeerId);
    return;
  }
  if (data.type === 'start') {
    game.meName = meName;
    game.guestOnStart(data);
    guestPrepareStart();
    return;
  }
  if (data.type === 'hostLeft') {
    handleHostDeparture(data.reason);
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
    destroyLobbyChat();
    await ensureViewers();
    // Cortina activa para evitar cualquier destello de vista previa antes de que el host ordene comenzar
    pano.setBlind(true, 'Sincronizando jugadores…', 'Esperando inicio de ronda…', true);
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
let soloNormalVariant = 'standard';
let soloStaticVariant = 'standard';
let currentSoloTemporalSecs = CONFIG.DEFAULT_TEMPORAL_SECONDS || 3;
let currentSoloTunnelSecs = CONFIG.DEFAULT_TUNNEL_SECONDS || 3;
let currentSoloBlurSecs = CONFIG.DEFAULT_BLUR_SECONDS || 3;

let currentMultiMode = 'normal';
let multiNormalVariant = 'standard';
let multiStaticVariant = 'standard';
let currentMultiTemporalSecs = CONFIG.DEFAULT_TEMPORAL_SECONDS || 3;
let currentMultiTunnelSecs = CONFIG.DEFAULT_TUNNEL_SECONDS || 3;
let currentMultiBlurSecs = CONFIG.DEFAULT_BLUR_SECONDS || 3;

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

    const isZoom = (currentSoloMode === 'normal' && soloNormalVariant === 'zoom') ||
                   (currentSoloMode === 'static' && soloStaticVariant === 'zoom');
    const isBlur = (currentSoloMode === 'normal' && soloNormalVariant === 'blur') ||
                   (currentSoloMode === 'static' && soloStaticVariant === 'blur');
    let effectiveMode = currentSoloMode;
    if (currentSoloMode === 'normal' && isZoom) effectiveMode = 'tunnel';
    if (currentSoloMode === 'static' && isZoom) effectiveMode = 'static_tunnel';
    if (currentSoloMode === 'normal' && isBlur) effectiveMode = 'blur';
    if (currentSoloMode === 'static' && isBlur) effectiveMode = 'static_blur';

    game.startSolo(rounds, effectiveMode, currentSoloTemporalSecs, currentSoloTunnelSecs, isZoom, currentSoloBlurSecs, isBlur);
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

  // Notificar en el chat del lobby tanto localmente como a todos los invitados
  const startChatMsg = {
    type: 'lobbyChat',
    senderName: 'Sistema',
    text: '🚀 Iniciando partida…',
    timestamp: Date.now(),
    isSystem: true,
  };
  appendLobbyChatMessage(startChatMsg);
  net.broadcast(startChatMsg);

  net.updateRoomStatus('in_progress');
  try {
    setLoadingText('Preparando partida…');
    showScreen('loading');
    await ensureData();
    showScreen('game');
    resetGameUI();
    destroyLobbyChat();
    await ensureViewers();
    setTimeout(() => pano.refresh(), 60);
    game.meName = meName;

    const isZoom = (currentMultiMode === 'normal' && multiNormalVariant === 'zoom') ||
                   (currentMultiMode === 'static' && multiStaticVariant === 'zoom');
    const isBlur = (currentMultiMode === 'normal' && multiNormalVariant === 'blur') ||
                   (currentMultiMode === 'static' && multiStaticVariant === 'blur');
    let effectiveMode = currentMultiMode;
    if (currentMultiMode === 'normal' && isZoom) effectiveMode = 'tunnel';
    if (currentMultiMode === 'static' && isZoom) effectiveMode = 'static_tunnel';
    if (currentMultiMode === 'normal' && isBlur) effectiveMode = 'blur';
    if (currentMultiMode === 'static' && isBlur) effectiveMode = 'static_blur';

    game.hostStart(effectiveMode, currentMultiTemporalSecs, currentMultiTunnelSecs, isZoom, currentMultiBlurSecs, isBlur);
  } catch (err) {
    net.updateRoomStatus('waiting');
    showError('Error al cargar: ' + err.message);
    showScreen('lobby');
    renderLobby();
  }
}

function createRoom(isPublic = false) {
  audio.ensure();
  destroyLobbyChat();
  const rounds = Number($('#roomRounds').value) || CONFIG.DUEL_ROUNDS;
  const limit = Number($('#roomLimit').value) || CONFIG.ROOM_MAX_PLAYERS;

  const isZoom = (currentMultiMode === 'normal' && multiNormalVariant === 'zoom') ||
                 (currentMultiMode === 'static' && multiStaticVariant === 'zoom');
  const isBlur = (currentMultiMode === 'normal' && multiNormalVariant === 'blur') ||
                 (currentMultiMode === 'static' && multiStaticVariant === 'blur');
  let effectiveMode = currentMultiMode;
  if (currentMultiMode === 'normal' && isZoom) effectiveMode = 'tunnel';
  if (currentMultiMode === 'static' && isZoom) effectiveMode = 'static_tunnel';
  if (currentMultiMode === 'normal' && isBlur) effectiveMode = 'blur';
  if (currentMultiMode === 'static' && isBlur) effectiveMode = 'static_blur';

  LOG('createRoom', { isPublic, meName, rounds, limit, effectiveMode, isZoom, isBlur, currentMultiTemporalSecs, currentMultiTunnelSecs, currentMultiBlurSecs });
  net.createRoom(meName, isPublic, {
    rounds,
    limit,
    gameMode: effectiveMode,
    zoomMode: isZoom,
    blurMode: isBlur,
    temporalSeconds: currentMultiTemporalSecs,
    tunnelSeconds: currentMultiTunnelSecs,
    blurSeconds: currentMultiBlurSecs,
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
    gameMode: net.gameMode,
    temporalSeconds: net.temporalSeconds,
    tunnelSeconds: net.tunnelSeconds,
    blurSeconds: net.blurSeconds,
    blurMode: net.blurMode,
  }));
}

async function leaveRoom() {
  audio.ensure();
  audio.click();
  const leaveBtn = $('#leaveLobbyBtn');
  if (leaveBtn) {
    leaveBtn.disabled = true;
    leaveBtn.textContent = 'Saliendo…';
  }
  try {
    if (net.role === 'host') {
      const roomId = net.roomId;
      const msg = { type: 'hostLeft', reason: 'El anfitrión cerró la sala.' };
      try { net.broadcast(msg); } catch (e) {}
      if (roomId) {
        apiPost('send-msg', { id: roomId, from: net.myId || 'host', to: 'all', payload: JSON.stringify(msg) }).catch(() => {});
        apiPost('delete', { id: roomId }).catch(() => {});
      }
    } else if (net.role === 'guest') {
      const msg = { type: 'guestLeave', peerId: net.myId, name: meName };
      try { net.broadcast(msg); } catch (e) {}
      if (net.roomId) {
        apiPost('send-msg', { id: net.roomId, from: net.myId || 'guest', to: 'host', payload: JSON.stringify(msg) }).catch(() => {});
      }
    }
  } catch (e) {
    LOG('leaveRoom error:', e);
  }
  leaveEverything();
  resetToMenu('Saliste de la sala', 'info');
}

async function deleteRoom() {
  audio.ensure();
  audio.click();
  const deleteBtn = $('#deleteRoomBtn');
  if (deleteBtn) {
    deleteBtn.disabled = true;
    deleteBtn.textContent = 'Eliminando…';
  }
  try {
    if (net.role === 'host') {
      const roomId = net.roomId;
      const msg = { type: 'hostLeft', reason: 'El anfitrión eliminó la sala.' };
      try { net.broadcast(msg); } catch (e) {}
      if (roomId) {
        apiPost('send-msg', { id: roomId, from: net.myId || 'host', to: 'all', payload: JSON.stringify(msg) }).catch(() => {});
        apiPost('delete', { id: roomId }).catch(() => {});
      }
    }
  } catch (e) {
    LOG('deleteRoom error:', e);
  }
  leaveEverything();
  resetToMenu('Sala eliminada', 'info');
}

function joinRoom(code) {
  LOG('joinRoom (app)', { code, meName });
  destroyLobbyChat();
  game.meName = meName;
  audio.ensure();
  net.joinRoom(code, meName);
}

function resetToMenu(message, kind = 'error') {
  destroyLobbyChat();
  try {
    game.abort();
  } catch (e) {
    LOG('game.abort error:', e);
  }
  if (message) showToast(message, kind);
  try {
    resetGameUI();
  } catch (e) {
    LOG('resetGameUI error:', e);
  }
  const leaveBtn = $('#leaveLobbyBtn');
  if (leaveBtn) {
    leaveBtn.disabled = false;
    leaveBtn.textContent = 'Salir de la sala';
  }
  const deleteBtn = $('#deleteRoomBtn');
  if (deleteBtn) {
    deleteBtn.disabled = false;
    deleteBtn.textContent = 'Eliminar sala';
  }
  showScreen('menu');
  const nameEl = $('#menuPlayerName');
  if (nameEl) nameEl.textContent = meName;
}

function leaveEverything() {
  destroyLobbyChat();
  localStorage.removeItem(ROOM_KEY);
  try {
    net.leave();
  } catch (e) {
    LOG('leaveEverything error:', e);
  }
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
    audio.userInteracted = true;
    audio.ensure();
    audio.click();
    audio.startMenuMusic();
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
    updateSoloModeUI();
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
  function updateSoloModeUI() {
    const isNormalZoom = currentSoloMode === 'normal' && soloNormalVariant === 'zoom';
    const isStaticZoom = currentSoloMode === 'static' && soloStaticVariant === 'zoom';
    const hasZoom = isNormalZoom || isStaticZoom;

    const isNormalBlur = currentSoloMode === 'normal' && soloNormalVariant === 'blur';
    const isStaticBlur = currentSoloMode === 'static' && soloStaticVariant === 'blur';
    const hasBlur = isNormalBlur || isStaticBlur;

    const normalSub = $('#soloNormalSubmode');
    if (normalSub) normalSub.classList.toggle('hidden', currentSoloMode !== 'normal');

    const staticSub = $('#soloStaticSubmode');
    if (staticSub) staticSub.classList.toggle('hidden', currentSoloMode !== 'static');

    const tempConf = $('#soloTemporalConfig');
    if (tempConf) tempConf.classList.toggle('hidden', currentSoloMode !== 'temporal');

    const tunnelConf = $('#soloTunnelConfig');
    if (tunnelConf) tunnelConf.classList.toggle('hidden', !hasZoom);

    const blurConf = $('#soloBlurConfig');
    if (blurConf) blurConf.classList.toggle('hidden', !hasBlur);

    const descEl = $('#soloModeDesc');
    if (descEl) {
      if (currentSoloMode === 'normal') {
        if (isNormalZoom) {
          descEl.textContent = 'Modo Normal con Zoom: Mueve la vista 360°, pero la imagen inicia con zoom telescópico y se aleja paso a paso.';
        } else if (isNormalBlur) {
          descEl.textContent = 'Modo Normal Borroso: Mueve la vista 360° sin zoom. La imagen inicia 100% desenfocada y se aclara por etapas.';
        } else {
          descEl.textContent = 'Modo Normal estándar: Mueve la vista 360° y haz zoom libremente.';
        }
      } else if (currentSoloMode === 'static') {
        if (isStaticZoom) {
          descEl.textContent = 'Modo Estático con Zoom: Vista fija hacia adelante, e inicia con zoom telescópico que se aleja paso a paso.';
        } else if (isStaticBlur) {
          descEl.textContent = 'Modo Estático Borroso: Vista fija hacia adelante sin zoom. La imagen inicia 100% desenfocada y se aclara por etapas.';
        } else {
          descEl.textContent = 'Modo Estático estándar: Vista fija hacia adelante. ¡Sin rotar ni desplazarte!';
        }
      } else if (currentSoloMode === 'temporal') {
        descEl.textContent = 'Modo Temporal: La imagen desaparece tras unos segundos. ¡Memoriza rápido!';
      }
    }

    // Actualiza dinámicamente los tiempos en las pestañas (+1 min en Zoom y Borroso)
    const times = (hasZoom || hasBlur)
      ? { 5: '⏱️ 2:45', 7: '⏱️ 3:00', 10: '⏱️ 3:30', 15: '⏱️ 4:30' }
      : { 5: '⏱️ 1:45', 7: '⏱️ 2:00', 10: '⏱️ 2:30', 15: '⏱️ 3:30' };

    document.querySelectorAll('#soloRoundsSelector .round-tab').forEach((btn) => {
      const r = Number(btn.dataset.rounds);
      const sub = btn.querySelector('.round-tab-sub');
      if (sub && times[r]) {
        sub.textContent = times[r];
      }
    });
  }

  document.querySelectorAll('#soloModeSelector .mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloModeSelector .mode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSoloMode = btn.dataset.mode || 'normal';
      updateSoloModeUI();
    });
  });

  document.querySelectorAll('#soloNormalSubTabs .submode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloNormalSubTabs .submode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      soloNormalVariant = btn.dataset.variant || 'standard';
      updateSoloModeUI();
    });
  });

  document.querySelectorAll('#soloStaticSubTabs .submode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloStaticSubTabs .submode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      soloStaticVariant = btn.dataset.variant || 'standard';
      updateSoloModeUI();
    });
  });

  document.querySelectorAll('#soloTempPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloTempPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSoloTemporalSecs = Number(btn.dataset.sec) || 3;
    });
  });
  document.querySelectorAll('#soloTunnelPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloTunnelPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSoloTunnelSecs = Number(btn.dataset.sec) || 3;
    });
  });
  document.querySelectorAll('#soloBlurPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#soloBlurPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentSoloBlurSecs = Number(btn.dataset.sec) || 3;
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
  function updateMultiModeUI() {
    const isNormalZoom = currentMultiMode === 'normal' && multiNormalVariant === 'zoom';
    const isStaticZoom = currentMultiMode === 'static' && multiStaticVariant === 'zoom';
    const hasZoom = isNormalZoom || isStaticZoom;

    const isNormalBlur = currentMultiMode === 'normal' && multiNormalVariant === 'blur';
    const isStaticBlur = currentMultiMode === 'static' && multiStaticVariant === 'blur';
    const hasBlur = isNormalBlur || isStaticBlur;

    const normalSub = $('#multiNormalSubmode');
    if (normalSub) normalSub.classList.toggle('hidden', currentMultiMode !== 'normal');

    const staticSub = $('#multiStaticSubmode');
    if (staticSub) staticSub.classList.toggle('hidden', currentMultiMode !== 'static');

    const tempConf = $('#multiTemporalConfig');
    if (tempConf) tempConf.classList.toggle('hidden', currentMultiMode !== 'temporal');

    const tunnelConf = $('#multiTunnelConfig');
    if (tunnelConf) tunnelConf.classList.toggle('hidden', !hasZoom);

    const blurConf = $('#multiBlurConfig');
    if (blurConf) blurConf.classList.toggle('hidden', !hasBlur);

    const descEl = $('#multiModeDesc');
    if (descEl) {
      if (currentMultiMode === 'normal') {
        if (isNormalZoom) {
          descEl.textContent = 'Modo Normal con Zoom: Todos juegan con vista 360° y zoom sincronizado que se aleja al mismo tiempo.';
        } else if (isNormalBlur) {
          descEl.textContent = 'Modo Normal Borroso: Todos juegan con vista 360° y desenfoque progresivo sincronizado.';
        } else {
          descEl.textContent = 'Modo Normal estándar: Mueve la vista 360° y haz zoom libremente.';
        }
      } else if (currentMultiMode === 'static') {
        if (isStaticZoom) {
          descEl.textContent = 'Modo Estático con Zoom: Vista fija hacia adelante sin rotar, y zoom sincronizado para todos.';
        } else if (isStaticBlur) {
          descEl.textContent = 'Modo Estático Borroso: Vista fija hacia adelante sin zoom, y desenfoque progresivo sincronizado.';
        } else {
          descEl.textContent = 'Modo Estático estándar: Vista fija hacia adelante. ¡Sin rotar ni desplazarte!';
        }
      } else if (currentMultiMode === 'temporal') {
        descEl.textContent = 'Modo Temporal: La imagen desaparece tras unos segundos. ¡Memoriza rápido!';
      }
    }
  }

  document.querySelectorAll('#multiModeSelector .mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiModeSelector .mode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMultiMode = btn.dataset.mode || 'normal';
      updateMultiModeUI();
    });
  });

  document.querySelectorAll('#multiNormalSubTabs .submode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiNormalSubTabs .submode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      multiNormalVariant = btn.dataset.variant || 'standard';
      updateMultiModeUI();
    });
  });

  document.querySelectorAll('#multiStaticSubTabs .submode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiStaticSubTabs .submode-tab').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      multiStaticVariant = btn.dataset.variant || 'standard';
      updateMultiModeUI();
    });
  });

  document.querySelectorAll('#multiTempPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiTempPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMultiTemporalSecs = Number(btn.dataset.sec) || 3;
    });
  });
  document.querySelectorAll('#multiTunnelPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiTunnelPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMultiTunnelSecs = Number(btn.dataset.sec) || 3;
    });
  });
  document.querySelectorAll('#multiBlurPills .pill-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#multiBlurPills .pill-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentMultiBlurSecs = Number(btn.dataset.sec) || 3;
    });
  });

  // --- Historial de versiones (Changelog Modal) ---
  const changelogModal = $('#changelogModal');
  const openChangelog = () => {
    if (changelogModal) {
      changelogModal.classList.remove('hidden');
      audio.ensure();
      audio.click();
    }
  };
  const closeChangelog = () => {
    if (changelogModal) {
      changelogModal.classList.add('hidden');
      audio.ensure();
      audio.click();
    }
  };

  const changelogBtn = $('#changelogBtn');
  if (changelogBtn) changelogBtn.addEventListener('click', openChangelog);

  const changelogCloseBtn = $('#changelogCloseBtn');
  if (changelogCloseBtn) changelogCloseBtn.addEventListener('click', closeChangelog);

  const changelogCloseBtnBottom = $('#changelogCloseBtnBottom');
  if (changelogCloseBtnBottom) changelogCloseBtnBottom.addEventListener('click', closeChangelog);

  if (changelogModal) {
    changelogModal.addEventListener('click', (e) => {
      if (e.target === changelogModal) closeChangelog();
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && changelogModal && !changelogModal.classList.contains('hidden')) {
      closeChangelog();
    }
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
    audio.userInteracted = true;
    audio.ensure();
    audio.toggle();
    updateSoundBtn();
    const isMenu = ['name', 'menu', 'solo', 'create', 'join', 'leaderboard', 'lobby'].some((s) => {
      const el = document.getElementById('screen-' + s);
      return el && !el.classList.contains('hidden');
    });
    if (audio.enabled && isMenu) {
      audio.startMenuMusic();
    }
  });
  updateSoundBtn();

  // --- Unirse ---
  const joinCodeInput = $('#joinCodeInput');
  joinCodeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  const doJoin = async () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    LOG('doJoin', { code });
    if (code.length !== CONFIG.CODE_LENGTH) {
      showToast('El código debe tener 4 caracteres', 'error');
      return;
    }

    const roomId = CONFIG.PEER_PREFIX + code;
    try {
      const info = await apiPost('check-room', { id: roomId });
      if (info && info.ok) {
        if (info.status === 'in_progress' || info.status === 'playing') {
          showToast('La sala ya está en juego. No puedes unirte a una partida en curso.', 'error');
          return;
        }
        if (info.limit > 0 && info.count >= info.limit) {
          showToast('La sala está llena.', 'error');
          return;
        }
      }
    } catch (e) {}

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

  // --- Chat del Lobby ---
  const chatInput = $('#chatInput');
  const chatSendBtn = $('#chatSendBtn');
  if (chatSendBtn) {
    chatSendBtn.addEventListener('click', (e) => {
      e.preventDefault();
      audio.ensure();
      sendLobbyChatMessage();
    });
  }
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        audio.ensure();
        sendLobbyChatMessage();
      }
    });
    chatInput.addEventListener('input', onChatInputChange);
  }

  // --- Juego ---
  const recoverBtn = $('#panoRecoverBtn');
  if (recoverBtn) {
    recoverBtn.addEventListener('click', () => {
      audio.ensure();
      audio.click();
      if (game) game.recoverPano();
      showToast('🔄 Panorámica recargada', 'info', 1800);
    });
  }
  window.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      const activeTag = document.activeElement ? document.activeElement.tagName.toLowerCase() : '';
      if (activeTag === 'input' || activeTag === 'textarea') return;
      if (gameInProgress() && game) {
        game.recoverPano();
        showToast('🔄 Panorámica recargada', 'info', 1800);
      }
    }
  });

  $('#confirmBtn').addEventListener('click', () => {
    if (!game.hasPick()) {
      showToast('Coloca tu chincheta en el mapa antes de confirmar', 'error');
      return;
    }
    collapseMinimap();
    game.confirmGuess();
  });
  $('#leaveGameBtn').addEventListener('click', () => {
    if (game.mode === 'multi') {
      if (net.role === 'host') {
        const msg = { type: 'hostLeft', reason: 'El anfitrión abandonó la partida. La sala fue cerrada.' };
        try { net.broadcast(msg); } catch (e) {}
        if (net.roomId) {
          apiPost('send-msg', { id: net.roomId, from: 'host', to: 'all', payload: JSON.stringify(msg) }).catch(() => {});
          apiPost('delete', { id: net.roomId }).catch(() => {});
        }
        setTimeout(() => {
          leaveEverything();
          resetToMenu('Has abandonado la partida');
        }, 350);
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
    audio.ensure();
    audio.click();
    try {
      if (game.mode === 'multi') {
        if (net.role === 'host') {
          const msg = { type: 'hostLeft', reason: 'El anfitrión finalizó la partida y volvió al menú.' };
          try { net.broadcast(msg); } catch (e) {}
          if (net.roomId) {
            apiPost('send-msg', { id: net.roomId, from: 'host', to: 'all', payload: JSON.stringify(msg) }).catch(() => {});
            apiPost('delete', { id: net.roomId }).catch(() => {});
          }
        }
        leaveEverything();
      }
    } catch (e) {
      LOG('gameOverBtn multi leave error:', e);
    }
    resetToMenu();
  });

  // --- Minimapa (colapsable) ---
  const wrap = $('#minimapWrap');
  const panel = $('#minimapPanel');
  const recenterBtn = $('#recenterMapBtn');
  if (recenterBtn) {
    recenterBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      minimap.recenter();
    });
  }

  const toggleLayerBtn = $('#toggleLayerBtn');
  const updateToggleLayerBtn = () => {
    if (!toggleLayerBtn) return;
    const isSat = minimap.currentLayerType === 'satellite';
    toggleLayerBtn.textContent = isSat ? '🗺️' : '🛰️';
    toggleLayerBtn.title = isSat ? 'Cambiar a vista estándar (calles)' : 'Cambiar a vista satelital';
    toggleLayerBtn.classList.toggle('active', isSat);
  };
  if (toggleLayerBtn) {
    updateToggleLayerBtn();
    toggleLayerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      minimap.toggleLayer();
      updateToggleLayerBtn();
    });
  }

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
    if (wrap.classList.contains('fullscreen') || !gameInProgress() || game.state !== 'playing') return;
    wrap.classList.add('expanded');
    startMinimapRefresh();
    minimap.setInteractive(true);
  });
  panel.addEventListener('mouseleave', () => {
    if (!minimapPinned && !wrap.classList.contains('fullscreen')) {
      wrap.classList.remove('expanded');
      startMinimapRefresh();
    }
  });

  // Al hacer clic en el panel del mapa se fija (pinned) para que no se cierre accidentalmente.
  panel.addEventListener('click', () => {
    if (wrap.classList.contains('fullscreen') || !gameInProgress() || game.state !== 'playing') return;
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
  game.on('tunnelProgress', (data) => {
    const banner = $('#tunnelBanner');
    if (!banner) return;
    if (!data || data.isFinished) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    const badge = $('#tunnelStepBadge');
    if (badge) {
      const stepNames = { 4: '4/4 (MÁXIMO)', 3: '3/4 (MEDIO ALTO)', 2: '2/4 (MEDIO)', 1: '1/4 (NORMAL)' };
      badge.textContent = `🔍 ZOOM ${stepNames[data.step] || (data.step + '/4')}`;
    }
    const bonusTag = $('#tunnelBonusTag');
    if (bonusTag) {
      const bonuses = { 4: 'HASTA +1,500 PTS', 3: 'HASTA +750 PTS', 2: 'HASTA +250 PTS', 1: 'SIN BONUS (5,000 PTS)' };
      bonusTag.textContent = bonuses[data.step] || 'BONUS';
    }
    const bar = $('#tunnelProgressBar');
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, data.progressPercent))}%`;
    }
    const nextLabel = $('#tunnelNextLabel');
    const countdown = $('#tunnelCountdown');
    if (countdown) {
      if (data.step === 1) {
        if (nextLabel) nextLabel.textContent = 'Estado:';
        countdown.textContent = 'Zoom mínimo';
      } else {
        if (nextLabel) nextLabel.textContent = 'Siguiente zoom en';
        const secs = Number(data.timeLeft) || 0;
        countdown.textContent = `${secs.toFixed(1)}s`;
      }
    }
  });
  game.on('blurProgress', (data) => {
    const banner = $('#blurBanner');
    if (!banner) return;
    if (!data || data.isFinished) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    const phase = data.phase !== undefined ? data.phase : (data.step !== undefined ? data.step : 1);
    const badge = $('#blurStepBadge');
    if (badge) {
      const stepNames = {
        1: '100% (FASE 1/5)',
        2: '80% (FASE 2/5)',
        3: '60% (FASE 3/5)',
        4: '40% (FASE 4/5)',
        5: '20% (FASE 5/5)',
        0: '0% (ENFOCADO)',
      };
      badge.textContent = `🌫️ BORROSO ${stepNames[phase] || `${phase}/5`}`;
    }
    const bonusTag = $('#blurBonusTag');
    if (bonusTag) {
      const heals = {
        1: 'PERFECT: +1,600 HP',
        2: 'PERFECT: +1,200 HP',
        3: 'PERFECT: +900 HP',
        4: 'PERFECT: +600 HP',
        5: 'PERFECT: +300 HP',
        0: 'PERFECT: +150 HP',
      };
      bonusTag.textContent = heals[phase] || 'PERFECT BONUS';
    }
    const bar = $('#blurProgressBar');
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, data.progressPercent))}%`;
    }
    const nextLabel = $('#blurNextLabel');
    const countdown = $('#blurCountdown');
    if (countdown) {
      if (phase === 0) {
        if (nextLabel) nextLabel.textContent = 'Estado:';
        countdown.textContent = 'Enfocado (100%)';
      } else {
        if (nextLabel) nextLabel.textContent = 'Enfocando en';
        const secs = Number(data.timeLeft) || 0;
        countdown.textContent = `${secs.toFixed(1)}s`;
      }
    }
  });
}

function wireNet() {
  net.cb.isGameInProgress = () => {
    return gameInProgress() || (game && (game.state === 'playing' || game.state === 'result' || game._hostStarted));
  };

  net.cb.isExistingActivePlayer = (name) => {
    if (!game || !game.players || !game.players.length) return false;
    const lower = (name || '').trim().toLowerCase();
    return game.players.some((p) => (p.name || '').trim().toLowerCase() === lower);
  };

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
    if (gameInProgress() && net.role === 'host') {
      game.syncGuestReconnect(peerId);
    }
  };

  net.cb.onPlayers = (list, config) => {
    LOG('onPlayers', { list, config });
    players = list;
    persistActiveRoom();
    renderLobby();
  };

  net.cb.onGuestLeave = (peerId) => {
    LOG('onGuestLeave', { peerId, role: net.role });
    if (peerId && typingUsers.has(peerId)) {
      const user = typingUsers.get(peerId);
      if (user && user.timeoutId) clearTimeout(user.timeoutId);
      typingUsers.delete(peerId);
      renderTypingIndicator();
    }
    if (net.role === 'host') {
      players = net.players;
      renderLobby();
      if (gameInProgress()) {
        game.removePlayer(peerId);
      }
      showToast('Un jugador se desconectó', 'warning');
    } else {
      // Guest perdió al host.
      handleHostDeparture('El anfitrión abandonó o eliminó la sala.');
    }
  };

  net.cb.onHostLeft = (reason) => {
    handleHostDeparture(reason);
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
    } else if (type === 'EN_CURSO') {
      resetToMenu('La sala ya está en juego. No puedes unirte a una partida en curso.');
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
  detectPotatoMode();
  const versionBadge = $('#versionBadge');
  if (versionBadge) {
    versionBadge.textContent = CONFIG.VERSION || 'BETA v1.7.7';
    versionBadge.style.cursor = 'pointer';
    versionBadge.title = 'Ver historial de versiones';
    versionBadge.addEventListener('click', () => {
      if (!versionBadge.classList.contains('has-update')) {
        const modal = document.getElementById('changelogModal');
        if (modal) {
          modal.classList.remove('hidden');
          audio.click();
        }
      }
    });
  }

  wire();
  wireGame();
  wireNet();

  // Compás: actualiza al rotar la cámara.
  pano.callbacks.onPovChange = (heading) => updateCompass(heading);

  // Colocar marcador en el minimapa.
  minimap.callbacks.onPick = (lat, lng) => {
    if (!gameInProgress() || game.state !== 'playing') return;
    game.placePick(lat, lng);
    audio.place();
  };

  // Desbloqueo de audio y música BGM al primer gesto del usuario.
  const unlockAudioGesture = () => {
    audio.userInteracted = true;
    audio.ensure();
    const isMenu = ['name', 'menu', 'solo', 'create', 'join', 'leaderboard', 'lobby'].some((s) => {
      const el = document.getElementById('screen-' + s);
      return el && !el.classList.contains('hidden');
    });
    if (isMenu) audio.startMenuMusic();
  };
  document.addEventListener('pointerdown', unlockAudioGesture, { once: true });
  document.addEventListener('keydown', unlockAudioGesture, { once: true });

  // Captura errores globales y promesas rechazadas para que nada quede silencioso.
  window.addEventListener('error', (e) => {
    if (e && e.message && (e.message.includes('ERR_BLOCKED_BY_CLIENT') || e.message.includes('QuotaService') || e.message.includes('gen_204'))) return;
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

  // Limpieza de cualquier Service Worker antiguo para evitar que sirva archivos cacheados
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then((registrations) => {
      for (const reg of registrations) reg.unregister();
    }).catch(() => {});
  }

  // Comprobación de versión en caliente: si el servidor publica una nueva versión, alertar al usuario
  let _updateToastShown = false;
  async function checkVersionUpdate() {
    // Si el jugador está activamente conjeturando en una ronda, no interrumpirlo
    if (gameInProgress() || (game && game.state === 'playing')) {
      return;
    }
    try {
      const res = await fetch('version.json?_t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) {
        const vData = await res.json();
        const curVer = (CONFIG.VERSION || '').replace(/^BETA\s+v/i, '').trim();
        if (vData && vData.version && vData.version !== curVer) {
          LOG('Nueva versión detectada:', vData.version, 'actual:', curVer);

          // 1. Resaltar badge de versión flotante
          const badge = document.getElementById('versionBadge');
          if (badge) {
            badge.textContent = `BETA v${vData.version} (Shift+F5)`;
            badge.classList.add('has-update');
            badge.title = 'Haz clic o presiona Shift + F5 para actualizar a la última versión';
            badge.onclick = () => window.location.reload(true);
          }

          // 2. Mostrar banner destacado en el menú
          const menuBanner = document.getElementById('menuUpdateBanner');
          if (menuBanner) {
            menuBanner.classList.remove('hidden');
            const menuText = document.getElementById('menuUpdateText');
            if (menuText) {
              menuText.innerHTML = `¡Nueva versión <strong>v${escapeHtml(vData.version)}</strong> disponible! Presiona <strong>Shift + F5</strong> para actualizar.`;
            }
            const menuBtn = document.getElementById('menuUpdateBtn');
            if (menuBtn) {
              menuBtn.onclick = () => window.location.reload(true);
            }
          }

          // 3. Notificación toast persistente
          if (!_updateToastShown) {
            _updateToastShown = true;
            showToast(`¡Nueva versión BETA v${vData.version} disponible! Presiona Shift + F5 para actualizar`, 'warning', 35000);
          }
        }
      }
    } catch (e) {}
  }
  setInterval(checkVersionUpdate, 5000);
  window.addEventListener('focus', () => checkVersionUpdate());
  checkVersionUpdate();

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
