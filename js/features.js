// ============================================================================
// features.js — Reto diario, perfil del jugador, acceso desde otros dispositivos,
// avisos del administrador e instalación como app (PWA).  (v1.0.0)
//
// app.js le inyecta sus utilidades con setup(ctx) para no duplicar estado.
// ============================================================================

import { identity, secureApi } from './secure.js?v=1.0.0';
import { $, formatNumber, formatKm, escapeHtml } from './utils.js?v=1.0.0';

let ctx = null;

export const MODE_LABELS = {
  normal: '🎮 Normal',
  static: '🛑 Estático',
  temporal: '⏱️ Temporal',
  tunnel: '🔍 Normal con Zoom',
  static_tunnel: '🔍 Estático con Zoom',
  blur: '🌫️ Normal Borroso',
  static_blur: '🌫️ Estático Borroso',
  flashlight: '🔦 Linterna Táctica',
  satellite: '🛰️ Ojo de Halcón',
  race: '🏁 Carrera',
};

const MODE_DESCS = {
  normal: 'Vista 360° libre: gira, haz zoom y encuentra el lugar.',
  static: 'Cámara fija hacia adelante: sin girar ni moverte.',
  temporal: 'La imagen sólo se ve 3 segundos. ¡Memoriza rápido!',
  tunnel: 'Inicia con zoom telescópico que se aleja cada 5 s. Adivinar pronto da más puntos.',
  static_tunnel: 'Cámara fija con zoom telescópico que se aleja cada 5 s.',
  blur: 'La imagen empieza 100% borrosa y se aclara cada 5 s. Perfects seguidos suman racha.',
  static_blur: 'Cámara fija, borrosa al inicio y se aclara cada 5 s.',
  flashlight: 'Todo está a oscuras: explora con tu linterna, que gasta batería al moverla.',
  satellite: 'Foto satelital con zoom máximo, girada y sin brújula: 60% de la ciudad y 40% de rancherías, caminos y sierra.',
};

export function modeLabel(m) {
  return MODE_LABELS[m] || m || '—';
}

function fmtTime(ms) {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(ts, withTime = false) {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  const opts = { day: 'numeric', month: 'short', year: 'numeric' };
  if (withTime) Object.assign(opts, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString('es-MX', opts);
}

function fmtDay(date) {
  // 'YYYY-MM-DD' → «miércoles 12 de noviembre»
  const [y, m, d] = date.split('-').map(Number);
  const txt = new Date(y, m - 1, d).toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/* ============================== Arranque ============================== */

export function setup(appCtx) {
  ctx = appCtx;
  wireAuth();
  wireDaily();
  wireProfile();
  wireInstall();
  refreshSiteInfo();
  // Acceso directo «Reto diario» de la app instalada
  if (location.hash === '#reto') {
    setTimeout(() => {
      if (ctx.getName() && document.body.dataset.screen === 'menu') openDaily();
    }, 900);
  }
}

/* ======================= Aviso / mantenimiento ======================= */

export async function refreshSiteInfo() {
  const res = await secureApi.siteInfo();
  const el = $('#menuAnnouncement');
  if (!res || !res.ok || !el) return;
  const msg = res.maintenance ? `🛠️ ${res.maintenanceMsg}` : res.announcement;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
  el.classList.toggle('is-maintenance', !!res.maintenance);
  const daily = res.daily;
  const card = $('#dailyCardText');
  if (card && daily) card.textContent = `Hoy: ${modeLabel(daily.mode)} · 10 imágenes iguales para todos.`;
}

/* ===================== Inicio de sesión en otro equipo ===================== */

function wireAuth() {
  let method = 'password';
  document.querySelectorAll('#authTabs .auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('#authTabs .auth-tab').forEach((t) => t.classList.toggle('active', t === tab));
      const login = tab.dataset.tab === 'login';
      $('#authNew').classList.toggle('hidden', login);
      $('#authLogin').classList.toggle('hidden', !login);
      setTimeout(() => (login ? $('#loginNameInput') : $('#playerNameInput')).focus(), 30);
    });
  });
  document.querySelectorAll('#loginMethod .auth-method-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      method = btn.dataset.method;
      document.querySelectorAll('#loginMethod .auth-method-btn').forEach((b) => b.classList.toggle('active', b === btn));
      const input = $('#loginSecretInput');
      input.value = '';
      input.type = method === 'password' ? 'password' : 'text';
      input.placeholder = method === 'password' ? 'Contraseña' : 'Código (ej. ABCD-EFGH-JKLM)';
      input.autocomplete = method === 'password' ? 'current-password' : 'one-time-code';
    });
  });

  const doLogin = async () => {
    const name = $('#loginNameInput').value.trim();
    const secret = $('#loginSecretInput').value.trim();
    if (!name || !secret) {
      ctx.showToast('Escribe tu nombre y tu contraseña o código.', 'error');
      return;
    }
    const btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Verificando…';
    const res = await secureApi.accountLogin(name, method === 'password' ? { password: secret } : { code: secret });
    btn.disabled = false;
    btn.textContent = 'Iniciar sesión';
    if (!res || !res.ok) {
      ctx.showToast((res && res.error) || 'No se pudo iniciar sesión.', 'error', 4000);
      return;
    }
    ctx.onLoggedIn(res.name);
    if (res.usedCode) {
      ctx.showToast('¡Listo! Ese código ya se usó: genera uno nuevo en Mi perfil y guárdalo.', 'warning', 7000);
    } else {
      ctx.showToast(`¡Bienvenido de vuelta, ${res.name}!`, 'success');
    }
  };
  $('#loginBtn').addEventListener('click', doLogin);
  $('#loginSecretInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
}

