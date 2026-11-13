<?php
/**
 * GG-TLALTE · API del panel de administración (v1.0.0)
 *
 * - Inicio de sesión con usuario y contraseña (hash bcrypt en config/admin.php o data/admin.json).
 * - Sesión PHP con cookie HttpOnly + SameSite=Strict, caducidad por inactividad y token CSRF.
 * - Máximo 5 intentos fallidos cada 15 minutos por IP; todo queda en el registro de auditoría.
 */
define('GG_LIB_ONLY', true);
require __DIR__ . '/api.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: same-origin');

define('ADMIN_CONFIG', __DIR__ . '/config/admin.php');
define('ADMIN_OVERRIDE', DATA_DIR . '/admin.json');
define('ADMIN_AUDIT', DATA_DIR . '/admin-audit.log');
define('ADMIN_IDLE', 2 * 3600);

ensureDataDir();

$https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
session_name('GGADMIN');
session_set_cookie_params(['lifetime' => 0, 'path' => '/', 'secure' => $https, 'httponly' => true, 'samesite' => 'Strict']);
session_start();

$IN = $_GET;
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $raw = @file_get_contents('php://input', false, null, 0, 262144);
    $json = $raw ? json_decode($raw, true) : null;
    if (is_array($json)) $IN = array_merge($IN, $json);
}
$action = is_string($IN['action'] ?? null) ? $IN['action'] : '';

function adminCreds() {
    $o = loadJson(ADMIN_OVERRIDE, []);
    if (!empty($o['user']) && !empty($o['hash'])) return $o;
    if (file_exists(ADMIN_CONFIG)) {
        $c = include ADMIN_CONFIG;
        if (is_array($c) && !empty($c['user']) && !empty($c['hash'])) return $c;
    }
    return null;
}

function audit($msg) {
    $who = $_SESSION['admin'] ?? '-';
    if (file_exists(ADMIN_AUDIT) && filesize(ADMIN_AUDIT) > 524288) @rename(ADMIN_AUDIT, ADMIN_AUDIT . '.1');
    @file_put_contents(ADMIN_AUDIT, date('c') . " [$who @ " . clientIp() . "] $msg\n", FILE_APPEND);
}

function tailFile($file, $lines = 200) {
    if (!file_exists($file)) return [];
    $all = @file($file, FILE_IGNORE_NEW_LINES) ?: [];
    return array_reverse(array_slice($all, -$lines));
}

function requireAdmin() {
    if (empty($_SESSION['admin'])) fail('Sesión no iniciada.', 401);
    if (time() - intval($_SESSION['last'] ?? 0) > ADMIN_IDLE) {
        session_destroy();
        fail('La sesión caducó por inactividad.', 401);
    }
    $_SESSION['last'] = time();
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
        $csrf = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
        if (!is_string($csrf) || !hash_equals((string)($_SESSION['csrf'] ?? ''), $csrf)) fail('Token de seguridad inválido. Recarga el panel.', 403);
    }
}

function leaderboardKeys() {
    global $SOLO_MODES, $ROUND_OPTIONS;
    $keys = [];
    foreach ($SOLO_MODES as $m) foreach ($ROUND_OPTIONS as $r) $keys[] = $m . '_' . $r;
    return $keys;
}

function userSummary($k, $u) {
    return ['key' => $k, 'name' => $u['name'] ?? $k, 'created' => intval($u['t'] ?? 0), 'seen' => intval($u['seen'] ?? 0),
            'games' => intval($u['games'] ?? 0), 'devices' => count(userKeys($u)), 'hasPassword' => !empty($u['pw']),
            'hasRecovery' => !empty($u['rc']), 'banned' => !empty($u['banned']), 'bannedReason' => (string)($u['bannedReason'] ?? '')];
}

