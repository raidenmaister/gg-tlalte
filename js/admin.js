// ============================================================================
// admin.js — Panel de administración de GG-TLALTE (v1.0.0)
// ============================================================================
(() => {
  'use strict';

  const API = 'admin-api.php';
  const MODES = {
    normal: '🎮 Normal', static: '🛑 Estático', temporal: '⏱️ Temporal', tunnel: '🔍 Normal + Zoom',
    static_tunnel: '🔍 Estático + Zoom', blur: '🌫️ Normal Borroso', static_blur: '🌫️ Estático Borroso',
    flashlight: '🔦 Linterna', satellite: '🛰️ Ojo de Halcón', race: '🏁 Carrera',
  };
  const DAILY_MODES = ['normal', 'satellite', 'static', 'blur', 'temporal', 'flashlight', 'tunnel', 'static_blur', 'static_tunnel'];
  let csrf = '';
  let currentTab = 'dashboard';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => Number(n || 0).toLocaleString('es-MX');
  const mode = (m) => MODES[m] || esc(m || '—');
  const dt = (ts) => (ts ? new Date(ts * 1000).toLocaleString('es-MX', { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  const ago = (ts) => {
    if (!ts) return '—';
    const s = Math.floor(Date.now() / 1000 - ts);
    if (s < 60) return 'hace un momento';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    return `hace ${Math.floor(s / 86400)} d`;
  };
  const time = (ms) => {
    if (!ms) return '—';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const bytes = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

  let toastT = null;
  function toast(msg, kind = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = `show ${kind}`;
    clearTimeout(toastT);
    toastT = setTimeout(() => (t.className = ''), 3500);
  }

  async function api(action, body = null) {
    const opts = { credentials: 'same-origin', cache: 'no-store', headers: {} };
    if (body) {
      opts.method = 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['X-CSRF-Token'] = csrf;
      opts.body = JSON.stringify({ action, ...body });
    }
    let res;
    try {
      res = await fetch(body ? API : `${API}?action=${encodeURIComponent(action)}&_t=${Date.now()}`, opts);
    } catch (e) {
      throw new Error('Sin conexión con el servidor');
    }
    const json = await res.json().catch(() => ({ ok: false, error: `Respuesta inválida (${res.status})` }));
    if (res.status === 401) {
      showLogin(json.error);
      throw new Error(json.error || 'Sesión no iniciada');
    }
    if (!json.ok && json.logged !== false) throw new Error(json.error || 'Error');
    return json;
  }
  const post = (action, body = {}) => api(action, body);

  async function guard(fn) {
    try {
      await fn();
    } catch (e) {
      if (!/Sesión/.test(e.message)) toast(e.message, 'error');
    }
  }

  /* ------------------------------ Sesión ------------------------------ */
  function showLogin(msg) {
    $('#appView').classList.add('hidden');
    $('#loginView').classList.remove('hidden');
    if (msg) toast(msg, 'error');
  }

  function showApp(user) {
    $('#whoami').textContent = user;
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    openTab(currentTab);
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#lBtn').disabled = true;
    try {
      const r = await post('login', { user: $('#lUser').value.trim(), password: $('#lPass').value });
      csrf = r.csrf;
      $('#lPass').value = '';
      showApp(r.user);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      $('#lBtn').disabled = false;
    }
  });

  $('#logoutBtn').addEventListener('click', () => guard(async () => {
    await post('logout');
    csrf = '';
    showLogin();
  }));

  /* ------------------------------ Navegación ------------------------------ */
  $$('.nav-btn').forEach((b) => b.addEventListener('click', () => {
    openTab(b.dataset.tab);
    $('#side').classList.remove('open');
  }));
  $('#menuToggle').addEventListener('click', () => $('#side').classList.toggle('open'));
  $('#refreshBtn').addEventListener('click', () => openTab(currentTab));

  const LOADERS = {
    dashboard: loadDashboard, users: loadUsers, leaderboards: loadLeaderboard, daily: loadDaily,
    rooms: loadRooms, sessions: loadSessions, settings: loadSettings, logs: loadLogs, security: () => {},
  };

  function openTab(tab) {
    currentTab = tab;
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
    $('#tabTitle').textContent = $(`.nav-btn[data-tab="${tab}"]`).textContent.replace(/^\S+\s/, '');
    guard(LOADERS[tab]);
  }

  /* ------------------------------ Resumen ------------------------------ */
  async function loadDashboard() {
    const s = await api('stats');
    const k = (l, v, sub = '') => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
    $('#kpis').innerHTML = [
      k('Jugadores registrados', num(s.users), `${num(s.activeUsers24h)} activos en 24 h · ${num(s.banned)} suspendidos`),
      k('Partidas hoy', num(s.gamesToday), `${num(s.openSoloSessions)} sin terminar`),
      k('Salas activas', num(s.rooms), `${num(s.roomsInProgress)} en partida`),
      k('Puntajes en leaderboards', num(s.leaderboardEntries)),
      k('Reto diario de hoy', mode(s.daily.mode), `${num(s.daily.attempts)} empezaron · ${num(s.daily.finished)} terminaron`),
      k('Banco satelital', num(s.satPool.images), `${bytes(s.satPool.bytes)} en el servidor`),
    ].join('');
    $('#siteState').innerHTML = `
      <div class="actions" style="margin-bottom:8px">
        <span class="tag ${s.maintenance ? 'tag-amber' : 'tag-green'}">${s.maintenance ? '🛠️ En mantenimiento' : '✅ Abierto'}</span>
        <span class="tag">Versión ${esc(s.version)}</span>
        <span class="tag">PHP ${esc(s.php)}</span>
        <span class="tag ${s.gd ? 'tag-green' : 'tag-red'}">GD ${s.gd ? 'sí' : 'no'}</span>
        <span class="tag ${s.curl ? 'tag-green' : 'tag-red'}">cURL ${s.curl ? 'sí' : 'no'}</span>
      </div>
      <div>Aviso actual: ${s.announcement ? `<em>${esc(s.announcement)}</em>` : '<span class="muted">ninguno</span>'}</div>
      <div class="muted" style="margin-top:6px">Hora del servidor: ${esc(s.serverTime)} · Fecha del reto: ${esc(s.dailyDate)}</div>`;
  }

  /* ------------------------------ Jugadores ------------------------------ */
  async function loadUsers() {
    const r = await post('users-list', { q: $('#uSearch').value.trim(), filter: $('#uFilter').value, sort: $('#uSort').value });
    $('#uCount').textContent = `${num(r.total)} jugadores${r.total > r.users.length ? ` (mostrando ${r.users.length})` : ''}`;
    $('#uBody').innerHTML = r.users.length ? r.users.map((u) => `
      <tr>
        <td><strong>${esc(u.name)}</strong></td>
        <td>${u.banned ? `<span class="tag tag-red" title="${esc(u.bannedReason)}">Suspendido</span>` : '<span class="tag tag-green">Activo</span>'}
            ${u.hasPassword ? '<span class="tag tag-blue">🔑</span>' : ''}${u.hasRecovery ? '<span class="tag tag-blue">🧾</span>' : ''}</td>
        <td class="num">${num(u.games)}</td>
        <td>${u.devices}</td>
        <td>${dt(u.created)}</td>
        <td>${ago(u.seen)}</td>
        <td><button class="btn btn-sm" data-open="${esc(u.name)}">Ver ficha</button></td>
      </tr>`).join('') : '<tr><td colspan="7" class="empty">Sin resultados</td></tr>';
    $$('[data-open]', $('#uBody')).forEach((b) => b.addEventListener('click', () => guard(() => openUser(b.dataset.open))));
  }
  $('#uSearchBtn').addEventListener('click', () => guard(loadUsers));
  $('#uSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') guard(loadUsers); });
  $('#uFilter').addEventListener('change', () => guard(loadUsers));
  $('#uSort').addEventListener('change', () => guard(loadUsers));

  async function openUser(name) {
    const r = await post('user-detail', { name });
    const u = r.user;
    const st = r.stats;
    $('#umTitle').textContent = `👤 ${u.name}`;
    $('#umBody').innerHTML = `
      <div class="grid" style="margin-bottom:14px">
        <div class="kpi"><div class="l">Estado</div><div class="v" style="font-size:1.1rem">${u.banned ? '⛔ Suspendido' : '✅ Activo'}</div><div class="s">${esc(u.bannedReason)}</div></div>
        <div class="kpi"><div class="l">Partidas</div><div class="v">${num(st.games)}</div><div class="s">${num(st.soloGames)} solo · ${num(st.multiGames)} multi</div></div>
        <div class="kpi"><div class="l">Promedio por ronda</div><div class="v">${num(st.avgPerRound)}</div><div class="s">${num(st.perfects)} perfects</div></div>
        <div class="kpi"><div class="l">Acceso</div><div class="v" style="font-size:1.1rem">${u.devices} disp.</div><div class="s">${u.hasPassword ? 'Con contraseña' : 'Sin contraseña'} · ${u.hasRecovery ? 'con código' : 'sin código'}</div></div>
        <div class="kpi"><div class="l">Registrado / visto</div><div class="v" style="font-size:1rem">${dt(u.created)}</div><div class="s">${ago(u.seen)}</div></div>
        <div class="kpi"><div class="l">Retos diarios</div><div class="v">${num(st.dailyPlayed)}</div><div class="s">Racha ${st.dailyStreak} · mejor #${st.dailyBestRank || '—'}</div></div>
      </div>
      <div class="actions" style="margin-bottom:14px">
        ${u.banned ? '<button class="btn" data-act="unban">Reactivar cuenta</button>' : '<button class="btn btn-danger" data-act="ban">Suspender…</button>'}
        <button class="btn" data-act="reset">Restablecer acceso (código nuevo)</button>
        ${u.hasPassword ? '<button class="btn" data-act="nopw">Quitar contraseña</button>' : ''}
        <button class="btn btn-danger" data-act="purge">Borrar sus puntajes</button>
        <button class="btn btn-danger" data-act="delete">Eliminar cuenta</button>
      </div>
      <div id="umCode"></div>
      <h3 style="margin:10px 0 8px">Puntajes en leaderboards (${r.scores.length})</h3>
      <div class="table-wrap"><table><thead><tr><th>Categoría</th><th class="num">#</th><th class="num">Puntaje</th><th class="num">Puntos</th><th>Fecha</th><th></th></tr></thead><tbody>
        ${r.scores.length ? r.scores.map((e) => `<tr><td>${esc(e.category)}</td><td class="num">${e.rank}</td><td class="num">${num(e.score)}</td><td class="num">${num(e.points)}</td><td>${dt(e.date)}</td>
          <td><button class="btn btn-sm btn-danger" data-delscore="${esc(e.category)}">Borrar</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">Sin puntajes</td></tr>'}
      </tbody></table></div>
      <h3 style="margin:16px 0 8px">Historial (${r.history.length})</h3>
      <div class="table-wrap" style="max-height:320px"><table><thead><tr><th>Fecha</th><th>Modo</th><th>Tipo</th><th class="num">Puntos</th><th class="num">Puntaje</th><th class="num">Tiempo</th><th class="num">Perfects</th></tr></thead><tbody>
        ${r.history.length ? r.history.map((g) => `<tr><td>${dt(g.t)}</td><td>${mode(g.mode)}</td>
          <td>${g.multi ? `<span class="tag">Multi #${g.rank}/${g.players}</span>` : g.daily ? `<span class="tag tag-amber">Reto ${esc(g.daily)}${g.rank ? ' #' + g.rank : ''}</span>` : `<span class="tag">${g.rounds} rondas</span>`}</td>
          <td class="num">${g.multi ? '—' : num(g.points)}</td><td class="num">${num(g.score)}</td><td class="num">${g.multi ? '—' : time(g.timeMs)}</td><td class="num">${g.perfects ?? '—'}</td></tr>`).join('') : '<tr><td colspan="7" class="empty">Sin partidas</td></tr>'}
      </tbody></table></div>`;
    $('#userModal').classList.remove('hidden');

    const act = (a, fn) => { const b = $(`[data-act="${a}"]`, $('#umBody')); if (b) b.addEventListener('click', () => guard(fn)); };
    act('ban', async () => {
      const reason = prompt(`Motivo de la suspensión de «${u.name}» (lo verás en el panel):`, 'Trampas en el leaderboard');
      if (reason === null) return;
      const purge = confirm('¿Borrar también todos sus puntajes de los leaderboards y retos?');
      const res = await post('user-ban', { name: u.name, ban: true, reason, purge });
      toast(`Cuenta suspendida${res.removed ? ` · ${res.removed} puntajes borrados` : ''}`, 'success');
      openUser(u.name); loadUsers();
    });
    act('unban', async () => { await post('user-ban', { name: u.name, ban: false }); toast('Cuenta reactivada', 'success'); openUser(u.name); loadUsers(); });
    act('reset', async () => {
      if (!confirm(`Se cerrará la sesión de «${u.name}» en todos sus dispositivos y se generará un código de recuperación nuevo para dárselo. ¿Continuar?`)) return;
      const res = await post('user-reset-access', { name: u.name });
      $('#umCode').innerHTML = `<p class="muted" style="margin-bottom:6px">Entrégale este código al jugador (sirve una vez, en «Ya tengo cuenta»):</p><div class="code-box">${esc(res.code)}</div><br>`;
    });
    act('nopw', async () => { if (!confirm('¿Quitar la contraseña de este jugador?')) return; await post('user-remove-password', { name: u.name }); toast('Contraseña eliminada', 'success'); openUser(u.name); });
    act('purge', async () => { if (!confirm(`¿Borrar TODOS los puntajes de «${u.name}»?`)) return; const res = await post('user-purge-scores', { name: u.name }); toast(`${res.removed} puntajes borrados`, 'success'); openUser(u.name); });
    act('delete', async () => {
      if (prompt(`Para eliminar la cuenta escribe su nombre exacto: ${u.name}`) !== u.name) return;
      const res = await post('user-delete', { name: u.name });
      toast(`Cuenta eliminada (${res.removed} puntajes)`, 'success');
      $('#userModal').classList.add('hidden'); loadUsers();
    });
    $$('[data-delscore]', $('#umBody')).forEach((b) => b.addEventListener('click', () => guard(async () => {
      await post('leaderboard-delete', { category: b.dataset.delscore, name: u.name });
      toast('Puntaje borrado', 'success'); openUser(u.name);
    })));
  }
  $('#umClose').addEventListener('click', () => $('#userModal').classList.add('hidden'));
  $('#userModal').addEventListener('click', (e) => { if (e.target.id === 'userModal') $('#userModal').classList.add('hidden'); });

  /* ------------------------------ Leaderboards ------------------------------ */
  $('#lbMode').innerHTML = ['normal', 'tunnel', 'blur', 'flashlight', 'static', 'static_tunnel', 'static_blur', 'temporal', 'satellite']
    .map((m) => `<option value="${m}">${MODES[m]}</option>`).join('');
  async function loadLeaderboard() {
    const cat = `${$('#lbMode').value}_${$('#lbRounds').value}`;
    const r = await post('leaderboard', { category: cat });
    $('#lbBody').innerHTML = r.entries.length ? r.entries.map((e, i) => `
      <tr><td>${i + 1}</td><td><a href="#" data-user="${esc(e.name)}">${esc(e.name)}</a></td><td class="num"><strong>${num(e.score)}</strong></td><td class="num">${num(e.points)}</td>
      <td class="num">${time(e.timeMs)}</td><td class="num">${num(e.games || 1)}</td><td>${dt(e.date)}</td>
      <td><button class="btn btn-sm btn-danger" data-del="${esc(e.name)}">Borrar</button></td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">Sin puntajes en esta categoría</td></tr>';
    $$('[data-del]', $('#lbBody')).forEach((b) => b.addEventListener('click', () => guard(async () => {
      if (!confirm(`¿Borrar el puntaje de «${b.dataset.del}» en ${cat}?`)) return;
      await post('leaderboard-delete', { category: cat, name: b.dataset.del });
      toast('Puntaje borrado', 'success'); loadLeaderboard();
    })));
    $$('[data-user]', $('#lbBody')).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); guard(() => openUser(a.dataset.user)); }));
  }
  $('#lbLoad').addEventListener('click', () => guard(loadLeaderboard));
  $('#lbMode').addEventListener('change', () => guard(loadLeaderboard));
  $('#lbRounds').addEventListener('change', () => guard(loadLeaderboard));
  $('#lbReset').addEventListener('click', () => guard(async () => {
    const cat = `${$('#lbMode').value}_${$('#lbRounds').value}`;
    const c = prompt(`Se borrarán TODOS los puntajes de ${cat}. Escribe BORRAR para confirmar:`);
    if (c !== 'BORRAR') return;
    await post('leaderboard-reset', { category: cat, confirm: c });
    toast('Categoría reiniciada', 'success'); loadLeaderboard();
  }));
  $('#lbResetAll').addEventListener('click', () => guard(async () => {
    const c = prompt('Se borrarán TODOS los leaderboards de todos los modos. Escribe BORRAR para confirmar:');
    if (c !== 'BORRAR') return;
    await post('leaderboard-reset', { category: '*', confirm: c });
    toast('Todos los leaderboards reiniciados', 'success'); loadLeaderboard();
  }));

  /* ------------------------------ Reto diario ------------------------------ */
  async function loadDaily() {
    const r = await post('daily-list', {});
    $('#dUpcoming').innerHTML = r.upcoming.map((d) => `
      <tr><td>${esc(d.date)}${d.date === r.today ? ' <span class="tag tag-amber">hoy</span>' : ''}</td><td>${mode(d.mode)}${d.override ? ' <span class="tag tag-blue">fijado</span>' : ''}</td>
      <td><div class="actions"><select data-date="${esc(d.date)}" style="max-width:220px"><option value="auto">Automático</option>${DAILY_MODES.map((m) => `<option value="${m}" ${d.override === m ? 'selected' : ''}>${MODES[m]}</option>`).join('')}</select>
      <button class="btn btn-sm" data-setmode="${esc(d.date)}">Aplicar</button></div></td></tr>`).join('');
    $$('[data-setmode]', $('#dUpcoming')).forEach((b) => b.addEventListener('click', () => guard(async () => {
      const sel = $(`select[data-date="${b.dataset.setmode}"]`, $('#dUpcoming'));
      await post('daily-set-mode', { date: b.dataset.setmode, mode: sel.value });
      toast('Modo del reto actualizado', 'success'); loadDaily();
    })));
    $('#dDays').innerHTML = r.days.length ? r.days.map((d) => `
      <tr><td>${esc(d.date)}</td><td>${mode(d.mode)}</td><td class="num">${num(d.attempts)}</td><td class="num">${num(d.finished)}</td><td>${esc(d.top || '—')}</td>
      <td><button class="btn btn-sm" data-day="${esc(d.date)}">Ver clasificación</button></td></tr>`).join('')
      : '<tr><td colspan="6" class="empty">Todavía nadie ha jugado un reto diario</td></tr>';
    $$('[data-day]', $('#dDays')).forEach((b) => b.addEventListener('click', () => guard(() => openDay(b.dataset.day))));
  }

  async function openDay(date) {
    const r = await post('daily-get', { date });
    $('#dDetailCard').classList.remove('hidden');
    $('#dDetailTitle').textContent = `Reto del ${date} · ${MODES[r.config.mode] || r.config.mode}`;
    $('#dDetailBody').innerHTML = r.entries.length ? r.entries.map((e, i) => `
      <tr><td>${i + 1}</td><td>${esc(e.name)}</td><td class="num"><strong>${num(e.score)}</strong></td><td class="num">${num(e.points)}</td><td class="num">${time(e.timeMs)}</td><td class="num">${e.perfects || 0}</td>
      <td class="actions"><button class="btn btn-sm btn-danger" data-dd="${esc(e.name)}">Borrar</button><button class="btn btn-sm" data-dr="${esc(e.name)}">Borrar y dejar reintentar</button></td></tr>`).join('')
      : '<tr><td colspan="7" class="empty">Nadie terminó este reto</td></tr>';
    $('#dUnfinished').innerHTML = r.unfinished.length
      ? `Empezaron sin terminar (${r.unfinished.length}): ${r.unfinished.map((a) => `${esc(a.name)} <button class="btn btn-sm" data-dr="${esc(a.name)}">permitir reintento</button>`).join(' ')}`
      : '';
    const handler = (allowRetry) => (b) => b.addEventListener('click', () => guard(async () => {
      const name = allowRetry ? b.dataset.dr : b.dataset.dd;
      if (!confirm(allowRetry ? `¿Borrar a «${name}» y permitirle jugar de nuevo el reto del ${date}?` : `¿Borrar a «${name}» de la clasificación del ${date}?`)) return;
      await post('daily-delete-entry', { date, name, allowRetry });
      toast('Listo', 'success'); openDay(date); loadDaily();
    }));
    $$('[data-dd]', $('#dDetailCard')).forEach(handler(false));
    $$('[data-dr]', $('#dDetailCard')).forEach(handler(true));
  }

  /* ------------------------------ Salas ------------------------------ */
  async function loadRooms() {
    const r = await api('rooms');
    $('#rBody').innerHTML = r.rooms.length ? r.rooms.map((x) => `
      <tr><td><code>${esc(x.id)}</code></td><td>${esc(x.name)}</td><td>${mode(x.gameMode)}</td>
      <td><span class="tag ${x.status === 'in_progress' ? 'tag-amber' : 'tag-green'}">${x.status === 'in_progress' ? 'En partida' : x.status === 'finished' ? 'Terminada' : 'Esperando'}</span></td>
      <td class="num">${x.count}/${x.limit}</td><td>${x.isPublic ? 'Pública' : 'Privada'}</td><td>${ago(x.updated)}</td>
      <td><button class="btn btn-sm btn-danger" data-close="${esc(x.id)}">Cerrar</button></td></tr>`).join('')
      : '<tr><td colspan="8" class="empty">No hay salas activas</td></tr>';
    $$('[data-close]', $('#rBody')).forEach((b) => b.addEventListener('click', () => guard(async () => {
      if (!confirm('¿Cerrar esta sala? Desaparecerá de la lista pública.')) return;
      await post('room-close', { id: b.dataset.close });
      toast('Sala cerrada', 'success'); loadRooms();
    })));
  }

  /* ------------------------------ Partidas ------------------------------ */
  async function loadSessions() {
    const r = await api('sessions');
    const onlySus = $('#sOnlySus').checked;
    const list = r.sessions.filter((s) => !onlySus || s.suspicious > 0);
    $('#sBody').innerHTML = list.length ? list.map((s) => `
      <tr><td>${dt(s.created)}</td><td>${s.kind === 'room' ? 'Sala satelital' : s.daily ? '<span class="tag tag-amber">Reto diario</span>' : 'Solitario'}</td>
      <td>${s.kind === 'room' ? esc((s.players || []).join(', ')) : `<a href="#" data-user="${esc(s.name)}">${esc(s.name)}</a>`}</td>
      <td>${mode(s.mode)}</td><td class="num">${s.kind === 'solo' ? `${Math.min(s.round, s.rounds)}/${s.rounds}` : s.rounds}</td><td class="num">${num(s.total)}</td>
      <td>${s.done ? '<span class="tag tag-green">Terminada</span>' : '<span class="tag">En curso / abandonada</span>'}</td>
      <td>${s.suspicious ? `<span class="tag tag-red">⚠️ ${s.suspicious}</span>` : '—'}</td><td class="muted">${esc(s.ip)}</td></tr>`).join('')
      : '<tr><td colspan="9" class="empty">Sin partidas en las últimas 3 horas</td></tr>';
    $$('[data-user]', $('#sBody')).forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); guard(() => openUser(a.dataset.user)); }));
  }
  $('#sOnlySus').addEventListener('change', () => guard(loadSessions));

  /* ------------------------------ Ajustes ------------------------------ */
  async function loadSettings() {
    const r = await api('settings-get');
    $('#annText').value = r.settings.announcement || '';
    $('#mntOn').checked = !!r.settings.maintenance;
    $('#mntMsg').value = r.settings.maintenanceMsg || '';
  }
  $('#annSave').addEventListener('click', () => guard(async () => {
    await post('settings-set', { announcement: $('#annText').value });
    toast('Aviso guardado', 'success');
  }));
  $('#mntSave').addEventListener('click', () => guard(async () => {
    if ($('#mntOn').checked && !confirm('¿Activar el modo mantenimiento? Nadie podrá empezar partidas nuevas.')) return;
    await post('settings-set', { maintenance: $('#mntOn').checked, maintenanceMsg: $('#mntMsg').value });
    toast('Ajustes guardados', 'success');
  }));

  /* ------------------------------ Registros ------------------------------ */
  async function loadLogs() {
    const r = await api('logs');
    const show = (id, lines) => ($(id).textContent = lines.length ? lines.join('\n') : 'Sin registros.');
    show('#logSecurity', r.security);
    show('#logAudit', r.audit);
    show('#logSat', r.satellite);
  }

  /* ------------------------------ Seguridad ------------------------------ */
  $('#pwSave').addEventListener('click', () => guard(async () => {
    await post('change-password', { current: $('#pwCur').value, user: $('#pwUser').value.trim() || $('#whoami').textContent, password: $('#pwNew').value });
    $('#pwCur').value = '';
    $('#pwNew').value = '';
    toast('Credenciales actualizadas', 'success');
  }));
  $('#exportBtn').addEventListener('click', () => guard(async () => {
    const r = await post('export', {});
    const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gg-tlalte-respaldo-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }));

  /* ------------------------------ Inicio ------------------------------ */
  (async () => {
    try {
      const r = await api('me');
      if (r.logged) {
        csrf = r.csrf;
        showApp(r.user);
        return;
      }
    } catch (e) {}
    showLogin();
  })();
})();