/* ================================ Reto diario ================================ */

let dailyInfoCache = null;
let dailyCountdown = null;

function wireDaily() {
  $('#dailyBtn').addEventListener('click', () => openDaily());
  $('#dailyBackBtn').addEventListener('click', () => ctx.showScreen('menu'));
  $('#dailyPlayBtn').addEventListener('click', () => {
    if (!dailyInfoCache || dailyInfoCache.played) return;
    ctx.startDaily(dailyInfoCache);
  });
  $('#dailyDateSelect').addEventListener('change', (e) => loadDailyBoard(e.target.value));
}

export async function openDaily() {
  ctx.showScreen('daily');
  $('#dailyPlayBtn').disabled = true;
  const info = await secureApi.dailyInfo();
  if (!info || !info.ok) {
    $('#dailyDateText').textContent = (info && info.error) || 'No se pudo cargar el reto.';
    return;
  }
  dailyInfoCache = info;
  $('#dailyDateText').textContent = fmtDay(info.date);
  $('#dailyModeName').textContent = modeLabel(info.mode);
  $('#dailyModeDesc').textContent = MODE_DESCS[info.mode] || '';
  $('#dailyTimeText').textContent = `⏱️ ${fmtTime(info.timeMax * 1000)} en total`;
  $('#dailyPlayersText').textContent = `👥 ${info.players} ${info.players === 1 ? 'jugador' : 'jugadores'}`;
  const mine = $('#dailyMine');
  const btn = $('#dailyPlayBtn');
  if (info.played) {
    btn.disabled = true;
    btn.textContent = '✅ Ya jugaste el reto de hoy';
    mine.classList.remove('hidden');
    mine.innerHTML = info.mine
      ? `Tu resultado: <strong>#${info.mine.rank}</strong> · ${formatNumber(info.mine.score)} pts (${formatNumber(info.mine.points)} puntos · ${fmtTime(info.mine.timeMs)})`
      : 'Empezaste el reto de hoy pero no lo terminaste, así que no tiene puntaje.';
  } else {
    btn.disabled = false;
    btn.textContent = '▶️ Jugar reto de hoy';
    mine.classList.add('hidden');
  }
  startCountdown(info.nextInSec);
  loadDailyBoard(info.date, true);
}

function startCountdown(sec) {
  clearInterval(dailyCountdown);
  const el = $('#dailyNextText');
  let left = Number(sec) || 0;
  const tick = () => {
    const h = Math.floor(left / 3600);
    const m = Math.floor((left % 3600) / 60);
    const s = left % 60;
    el.textContent = `Nuevo reto en ${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s (hora de Tlaltenango)`;
    if (left-- <= 0) {
      clearInterval(dailyCountdown);
      el.textContent = '¡Ya hay un reto nuevo! Vuelve a abrir esta pantalla.';
    }
  };
  tick();
  dailyCountdown = setInterval(tick, 1000);
}

async function loadDailyBoard(date, fillDates = false) {
  const list = $('#dailyList');
  const empty = $('#dailyEmpty');
  list.innerHTML = '<p class="empty-hint">Cargando…</p>';
  empty.classList.add('hidden');
  const res = await secureApi.dailyLeaderboard(date);
  list.innerHTML = '';
  if (!res || !res.ok) {
    empty.textContent = 'No se pudo cargar la clasificación.';
    empty.classList.remove('hidden');
    return;
  }
  if (fillDates) {
    const sel = $('#dailyDateSelect');
    const dates = res.dates && res.dates.length ? res.dates : [res.date];
    if (!dates.includes(res.date)) dates.unshift(res.date);
    sel.innerHTML = dates.map((d) => `<option value="${d}">${d === dailyInfoCache?.date ? 'Hoy' : escapeHtml(d)}</option>`).join('');
    sel.value = res.date;
  }
  if (!res.entries.length) {
    empty.textContent = 'Nadie ha completado este reto todavía.';
    empty.classList.remove('hidden');
    return;
  }
  res.entries.forEach((e, i) => list.appendChild(ctx.buildLbRow(e, i, `${formatNumber(e.points)} pts · ${fmtTime(e.timeMs)} · ⭐ ${e.perfects || 0}`)));
}