/** Borra a un jugador de todos los leaderboards y retos diarios. */
function purgeScores($name) {
    $k = nameKey($name);
    $removed = 0;
    withJson(LEADERBOARD_FILE, [], function (&$lb) use ($k, &$removed) {
        foreach ($lb as $cat => $entries) {
            $before = count($entries);
            $lb[$cat] = array_values(array_filter($entries, function ($e) use ($k) { return nameKey($e['name'] ?? '') !== $k; }));
            $removed += $before - count($lb[$cat]);
        }
        return [true, true];
    });
    foreach (glob(DAILY_DIR . '/*.json') ?: [] as $f) {
        withJson($f, ['attempts' => [], 'entries' => []], function (&$d) use ($k, &$removed) {
            $before = count($d['entries'] ?? []);
            $d['entries'] = array_values(array_filter($d['entries'] ?? [], function ($e) use ($k) { return nameKey($e['name']) !== $k; }));
            $removed += $before - count($d['entries']);
            return [true, $before !== count($d['entries'])];
        });
    }
    return $removed;
}

function saveSettings(array $patch) {
    return withJson(SETTINGS_FILE, [], function (&$s) use ($patch) {
        foreach ($patch as $k => $v) $s[$k] = $v;
        return [true, true];
    });
}

function dirSize($dir) {
    $n = 0; $bytes = 0;
    foreach (glob($dir . '/*') ?: [] as $f) { if (is_file($f)) { $n++; $bytes += filesize($f); } }
    return [$n, $bytes];
}

switch ($action) {
    case 'login': {
        rateLimit('adminlogin', 5, 900);
        $creds = adminCreds();
        if (!$creds) fail('El panel no está configurado (falta config/admin.php).', 500);
        $user = trim((string)($IN['user'] ?? ''));
        $pw = (string)($IN['password'] ?? '');
        usleep(300000);
        if (!hash_equals((string)$creds['user'], $user) || !password_verify($pw, (string)$creds['hash'])) {
            securityLog('panel admin: inicio de sesión fallido (usuario "' . substr($user, 0, 40) . '")');
            fail('Usuario o contraseña incorrectos.', 403);
        }
        session_regenerate_id(true);
        $_SESSION['admin'] = $creds['user'];
        $_SESSION['last'] = time();
        $_SESSION['csrf'] = bin2hex(random_bytes(24));
        audit('inicio de sesión');
        out(['ok' => true, 'user' => $creds['user'], 'csrf' => $_SESSION['csrf']]);
    }

    case 'me': {
        if (empty($_SESSION['admin']) || time() - intval($_SESSION['last'] ?? 0) > ADMIN_IDLE) out(['ok' => false, 'logged' => false]);
        $_SESSION['last'] = time();
        out(['ok' => true, 'logged' => true, 'user' => $_SESSION['admin'], 'csrf' => $_SESSION['csrf']]);
    }

    case 'logout': {
        requireAdmin();
        audit('cierre de sesión');
        session_destroy();
        out(['ok' => true]);
    }

    case 'change-password': {
        requireAdmin();
        $creds = adminCreds();
        $cur = (string)($IN['current'] ?? '');
        $new = (string)($IN['password'] ?? '');
        $newUser = trim((string)($IN['user'] ?? $creds['user']));
        if (!password_verify($cur, (string)$creds['hash'])) fail('La contraseña actual no es correcta.', 403);
        if (strlen($new) < 10) fail('La nueva contraseña debe tener al menos 10 caracteres.');
        if (!preg_match('/^[A-Za-z0-9_.\-]{3,32}$/', $newUser)) fail('Usuario no válido (3-32 caracteres: letras, números, _ . -).');
        saveJson(ADMIN_OVERRIDE, ['user' => $newUser, 'hash' => password_hash($new, PASSWORD_DEFAULT), 'changed' => time()]);
        $_SESSION['admin'] = $newUser;
        audit('cambió las credenciales del panel');
        out(['ok' => true]);
    }

    /* ------------------------------ Resumen ------------------------------ */
    case 'stats': {
        requireAdmin();
        $users = loadJson(USERS_FILE, []);
        $lb = loadJson(LEADERBOARD_FILE, []);
        $sessions = loadJson(SESSIONS_FILE, []);
        $rooms = loadJson(ROOMS_FILE, []);
        cleanupRooms($rooms);
        $now = time();
        $active = 0; $today = 0; $banned = 0;
        foreach ($users as $u) {
            if ($now - intval($u['seen'] ?? 0) < 86400) $active++;
            if (!empty($u['banned'])) $banned++;
        }
        $todayStart = (new DateTime('today', new DateTimeZone(DAILY_TZ)))->getTimestamp();
        $openSessions = 0;
        foreach ($sessions as $s) {
            if (intval($s['created'] ?? 0) >= $todayStart) $today++;
            if (empty($s['done']) && ($s['kind'] ?? '') === 'solo') $openSessions++;
        }
        $entries = 0;
        foreach ($lb as $cat) $entries += count($cat);
        $daily = dailyConfig(dailyDate());
        $d = loadJson(dailyFile(dailyDate()), ['attempts' => [], 'entries' => []]);
        list($poolN, $poolB) = dirSize(SATPOOL_DIR);
        $s = settings();
        out(['ok' => true, 'users' => count($users), 'activeUsers24h' => $active, 'banned' => $banned,
             'gamesToday' => $today, 'openSoloSessions' => $openSessions, 'rooms' => count($rooms),
             'roomsInProgress' => count(array_filter($rooms, function ($r) { return ($r['status'] ?? '') === 'in_progress'; })),
             'leaderboardEntries' => $entries, 'daily' => $daily + ['attempts' => count($d['attempts'] ?? []), 'finished' => count($d['entries'] ?? [])],
             'satPool' => ['images' => count(satPool()), 'files' => $poolN, 'bytes' => $poolB],
             'maintenance' => !empty($s['maintenance']), 'announcement' => (string)$s['announcement'],
             'php' => PHP_VERSION, 'gd' => function_exists('imagecreatetruecolor'), 'curl' => function_exists('curl_init'),
             'version' => loadJson(__DIR__ . '/version.json', ['version' => '?'])['version'] ?? '?',
             'serverTime' => date('c'), 'dailyDate' => dailyDate()]);
    }

    /* ------------------------------ Jugadores ------------------------------ */
    case 'users-list': {
        requireAdmin();
        $q = nameKey((string)($IN['q'] ?? ''));
        $filter = (string)($IN['filter'] ?? 'all');
        $sort = (string)($IN['sort'] ?? 'seen');
        $users = loadJson(USERS_FILE, []);
        $list = [];
        foreach ($users as $k => $u) {
            if ($q !== '' && strpos($k, $q) === false) continue;
            if ($filter === 'banned' && empty($u['banned'])) continue;
            if ($filter === 'nopass' && !empty($u['pw'])) continue;
            $list[] = userSummary($k, $u);
        }
        usort($list, function ($a, $b) use ($sort) {
            if ($sort === 'name') return strcmp($a['key'], $b['key']);
            if ($sort === 'games') return $b['games'] - $a['games'];
            if ($sort === 'created') return $b['created'] - $a['created'];
            return $b['seen'] - $a['seen'];
        });
        out(['ok' => true, 'total' => count($list), 'users' => array_slice($list, 0, 500)]);
    }

    case 'user-detail': {
        requireAdmin();
        $name = (string)($IN['name'] ?? '');
        $users = loadJson(USERS_FILE, []);
        $k = nameKey($name);
        if (!isset($users[$k])) fail('Jugador no encontrado.', 404);
        $h = loadJson(historyFile($users[$k]['name'] ?? $name), ['games' => []]);
        $lb = loadJson(LEADERBOARD_FILE, []);
        $scores = [];
        foreach ($lb as $cat => $entries) {
            foreach ($entries as $i => $e) {
                if (nameKey($e['name'] ?? '') === $k) $scores[] = ['category' => $cat, 'rank' => $i + 1] + $e;
            }
        }
        out(['ok' => true, 'user' => userSummary($k, $users[$k]), 'stats' => profileStats($h['games'] ?? []),
             'history' => array_reverse($h['games'] ?? []), 'scores' => $scores]);
    }

    case 'user-ban': {
        requireAdmin();
        $name = (string)($IN['name'] ?? '');
        $ban = !empty($IN['ban']);
        $reason = mb_substr(trim((string)($IN['reason'] ?? '')), 0, 200);
        $ok = withJson(USERS_FILE, [], function (&$users) use ($name, $ban, $reason) {
            $k = nameKey($name);
            if (!isset($users[$k])) return [false, false];
            if ($ban) { $users[$k]['banned'] = true; $users[$k]['bannedReason'] = $reason; $users[$k]['bannedAt'] = time(); }
            else { unset($users[$k]['banned'], $users[$k]['bannedReason'], $users[$k]['bannedAt']); }
            return [true, true];
        });
        if ($ok !== true) fail('Jugador no encontrado.', 404);
        $removed = ($ban && !empty($IN['purge'])) ? purgeScores($name) : 0;
        audit(($ban ? 'suspendió' : 'reactivó') . " a \"$name\"" . ($reason ? " ($reason)" : '') . ($removed ? " y borró $removed puntajes" : ''));
        out(['ok' => true, 'removed' => $removed]);
    }

    case 'user-reset-access': {
        // Para un jugador que perdió su dispositivo: borra sus dispositivos y genera un código nuevo.
        requireAdmin();
        $name = (string)($IN['name'] ?? '');
        $code = recoveryCode();
        $ok = withJson(USERS_FILE, [], function (&$users) use ($name, $code) {
            $k = nameKey($name);
            if (!isset($users[$k])) return [false, false];
            $users[$k]['keys'] = [];
            unset($users[$k]['kh']);
            $users[$k]['rc'] = password_hash(normalizeRecovery($code), PASSWORD_DEFAULT);
            return [true, true];
        });
        if ($ok !== true) fail('Jugador no encontrado.', 404);
        audit("restableció el acceso de \"$name\" (código de recuperación nuevo)");
        out(['ok' => true, 'code' => $code]);
    }

    case 'user-remove-password': {
        requireAdmin();
        $name = (string)($IN['name'] ?? '');
        withJson(USERS_FILE, [], function (&$users) use ($name) {
            $k = nameKey($name);
            if (!isset($users[$k])) return [false, false];
            unset($users[$k]['pw']);
            return [true, true];
        });
        audit("quitó la contraseña de \"$name\"");
        out(['ok' => true]);
    }

    case 'user-delete': {
        requireAdmin();
        $name = (string)($IN['name'] ?? '');
        $k = nameKey($name);
        $ok = withJson(USERS_FILE, [], function (&$users) use ($k) {
            if (!isset($users[$k])) return [false, false];
            unset($users[$k]);
            return [true, true];
        });
        if ($ok !== true) fail('Jugador no encontrado.', 404);
        $removed = purgeScores($name);
        @unlink(historyFile($name));
        audit("eliminó la cuenta \"$name\" ($removed puntajes)");
        out(['ok' => true, 'removed' => $removed]);
    }

    case 'user-purge-scores': {
        requireAdmin();
        $name = (string)($IN['name'] ?? '');
        $removed = purgeScores($name);
        audit("borró todos los puntajes de \"$name\" ($removed)");
        out(['ok' => true, 'removed' => $removed]);
    }

    /* ---------------------------- Leaderboards ---------------------------- */
    case 'leaderboard': {
        requireAdmin();
        $cat = (string)($IN['category'] ?? 'normal_5');
        $lb = loadJson(LEADERBOARD_FILE, []);
        $counts = [];
        foreach (leaderboardKeys() as $k) $counts[$k] = count($lb[$k] ?? []);
        out(['ok' => true, 'category' => $cat, 'entries' => $lb[$cat] ?? [], 'counts' => $counts]);
    }

    case 'leaderboard-delete': {
        requireAdmin();
        $cat = (string)($IN['category'] ?? '');
        $name = (string)($IN['name'] ?? '');
        $n = withJson(LEADERBOARD_FILE, [], function (&$lb) use ($cat, $name) {
            if (!isset($lb[$cat])) return [0, false];
            $before = count($lb[$cat]);
            $lb[$cat] = array_values(array_filter($lb[$cat], function ($e) use ($name) { return nameKey($e['name'] ?? '') !== nameKey($name); }));
            return [$before - count($lb[$cat]), true];
        });
        audit("borró el puntaje de \"$name\" en $cat");
        out(['ok' => true, 'removed' => $n]);
    }

    case 'leaderboard-reset': {
        requireAdmin();
        $cat = (string)($IN['category'] ?? '');
        if (($IN['confirm'] ?? '') !== 'BORRAR') fail('Escribe BORRAR para confirmar.');
        withJson(LEADERBOARD_FILE, [], function (&$lb) use ($cat) {
            if ($cat === '*') $lb = []; else unset($lb[$cat]);
            return [true, true];
        });
        audit($cat === '*' ? 'reinició TODOS los leaderboards' : "reinició el leaderboard $cat");
        out(['ok' => true]);
    }

    /* ----------------------------- Reto diario ----------------------------- */
    case 'daily-list': {
        requireAdmin();
        $out = [];
        foreach (glob(DAILY_DIR . '/*.json') ?: [] as $f) {
            $date = basename($f, '.json');
            $d = loadJson($f, ['attempts' => [], 'entries' => []]);
            $out[] = ['date' => $date, 'mode' => dailyConfig($date)['mode'], 'attempts' => count($d['attempts'] ?? []),
                      'finished' => count($d['entries'] ?? []), 'top' => $d['entries'][0]['name'] ?? null];
        }
        usort($out, function ($a, $b) { return strcmp($b['date'], $a['date']); });
        $upcoming = [];
        $dt = new DateTime(dailyDate(), new DateTimeZone(DAILY_TZ));
        for ($i = 0; $i < 7; $i++) {
            $date = $dt->format('Y-m-d');
            $upcoming[] = ['date' => $date, 'mode' => dailyConfig($date)['mode'], 'override' => settings()['dailyOverride'][$date] ?? null];
            $dt->modify('+1 day');
        }
        out(['ok' => true, 'days' => $out, 'upcoming' => $upcoming, 'today' => dailyDate()]);
    }

    case 'daily-get': {
        requireAdmin();
        $date = (string)($IN['date'] ?? dailyDate());
        if (!validDate($date)) fail('Fecha no válida.');
        $d = loadJson(dailyFile($date), ['attempts' => [], 'entries' => []]);
        $finished = [];
        foreach ($d['entries'] ?? [] as $e) $finished[nameKey($e['name'])] = true;
        $pending = [];
        foreach ($d['attempts'] ?? [] as $k => $a) if (!isset($finished[$k])) $pending[] = $a + ['key' => $k];
        out(['ok' => true, 'date' => $date, 'config' => dailyConfig($date), 'entries' => $d['entries'] ?? [], 'unfinished' => $pending]);
    }

    case 'daily-delete-entry': {
        requireAdmin();
        $date = (string)($IN['date'] ?? '');
        $name = (string)($IN['name'] ?? '');
        $allowRetry = !empty($IN['allowRetry']);
        if (!validDate($date)) fail('Fecha no válida.');
        withJson(dailyFile($date), ['attempts' => [], 'entries' => []], function (&$d) use ($name, $allowRetry) {
            $k = nameKey($name);
            $d['entries'] = array_values(array_filter($d['entries'] ?? [], function ($e) use ($k) { return nameKey($e['name']) !== $k; }));
            if ($allowRetry) unset($d['attempts'][$k]);
            return [true, true];
        });
        audit("reto $date: borró a \"$name\"" . ($allowRetry ? ' y le permitió reintentar' : ''));
        out(['ok' => true]);
    }

    case 'daily-set-mode': {
        requireAdmin();
        global $SOLO_MODES;
        $date = (string)($IN['date'] ?? '');
        $mode = (string)($IN['mode'] ?? '');
        if (!validDate($date)) fail('Fecha no válida.');
        $d = loadJson(dailyFile($date), ['attempts' => []]);
        if (!empty($d['attempts'])) fail('Ese reto ya tiene jugadores; no se puede cambiar el modo.');
        $over = settings()['dailyOverride'];
        if ($mode === '' || $mode === 'auto') unset($over[$date]);
        elseif (in_array($mode, ['normal', 'satellite', 'static', 'blur', 'temporal', 'flashlight', 'tunnel', 'static_blur', 'static_tunnel'], true)) $over[$date] = $mode;
        else fail('Modo no válido.');
        saveSettings(['dailyOverride' => $over]);
        audit("reto $date: modo fijado en " . ($mode ?: 'automático'));
        out(['ok' => true]);
    }

    /* ------------------------------- Salas ------------------------------- */
    case 'rooms': {
        requireAdmin();
        $rooms = loadJson(ROOMS_FILE, []);
        cleanupRooms($rooms);
        $list = [];
        foreach ($rooms as $id => $r) {
            $list[] = ['id' => $id] + publicRoom($r) + ['isPublic' => intval($r['isPublic'] ?? 1), 'updated' => intval($r['updated'] ?? 0),
                                                       'messages' => count($r['messages'] ?? [])];
        }
        out(['ok' => true, 'rooms' => $list]);
    }

    case 'room-close': {
        requireAdmin();
        $id = roomId($IN['id'] ?? '');
        withJson(ROOMS_FILE, [], function (&$rooms) use ($id) {
            if (!isset($rooms[$id])) return [true, false];
            unset($rooms[$id]);
            return [true, true];
        });
        audit("cerró la sala $id");
        out(['ok' => true]);
    }

    /* ------------------------------ Sesiones ------------------------------ */
    case 'sessions': {
        requireAdmin();
        $all = loadJson(SESSIONS_FILE, []);
        $list = [];
        foreach ($all as $t => $s) {
            $sus = 0;
            foreach ($s['guesses'] ?? [] as $g) if (!empty($g['sus'])) $sus++;
            $list[] = ['token' => substr($t, 0, 8), 'kind' => $s['kind'] ?? '', 'name' => $s['name'] ?? ($s['host'] ?? ''),
                       'mode' => $s['mode'] ?? '', 'rounds' => intval($s['rounds'] ?? 0), 'daily' => $s['daily'] ?? null,
                       'round' => intval($s['cur'] ?? 0), 'total' => intval($s['total'] ?? 0), 'done' => !empty($s['done']),
                       'created' => intval($s['created'] ?? 0), 'suspicious' => $sus, 'ip' => $s['ip'] ?? '',
                       'players' => $s['players'] ?? null];
        }
        usort($list, function ($a, $b) { return $b['created'] - $a['created']; });
        out(['ok' => true, 'sessions' => array_slice($list, 0, 300)]);
    }

    /* ------------------------------ Ajustes ------------------------------ */
    case 'settings-get': {
        requireAdmin();
        out(['ok' => true, 'settings' => settings()]);
    }

    case 'settings-set': {
        requireAdmin();
        $patch = [];
        if (array_key_exists('maintenance', $IN)) $patch['maintenance'] = !empty($IN['maintenance']);
        if (array_key_exists('maintenanceMsg', $IN)) $patch['maintenanceMsg'] = mb_substr(trim((string)$IN['maintenanceMsg']), 0, 300);
        if (array_key_exists('announcement', $IN)) $patch['announcement'] = mb_substr(trim((string)$IN['announcement']), 0, 300);
        saveSettings($patch);
        audit('actualizó ajustes: ' . implode(', ', array_keys($patch)));
        out(['ok' => true]);
    }

    /* ------------------------------ Registros ------------------------------ */
    case 'logs': {
        requireAdmin();
        out(['ok' => true, 'audit' => tailFile(ADMIN_AUDIT), 'security' => tailFile(DATA_DIR . '/security.log'),
             'satellite' => tailFile(SAT_LOG_FILE)]);
    }

    /* ------------------------------ Respaldo ------------------------------ */
    case 'export': {
        requireAdmin();
        $users = [];
        foreach (loadJson(USERS_FILE, []) as $k => $u) $users[] = userSummary($k, $u);
        $daily = [];
        foreach (glob(DAILY_DIR . '/*.json') ?: [] as $f) $daily[basename($f, '.json')] = loadJson($f, [])['entries'] ?? [];
        audit('descargó un respaldo');
        header('Content-Disposition: attachment; filename="gg-tlalte-respaldo-' . date('Y-m-d') . '.json"');
        out(['ok' => true, 'exported' => date('c'), 'users' => $users, 'leaderboard' => loadJson(LEADERBOARD_FILE, []),
             'daily' => $daily, 'settings' => settings()]);
    }

    default:
        fail('acción no válida', 404);
}