/* ================================== Perfil ================================== */

function wireProfile() {
  $('#profileBtn').addEventListener('click', () => openProfile(ctx.getName(), true));
  $('#profileBackBtn').addEventListener('click', () => ctx.showScreen(profileReturnTo || 'menu'));

  $('#profilePwBtn').addEventListener('click', async () => {
    const pw = $('#profilePwInput').value;
    if (pw.length < 6) {
      ctx.showToast('La contraseña debe tener al menos 6 caracteres.', 'error');
      return;
    }
    const res = await secureApi.setPassword(pw);
    if (res && res.ok) {
      $('#profilePwInput').value = '';
      ctx.showToast('Contraseña guardada. Ya puedes entrar desde otro dispositivo.', 'success', 4500);
      loadAccount();
    } else {
      ctx.showToast((res && res.error) || 'No se pudo guardar la contraseña.', 'error');
    }
  });

  $('#profileCodeBtn').addEventListener('click', async () => {
    if (!confirm('Se generará un código nuevo y el anterior dejará de funcionar. ¿Continuar?')) return;
    const res = await secureApi.recoveryCode();
    const box = $('#profileCodeBox');
    if (!res || !res.ok) {
      ctx.showToast((res && res.error) || 'No se pudo generar el código.', 'error');
      return;
    }
    box.classList.remove('hidden');
    box.innerHTML = `
      <span class="recovery-label">Tu código de recuperación (sólo se muestra esta vez):</span>
      <code class="recovery-code">${escapeHtml(res.code)}</code>
      <button type="button" class="btn-ghost btn-copy-code">Copiar</button>
      <span class="recovery-hint">Guárdalo en un lugar seguro. Sirve una sola vez para entrar desde otro dispositivo.</span>`;
    box.querySelector('.btn-copy-code').addEventListener('click', () => {
      navigator.clipboard?.writeText(res.code).then(() => ctx.showToast('Código copiado', 'success'));
    });
    loadAccount();
  });

  $('#profileLogoutOthersBtn').addEventListener('click', async () => {
    if (!confirm('Se cerrará tu sesión en todos los demás celulares y PCs. ¿Continuar?')) return;
    const res = await secureApi.logoutOthers();
    ctx.showToast(res && res.ok ? 'Listo: sólo este dispositivo tiene acceso.' : 'No se pudo completar.', res && res.ok ? 'success' : 'error');
    loadAccount();
  });

  $('#profileLogoutBtn').addEventListener('click', async () => {
    const info = await secureApi.accountInfo();
    const safe = info && info.ok && (info.hasPassword || info.hasRecovery);
    const msg = safe
      ? '¿Cerrar sesión en este dispositivo? Podrás volver a entrar con tu contraseña o código.'
      : '⚠️ No tienes contraseña ni código de recuperación: si cierras sesión PERDERÁS esta cuenta. ¿Seguro?';
    if (!confirm(msg)) return;
    ctx.logout();
  });
}

let profileReturnTo = 'menu';

export async function openProfile(name, own = false, returnTo = null) {
  profileReturnTo = returnTo || (own ? 'menu' : 'leaderboard');
  ctx.showScreen('profile');
  $('#profileName').textContent = name || 'Perfil';
  $('#profileAvatar').textContent = (name || '?').trim().charAt(0).toUpperCase();
  $('#profileSince').textContent = 'Cargando…';
  $('#profileStats').innerHTML = '';
  $('#profileBest').innerHTML = '';
  $('#profileHistory').innerHTML = '';
  $('#profileCodeBox').classList.add('hidden');
  $('#profileAccount').classList.toggle('hidden', !own);

  const res = await secureApi.profile(name);
  if (!res || !res.ok) {
    $('#profileSince').textContent = (res && res.error) || 'No se pudo cargar el perfil.';
    return;
  }
  const st = res.stats;
  $('#profileName').textContent = res.name;
  $('#profileSince').textContent = `Jugador desde ${fmtDate(res.created)}${res.seen ? ' · Última vez ' + fmtDate(res.seen, true) : ''}`;

  const stat = (icon, label, value) => `<div class="pstat"><span class="pstat-icon">${icon}</span><span class="pstat-value">${value}</span><span class="pstat-label">${label}</span></div>`;
  $('#profileStats').innerHTML = [
    stat('🎮', 'Partidas', formatNumber(st.games)),
    stat('🎯', 'Prom. por ronda', formatNumber(st.avgPerRound)),
    stat('⭐', 'Perfects (≤25 m)', formatNumber(st.perfects)),
    stat('📏', 'Distancia media', st.avgKm != null ? formatKm(st.avgKm) : '—'),
    stat('📅', 'Retos diarios', formatNumber(st.dailyPlayed)),
    stat('🔥', 'Racha diaria', `${st.dailyStreak} ${st.dailyStreak === 1 ? 'día' : 'días'}`),
    stat('🏆', 'Mejor puesto diario', st.dailyBestRank ? `#${st.dailyBestRank}` : '—'),
    stat('👥', 'Multijugador', `${st.multiGames} (${st.multiWins} ganadas)`),
    stat('⏱️', 'Tiempo jugado', fmtTime(st.timePlayedMs)),
    stat('💙', 'Modo favorito', st.favoriteMode ? modeLabel(st.favoriteMode) : '—'),
  ].join('');

  const best = [...(st.best || [])].sort((a, b) => b.score - a.score);
  $('#profileBest').innerHTML = best.length
    ? best.map((b) => `<div class="pbest"><span class="pbest-mode">${b.daily ? '📅 Reto diario' : modeLabel(b.mode)} <small>${b.daily ? escapeHtml(b.daily) : b.rounds + ' rondas'}</small></span><span class="pbest-score">${formatNumber(b.score)} <small>pts</small></span></div>`).join('')
    : '<p class="empty-hint">Todavía no hay partidas en solitario.</p>';

  $('#profileHistory').innerHTML = res.recent.length
    ? res.recent.map((g) => {
      const tag = g.multi ? `<span class="ph-tag ph-multi">Multi · #${g.rank} de ${g.players}</span>`
        : g.daily ? `<span class="ph-tag ph-daily">Reto ${escapeHtml(g.daily)}${g.rank ? ' · #' + g.rank : ''}</span>`
          : `<span class="ph-tag">${g.rounds} rondas</span>`;
      const detail = g.multi
        ? `${formatNumber(g.score)} pts`
        : `${formatNumber(g.points)} pts · ${fmtTime(g.timeMs)}${g.perfects ? ` · ⭐ ${g.perfects}` : ''}${g.avgKm != null ? ` · ${formatKm(g.avgKm)} prom.` : ''}`;
      return `<div class="ph-row"><div class="ph-main"><span class="ph-mode">${modeLabel(g.mode)}</span>${tag}</div><div class="ph-detail">${detail}</div><div class="ph-date">${fmtDate(g.t, true)}</div></div>`;
    }).join('')
    : '<p class="empty-hint">Aún no hay partidas registradas.</p>';

  if (own) loadAccount();
}

async function loadAccount() {
  const info = await secureApi.accountInfo();
  const el = $('#profileAccountInfo');
  if (!info || !info.ok) {
    el.textContent = (info && info.error) || 'No se pudo cargar la información de la cuenta.';
    return;
  }
  const parts = [
    info.hasPassword ? '✅ Contraseña configurada' : '⚠️ Sin contraseña',
    info.hasRecovery ? '✅ Código de recuperación activo' : '⚠️ Sin código de recuperación',
    `📱 ${info.devices} ${info.devices === 1 ? 'dispositivo' : 'dispositivos'} con acceso`,
  ];
  el.innerHTML = parts.map((p) => `<span>${p}</span>`).join('') +
    (!info.hasPassword && !info.hasRecovery
      ? '<span class="account-warn">Configura una contraseña o un código: si cambias de celular o borras el navegador, es la única forma de recuperar tu nombre.</span>'
      : '');
}

/* ============================ App instalable (PWA) ============================ */

let deferredPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function wireInstall() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker no registrado:', e));
  }
  const btn = $('#installBtn');
  if (!btn || isStandalone()) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) btn.classList.remove('hidden');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    btn.classList.add('hidden');
    ctx.showToast('¡GG-TLALTE instalado! Ábrelo desde tu pantalla de inicio.', 'success', 5000);
  });
  btn.addEventListener('click', async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => null);
      deferredPrompt = null;
      return;
    }
    if (isIOS) {
      ctx.showToast('En iPhone/iPad: toca «Compartir» ⬆️ y luego «Agregar a pantalla de inicio».', 'info', 8000);
    } else {
      ctx.showToast('Abre el menú del navegador (⋮) y elige «Instalar app» o «Agregar a pantalla principal».', 'info', 8000);
    }
  });
}
