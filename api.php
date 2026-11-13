<?php
/**
 * GG-TLALTE · Backend PHP (v1.0.0)
 *
 * Seguridad:
 *  - Los datos persistentes viven en data/ (bloqueado por .htaccess) y nunca son descargables.
 *  - Cada jugador tiene una clave secreta (generada en su navegador) ligada a su nombre.
 *  - Las partidas en solitario son sesiones del servidor: el servidor elige las ubicaciones,
 *    entrega una ronda a la vez, calcula distancia, puntos y tiempo. El cliente ya no puede
 *    enviar un puntaje arbitrario al leaderboard.
 *  - Modo «Ojo de Halcón»: las coordenadas nunca salen del servidor antes de que el jugador
 *    fije su chincheta; la imagen satelital se compone y sirve desde aquí (proxy).
 *  - Escrituras con bloqueo exclusivo (flock) para evitar pérdidas de puntajes por concurrencia.
 *  - Límite de peticiones por IP en las acciones sensibles.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

define('APP_VERSION_FALLBACK', '1.0.2');
define('DATA_DIR', __DIR__ . '/data');
define('ROOMS_FILE', DATA_DIR . '/rooms.json');
define('USERS_FILE', DATA_DIR . '/users.json');
define('LEADERBOARD_FILE', DATA_DIR . '/leaderboard.json');
define('SESSIONS_FILE', DATA_DIR . '/sessions.json');
define('RATE_FILE', DATA_DIR . '/ratelimit.json');
define('SAT_DIR', DATA_DIR . '/sat');
define('COORDS_FILE', __DIR__ . '/coordenadas_validas.json');
define('SATPOOL_DIR', __DIR__ . '/satpool');
define('SAT_LOG_FILE', DATA_DIR . '/sat-error.log');
define('SETTINGS_FILE', DATA_DIR . '/settings.json');
define('HISTORY_DIR', DATA_DIR . '/history');
define('DAILY_DIR', DATA_DIR . '/daily');
define('DAILY_TZ', 'America/Mexico_City');

define('PERFECT_KM', 0.025);
define('BASE_SCORE', 5000);
define('SCORE_DECAY_KM', 1.2);
define('SAT_DECAY_KM', 3.5);       // Ojo de Halcón abarca todo el municipio (~37 km).
define('TOWN_LAT', 21.7826);       // Centro de la cabecera municipal (OSM place=town)
define('TOWN_LNG', -103.3061);
define('CITY_KM', 2.0);            // Radio considerado «dentro de la ciudad»
define('MIN_SEPARATION_KM', 0.161);
define('SAT_ZOOM', 19);
define('SAT_SIZE', 1024);
define('SESSION_TTL', 3 * 3600);
define('MIN_ROUND_MS', 1500);       // Más rápido que esto es un bot: la ronda vale 0.
define('SUSPECT_ROUND_MS', 5000);   // Perfect en menos de 5 s es sospechoso.

$GAME_MODES = ['normal', 'static', 'temporal', 'tunnel', 'static_tunnel', 'blur', 'static_blur', 'race', 'flashlight', 'satellite'];
$SOLO_MODES = ['normal', 'static', 'temporal', 'tunnel', 'static_tunnel', 'blur', 'static_blur', 'flashlight', 'satellite'];
$ROUND_OPTIONS = [5, 7, 10, 15];

/* ============================== Utilidades =============================== */

function out($data, $code = 200) {
    http_response_code($code);
    echo json_encode($data, JSON_UNESCAPED_UNICODE);
    exit;
}

function fail($error, $code = 200) {
    out(['ok' => false, 'error' => $error], $code);
}

function ensureDataDir() {
    if (!is_dir(DATA_DIR)) {
        @mkdir(DATA_DIR, 0755, true);
    }
    $ht = DATA_DIR . '/.htaccess';
    if (!file_exists($ht)) {
        @file_put_contents($ht, "Require all denied\n<IfModule !mod_authz_core.c>\n    Order allow,deny\n    Deny from all\n</IfModule>\n");
    }
    $idx = DATA_DIR . '/index.html';
    if (!file_exists($idx)) {
        @file_put_contents($idx, '');
    }
    foreach ([SAT_DIR, HISTORY_DIR, DAILY_DIR] as $dir) {
        if (!is_dir($dir)) @mkdir($dir, 0755, true);
    }

    // Migración única desde la raíz pública (v2.0.x): importar nombres, borrar datos expuestos.
    // El leaderboard anterior se descarta a propósito (reinicio a 0 de la v2.1.0).
    $marker = DATA_DIR . '/.migrated-v210';
    if (!file_exists($marker)) {
        $oldUsers = __DIR__ . '/users.json';
        if (file_exists($oldUsers) && !file_exists(USERS_FILE)) {
            $names = json_decode((string)@file_get_contents($oldUsers), true);
            $users = [];
            if (is_array($names)) {
                foreach ($names as $n) {
                    $clean = normalizeName(is_string($n) ? $n : '');
                    if ($clean === '') continue;
                    $users[nameKey($clean)] = ['name' => $clean, 'kh' => null, 't' => time()];
                }
            }
            saveJson(USERS_FILE, $users);
        }
        foreach (['users.json', 'leaderboard.json', 'rooms.json'] as $f) {
            if (file_exists(__DIR__ . '/' . $f)) @unlink(__DIR__ . '/' . $f);
        }
        @file_put_contents($marker, (string)time());
    }
}

function loadJson($file, $default = []) {
    if (!file_exists($file)) return $default;
    for ($i = 0; $i < 4; $i++) {
        $raw = @file_get_contents($file);
        if ($raw !== false && trim($raw) !== '') {
            $data = json_decode($raw, true);
            if (is_array($data)) return $data;
        }
        usleep(10000);
    }
    return $default;
}

function saveJson($file, $data) {
    $json = json_encode($data, JSON_UNESCAPED_UNICODE);
    if ($json === false) return false;
    $temp = $file . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (@file_put_contents($temp, $json) !== false) {
        if (@rename($temp, $file)) return true;
        @unlink($temp);
    }
    return @file_put_contents($file, $json, LOCK_EX) !== false;
}

/**
 * Lee-modifica-escribe un JSON con bloqueo exclusivo. $fn recibe los datos por referencia
 * y devuelve [resultado, huboCambios].
 */
function withJson($file, $default, callable $fn) {
    $lock = @fopen($file . '.lock', 'c');
    if ($lock) @flock($lock, LOCK_EX);
    try {
        $data = loadJson($file, $default);
        $ret = $fn($data);
        $result = is_array($ret) && array_key_exists(0, $ret) ? $ret[0] : $ret;
        $dirty = is_array($ret) && array_key_exists(1, $ret) ? (bool)$ret[1] : true;
        if ($dirty && !saveJson($file, $data)) {
            return ['__error' => 'no se pudo escribir en el servidor'];
        }
        return $result;
    } finally {
        if ($lock) {
            @flock($lock, LOCK_UN);
            @fclose($lock);
        }
    }
}

function input($key, $default = null) {
    global $IN;
    return array_key_exists($key, $IN) ? $IN[$key] : $default;
}

function str_in($key, $max = 200) {
    $v = input($key, '');
    if (!is_scalar($v)) return '';
    $v = trim((string)$v);
    return function_exists('mb_substr') ? mb_substr($v, 0, $max) : substr($v, 0, $max);
}

function nowMs() {
    return (int)round(microtime(true) * 1000);
}

function clientIp() {
    return substr((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'), 0, 64);
}

function normalizeName($name) {
    $name = (string)$name;
    $name = preg_replace('/[^\p{L}\p{N} _\-\.]/u', '', $name);
    if ($name === null) $name = '';
    $name = trim(preg_replace('/\s+/u', ' ', $name));
    return function_exists('mb_substr') ? mb_substr($name, 0, 20) : substr($name, 0, 20);
}

function nameKey($name) {
    $n = normalizeName($name);
    return function_exists('mb_strtolower') ? mb_strtolower($n, 'UTF-8') : strtolower($n);
}

function validKey($key) {
    return is_string($key) && preg_match('/^[a-f0-9]{32,64}$/', $key) === 1;
}

function newToken() {
    return bin2hex(random_bytes(16));
}

function validToken($t) {
    return is_string($t) && preg_match('/^[a-f0-9]{32}$/', $t) === 1;
}

/** Límite de peticiones por IP y por tipo de acción (ventana fija). */
function rateLimit($bucket, $max, $windowSec) {
    $ip = clientIp();
    $now = time();
    $allowed = withJson(RATE_FILE, [], function (&$rl) use ($ip, $bucket, $max, $windowSec, $now) {
        foreach ($rl as $k => $v) {
            if (!is_array($v) || $now - intval($v[1] ?? 0) > 7200) unset($rl[$k]);
        }
        $k = $bucket . '|' . $ip;
        $entry = $rl[$k] ?? [0, $now];
        if ($now - intval($entry[1]) > $windowSec) $entry = [0, $now];
        if ($entry[0] >= $max) return [false, false];
        $entry[0]++;
        $rl[$k] = $entry;
        return [true, true];
    });
    if ($allowed !== true) {
        fail('Demasiadas peticiones. Espera unos minutos e inténtalo de nuevo.', 429);
    }
}

/* ================================ Usuarios =============================== */

/**
 * Verifica que $key (clave del dispositivo) pertenezca a $name. Cada cuenta admite varios
 * dispositivos (se agregan iniciando sesión con contraseña o código de recuperación). Las
 * cuentas antiguas sin clave se reclaman con la primera clave válida. Si el nombre no existe
 * y $autoRegister, se crea. Devuelve el nombre canónico, false o 'banned'.
 */
function authUser($name, $key, $autoRegister = true) {
    $clean = normalizeName($name);
    if ($clean === '' || !validKey($key)) return false;
    $k = nameKey($clean);
    $hash = keyHash($key);
    $res = withJson(USERS_FILE, [], function (&$users) use ($k, $clean, $hash, $autoRegister) {
        if (!isset($users[$k])) {
            if (!$autoRegister) return [false, false];
            $users[$k] = ['name' => $clean, 'keys' => [$hash], 't' => time(), 'seen' => time(), 'games' => 0];
            return [$clean, true];
        }
        $u = &$users[$k];
        if (!empty($u['banned'])) return ['banned', false];
        $keys = userKeys($u);
        if (!$keys) {
            addDeviceKey($u, $hash);
            $u['seen'] = time();
            return [$u['name'] ?? $clean, true];
        }
        foreach ($keys as $h) {
            if (hash_equals((string)$h, $hash)) {
                // Actualizar "visto por última vez" como mucho una vez por hora (menos escrituras).
                if (time() - intval($u['seen'] ?? 0) > 3600) {
                    $u['seen'] = time();
                    return [$u['name'] ?? $clean, true];
                }
                return [$u['name'] ?? $clean, false];
            }
        }
        return [false, false];
    });
    return is_string($res) ? $res : false;
}

function requireUser($autoRegister = true) {
    $name = str_in('name', 40);
    $key = str_in('key', 64);
    $canon = authUser($name, $key, $autoRegister);
    if ($canon === 'banned') fail('Esta cuenta está suspendida por el administrador.', 403);
    if ($canon === false) {
        fail('Este nombre pertenece a otro jugador o dispositivo. Inicia sesión con tu contraseña o código de recuperación, o elige otro nombre.', 403);
    }
    return $canon;
}

/* ========================= Puntuación (servidor) ========================= */

function haversineKm($lat1, $lon1, $lat2, $lon2) {
    $r = 6371.0;
    $dLat = deg2rad($lat2 - $lat1);
    $dLon = deg2rad($lon2 - $lon1);
    $a = sin($dLat / 2) ** 2 + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLon / 2) ** 2;
    return 2 * $r * asin(min(1, sqrt($a)));
}

function scoreCurve($dKm, $max, $decay) {
    if ($dKm <= PERFECT_KM) return $max;
    return max(0, min($max, (int)floor($max * exp(-$dKm / $decay))));
}

function isTunnelMode($m) { return $m === 'tunnel' || $m === 'static_tunnel'; }
function isBlurMode($m) { return $m === 'blur' || $m === 'static_blur'; }

function maxPerRound($mode) {
    if (isBlurMode($mode)) return 7000 + 750 * 14; // incluye rachas de perfects
    if (isTunnelMode($mode)) return 6500;
    if ($mode === 'flashlight') return 7000;
    return 5000;
}

function soloTimeMax($rounds, $mode) {
    $map = [5 => 105, 7 => 120, 10 => 150, 15 => 210];
    $base = $map[$rounds] ?? 105;
    if (isTunnelMode($mode) || isBlurMode($mode) || $mode === 'satellite') $base += 60;
    return $base;
}

function loadGraceMs($mode) {
    return $mode === 'satellite' ? 6000 : 3000;
}

/** Leaderboard: prima la precisión y ajusta por velocidad (0.5 a 1.0). */
function leaderScore($rounds, $points, $timeMs, $timeMaxSec, $mode) {
    $points = max(0, min(intval($points), $rounds * maxPerRound($mode)));
    $ratio = min(1, max(0, intval($timeMs) / max(1, $timeMaxSec * 1000)));
    return (int)round($points * (1 - 0.5 * $ratio) * 10);
}

/* ============================== Ubicaciones ============================== */

function loadCoords() {
    static $coords = null;
    if ($coords === null) {
        $coords = loadJson(COORDS_FILE, []);
    }
    return $coords;
}

function pickLocations($count, $only = null) {
    $coords = loadCoords();
    $n = count($coords);
    if ($n === 0) return [];
    $idx = is_array($only) && count($only) >= $count
        ? array_values(array_filter(array_map('intval', $only), function ($i) use ($n) { return $i >= 0 && $i < $n; }))
        : range(0, $n - 1);
    shuffle($idx);
    $picked = [];
    foreach ([MIN_SEPARATION_KM, MIN_SEPARATION_KM / 2, 0] as $minKm) {
        foreach ($idx as $i) {
            if (count($picked) >= $count) break 2;
            if (in_array($i, $picked, true)) continue;
            $c = $coords[$i];
            if (!isset($c['lat'], $c['lng'], $c['pano_id'])) continue;
            $ok = true;
            foreach ($picked as $p) {
                if (haversineKm($c['lat'], $c['lng'], $coords[$p]['lat'], $coords[$p]['lng']) < $minKm) {
                    $ok = false;
                    break;
                }
            }
            if ($ok) $picked[] = $i;
        }
    }
    return array_slice($picked, 0, $count);
}

function coordOf($idx) {
    $coords = loadCoords();
    if (!isset($coords[$idx])) return null;
    return ['lat' => (float)$coords[$idx]['lat'], 'lng' => (float)$coords[$idx]['lng'], 'pano' => (string)$coords[$idx]['pano_id']];
}

/* =============================== Sesiones ================================ */

function cleanupSessions(&$sessions) {
    $now = time();
    foreach ($sessions as $t => $s) {
        if (!is_array($s) || $now - intval($s['created'] ?? 0) > SESSION_TTL) {
            unset($sessions[$t]);
            foreach (glob(SAT_DIR . '/' . $t . '_*.jpg') ?: [] as $f) @unlink($f);
        }
    }
}

function getSession($token) {
    if (!validToken($token)) return null;
    $all = loadJson(SESSIONS_FILE, []);
    return isset($all[$token]) && is_array($all[$token]) ? $all[$token] : null;
}

/* ===================== Imagen satelital (proxy seguro) ==================== */

/**
 * Banco de imágenes satelitales pre-generadas (satpool/) de TODO el municipio. El manifiesto
 * es PHP (no descargable) y asocia cada id con {lat, lng, tipo, archivo aleatorio}. Así el modo
 * no depende de que el hosting pueda descargar teselas de Google.
 */
function satPool() {
    static $pool = null;
    if ($pool !== null) return $pool;
    $pool = [];
    $m = SATPOOL_DIR . '/manifest.php';
    if (!file_exists($m)) return $pool;
    $data = @include $m;
    if (!is_array($data)) return $pool;
    if (isset($data['items']) && is_array($data['items'])) {
        foreach ($data['items'] as $id => $it) {
            if (!is_array($it) || !isset($it['lat'], $it['lng'], $it['f'])) continue;
            if (!preg_match('/^[a-f0-9]{16,64}\.jpg$/', (string)$it['f'])) continue;
            $pool[(string)$id] = ['lat' => (float)$it['lat'], 'lng' => (float)$it['lng'], 'k' => (string)($it['k'] ?? 'urbano'), 'f' => (string)$it['f']];
        }
    } else {
        // Formato v1 (v2.1.1): índice de coordenadas_validas.json => archivo
        foreach ($data as $i => $f) {
            $c = coordOf(intval($i));
            if ($c && is_string($f) && preg_match('/^[a-f0-9]{16,64}\.jpg$/', $f)) {
                $pool['u' . intval($i)] = ['lat' => $c['lat'], 'lng' => $c['lng'], 'k' => 'urbano', 'f' => $f];
            }
        }
    }
    return $pool;
}

/**
 * Elige las rondas satelitales mezclando terrenos (ciudad, localidades, caminos y campo/sierra)
 * y separándolas al menos 500 m entre sí. Devuelve entradas de sesión ['p' => id].
 */
/** Configuración estándar de Ojo de Halcón: la única que cuenta para el leaderboard. */
const SAT_STD_ZOOM = 280;
const SAT_STD_CITY = 60;

/**
 * Lee y valida los parámetros de Ojo de Halcón elegidos por el jugador o anfitrión:
 * zoom (150–280 m de área visible), origen de las fotos (ambas / solo centro / solo afuera)
 * y, si son ambas, el porcentaje de fotos del centro (10–90 %).
 */
function satParams() {
    $zoom = intval(input('satZoom', SAT_STD_ZOOM));
    $zoom = max(150, min(SAT_STD_ZOOM, (int)(round($zoom / 10) * 10)));
    $src = str_in('satSource', 8);
    if (!in_array($src, ['both', 'city', 'out'], true)) $src = 'both';
    $city = intval(input('satCity', SAT_STD_CITY));
    $city = max(10, min(90, (int)(round($city / 10) * 10)));
    $pct = $src === 'city' ? 100 : ($src === 'out' ? 0 : $city);
    return [
        'zoom' => $zoom,
        'src' => $src,
        'city' => $src === 'both' ? $city : $pct,
        'pct' => $pct,
        'ranked' => $zoom === SAT_STD_ZOOM && $src === 'both' && $city === SAT_STD_CITY,
    ];
}

function satParamsStd() {
    return ['zoom' => SAT_STD_ZOOM, 'src' => 'both', 'city' => SAT_STD_CITY, 'pct' => SAT_STD_CITY, 'ranked' => true];
}

/**
 * Elige fotos del banco satelital: $cityPct % dentro de la ciudad (≤ 2 km del centro) y el
 * resto fuera (rancherías, caminos, campo y sierra), con al menos 400 m entre ellas.
 */
function pickSatLocations($count, $cityPct = SAT_STD_CITY) {
    $pool = satPool();
    if (count($pool) < $count) {
        return array_map(function ($i) { return ['i' => $i]; }, pickLocations($count));
    }
    $cityPct = max(0, min(100, intval($cityPct)));
    $urban = [];
    $rural = [];
    foreach ($pool as $id => $it) {
        if (haversineKm(TOWN_LAT, TOWN_LNG, $it['lat'], $it['lng']) <= CITY_KM) $urban[] = $id; else $rural[] = $id;
    }
    shuffle($urban);
    shuffle($rural);
    $wantUrban = (int)round($count * $cityPct / 100);
    if (!$urban) $wantUrban = 0;
    if (!$rural) $wantUrban = $count;
    $picked = [];
    $take = function (array $ids, $n, $minKm) use (&$picked, $pool) {
        $got = 0;
        foreach ($ids as $id) {
            if ($got >= $n) break;
            if (in_array($id, $picked, true)) continue;
            $it = $pool[$id];
            $ok = true;
            foreach ($picked as $pid) {
                if (haversineKm($it['lat'], $it['lng'], $pool[$pid]['lat'], $pool[$pid]['lng']) < $minKm) { $ok = false; break; }
            }
            if ($ok) { $picked[] = $id; $got++; }
        }
        return $got;
    };
    $wantRural = $count - $wantUrban;
    // Primero se respeta la proporción con 400 m de separación; si la zona elegida no alcanza
    // (p. ej. «solo centro» con 15 rondas), se relaja la separación antes de mezclar zonas.
    $isUrban = function ($id) use ($pool) {
        return haversineKm(TOWN_LAT, TOWN_LNG, $pool[$id]['lat'], $pool[$id]['lng']) <= CITY_KM;
    };
    foreach ([0.4, 0.2, 0.0] as $minKm) {
        $gotU = count(array_filter($picked, $isUrban));
        $gotR = count($picked) - $gotU;
        if ($gotU < $wantUrban) $take($urban, $wantUrban - $gotU, $minKm);
        if ($gotR < $wantRural) $take($rural, $wantRural - $gotR, $minKm);
        if (count($picked) >= $count) break;
    }
    if (count($picked) < $count) $take(array_merge($urban, $rural), $count - count($picked), 0.0);
    $picked = array_slice($picked, 0, $count);
    shuffle($picked);
    return array_map(function ($id) { return ['p' => (string)$id]; }, $picked);
}

/** Coordenadas reales de una ronda (banco satelital o punto de Street View). */
function locCoord($loc) {
    if (isset($loc['p'])) {
        $pool = satPool();
        $it = $pool[(string)$loc['p']] ?? null;
        return $it ? ['lat' => $it['lat'], 'lng' => $it['lng']] : null;
    }
    return coordOf(intval($loc['i'] ?? -1));
}

function satLog($msg) {
    $line = date('c') . ' ' . $msg . "\n";
    if (file_exists(SAT_LOG_FILE) && filesize(SAT_LOG_FILE) > 65536) @unlink(SAT_LOG_FILE);
    @file_put_contents(SAT_LOG_FILE, $line, FILE_APPEND);
}

function latLngToPixel($lat, $lng, $z) {
    $scale = 256 * (1 << $z);
    $x = ($lng + 180.0) / 360.0 * $scale;
    $latR = deg2rad(max(-85.0, min(85.0, $lat)));
    $y = (1 - log(tan($latR) + 1 / cos($latR)) / M_PI) / 2 * $scale;
    return [$x, $y];
}

function tileUrl($x, $y, $z) {
    $s = ($x + $y) % 4;
    return "https://mt{$s}.google.com/vt/lyrs=s&x={$x}&y={$y}&z={$z}";
}

/** Descarga varias URLs en paralelo (curl_multi) o en serie (streams) como respaldo. */
function fetchMany(array $urls) {
    $out = [];
    if (function_exists('curl_multi_init')) {
        $mh = curl_multi_init();
        $handles = [];
        foreach ($urls as $k => $u) {
            $ch = curl_init($u);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_FOLLOWLOCATION => true,
                CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_TIMEOUT => 12,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (GG-TLALTE tile proxy)',
                CURLOPT_SSL_VERIFYPEER => true,
            ]);
            if (defined('CURLSSLOPT_NATIVE_CA')) {
                @curl_setopt($ch, CURLOPT_SSL_OPTIONS, CURLSSLOPT_NATIVE_CA);
            }
            curl_multi_add_handle($mh, $ch);
            $handles[$k] = $ch;
        }
        $running = null;
        do {
            $st = curl_multi_exec($mh, $running);
            if ($running) curl_multi_select($mh, 1.0);
        } while ($running && $st === CURLM_OK);
        foreach ($handles as $k => $ch) {
            $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $body = curl_multi_getcontent($ch);
            $out[$k] = ($code === 200 && $body) ? $body : null;
            if ($out[$k] === null) {
                $GLOBALS['gg_fetch_errors'][] = $code . ' ' . curl_error($ch);
            }
            curl_multi_remove_handle($mh, $ch);
            curl_close($ch);
        }
        curl_multi_close($mh);
        return $out;
    }
    $ctx = stream_context_create(['http' => ['timeout' => 10, 'header' => "User-Agent: Mozilla/5.0 (GG-TLALTE tile proxy)\r\n"]]);
    foreach ($urls as $k => $u) {
        $b = @file_get_contents($u, false, $ctx);
        $out[$k] = $b !== false && $b !== '' ? $b : null;
        if ($out[$k] === null) {
            $err = error_get_last();
            $GLOBALS['gg_fetch_errors'][] = 'stream ' . ($err ? $err['message'] : 'error');
        }
    }
    return $out;
}

/** Compone un mosaico SAT_SIZE×SAT_SIZE centrado exactamente en (lat,lng). */
function composeSatellite($lat, $lng, $file, $quality = 84) {
    if (!function_exists('imagecreatetruecolor')) {
        satLog('GD no disponible en el servidor');
        return false;
    }
    $GLOBALS['gg_fetch_errors'] = [];
    $z = SAT_ZOOM;
    list($px, $py) = latLngToPixel($lat, $lng, $z);
    $x0 = (int)floor($px - SAT_SIZE / 2);
    $y0 = (int)floor($py - SAT_SIZE / 2);
    $tx0 = intdiv($x0, 256); $ty0 = intdiv($y0, 256);
    $tx1 = intdiv($x0 + SAT_SIZE - 1, 256); $ty1 = intdiv($y0 + SAT_SIZE - 1, 256);
    $urls = [];
    for ($ty = $ty0; $ty <= $ty1; $ty++) {
        for ($tx = $tx0; $tx <= $tx1; $tx++) {
            $urls["$tx,$ty"] = tileUrl($tx, $ty, $z);
        }
    }
    $tiles = fetchMany($urls);
    // Respaldo: si el hosting no puede validar TLS, reintentar las teselas fallidas por HTTP.
    $retry = [];
    foreach ($tiles as $k => $b) {
        if (!$b) $retry[$k] = str_replace('https://', 'http://', $urls[$k]);
    }
    if ($retry) {
        foreach (fetchMany($retry) as $k => $b) {
            if ($b) $tiles[$k] = $b;
        }
    }
    $okCount = 0;
    $img = imagecreatetruecolor(SAT_SIZE, SAT_SIZE);
    imagefill($img, 0, 0, imagecolorallocate($img, 18, 22, 28));
    foreach ($tiles as $k => $bytes) {
        if (!$bytes) continue;
        $t = @imagecreatefromstring($bytes);
        if (!$t) continue;
        list($tx, $ty) = array_map('intval', explode(',', $k));
        $dx = $tx * 256 - $x0;
        $dy = $ty * 256 - $y0;
        $sx = max(0, -$dx); $sy = max(0, -$dy);
        $w = min(256 - $sx, SAT_SIZE - max(0, $dx));
        $h = min(256 - $sy, SAT_SIZE - max(0, $dy));
        if ($w > 0 && $h > 0) {
            imagecopy($img, $t, max(0, $dx), max(0, $dy), $sx, $sy, $w, $h);
            $okCount++;
        }
        imagedestroy($t);
    }
    if ($okCount === 0) {
        imagedestroy($img);
        $errs = array_slice(array_unique($GLOBALS['gg_fetch_errors'] ?? []), 0, 3);
        satLog('sin teselas (' . count($tiles) . ' pedidas): ' . implode(' | ', $errs)
            . ' curl=' . (function_exists('curl_init') ? 'si' : 'no')
            . ' allow_url_fopen=' . (ini_get('allow_url_fopen') ? 'si' : 'no'));
        return false;
    }
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $saved = imagejpeg($img, $tmp, $quality);
    imagedestroy($img);
    if (!$saved) return false;
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        return file_exists($file);
    }
    return true;
}

/** Ruta de la imagen de la ronda: banco pre-generado o composición en vivo (respaldo). */
function satImagePath($session, $token, $round) {
    $loc = $session['locs'][$round - 1] ?? null;
    if (!$loc) fail('ronda no válida', 404);
    if (isset($loc['p'])) {
        $pool = satPool();
        $it = $pool[(string)$loc['p']] ?? null;
        if ($it && file_exists(SATPOOL_DIR . '/' . $it['f'])) return SATPOOL_DIR . '/' . $it['f'];
    }
    $c = locCoord($loc);
    if (!$c) fail('ubicación no disponible', 404);
    $file = SAT_DIR . '/' . $token . '_' . $round . '.jpg';
    if (!file_exists($file)) {
        $lock = @fopen($file . '.lock', 'c');
        if ($lock) @flock($lock, LOCK_EX);
        $ok = file_exists($file);
        if (!$ok) {
            @set_time_limit(40);
            $ok = composeSatellite($c['lat'], $c['lng'], $file);
        }
        if ($lock) { @flock($lock, LOCK_UN); @fclose($lock); }
        @unlink($file . '.lock');
        if (!$ok) fail('No se pudo generar la vista satelital en el servidor.', 502);
    }
    return $file;
}

function outputJpeg($file) {
    header_remove('Pragma');
    header('Content-Type: image/jpeg');
    header('Cache-Control: private, max-age=3600');
    header('Content-Length: ' . filesize($file));
    readfile($file);
    exit;
}

function serveSatImage($session, $token, $round) {
    outputJpeg(satImagePath($session, $token, $round));
}

/* ================================ Salas ================================== */

function cleanupRooms(&$rooms) {
    $now = time();
    $changed = false;
    foreach ($rooms as $id => $room) {
        $threshold = ($room['status'] ?? '') === 'in_progress' ? 180 : 120;
        if (!is_array($room) || $now - intval($room['updated'] ?? 0) > $threshold) {
            unset($rooms[$id]);
            $changed = true;
        }
    }
    return $changed;
}

function roomId($v) {
    $v = trim((string)$v);
    return preg_match('/^[A-Za-z0-9_\-]{1,64}$/', $v) ? $v : '';
}

/* ======================= Cuentas, perfil y reto diario ===================== */

function keyHash($key) {
    return hash('sha256', 'ggtlalte|' . $key);
}

/** Hashes de dispositivos autorizados de un usuario (compatibilidad con el campo antiguo kh). */
function userKeys($u) {
    $keys = isset($u['keys']) && is_array($u['keys']) ? $u['keys'] : [];
    if (!empty($u['kh']) && !in_array($u['kh'], $keys, true)) $keys[] = $u['kh'];
    return $keys;
}

function addDeviceKey(&$u, $hash) {
    $keys = userKeys($u);
    $keys = array_values(array_filter($keys, function ($h) use ($hash) { return $h !== $hash; }));
    $keys[] = $hash;
    $u['keys'] = array_slice($keys, -8); // hasta 8 dispositivos
    unset($u['kh']);
}

function recoveryCode() {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $out = '';
    for ($i = 0; $i < 12; $i++) {
        $out .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        if ($i === 3 || $i === 7) $out .= '-';
    }
    return $out;
}

function normalizeRecovery($code) {
    return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', (string)$code));
}

function securityLog($msg) {
    $f = DATA_DIR . '/security.log';
    if (file_exists($f) && filesize($f) > 262144) @rename($f, $f . '.1');
    @file_put_contents($f, date('c') . ' [' . clientIp() . '] ' . $msg . "\n", FILE_APPEND);
}

function settings() {
    static $s = null;
    if ($s === null) {
        $s = loadJson(SETTINGS_FILE, []) + [
            'maintenance' => false,
            'maintenanceMsg' => 'Estamos dando mantenimiento al juego. Vuelve en unos minutos.',
            'announcement' => '',
            'dailyOverride' => [],
        ];
    }
    return $s;
}

function requireOpen() {
    $s = settings();
    if (!empty($s['maintenance'])) fail($s['maintenanceMsg'] ?: 'El juego está en mantenimiento.', 503);
}

/* ------------------------------- Historial ------------------------------- */

function historyFile($name) {
    return HISTORY_DIR . '/' . substr(hash('sha256', 'h|' . nameKey($name)), 0, 32) . '.json';
}

function appendHistory($name, array $entry) {
    if (!is_dir(HISTORY_DIR)) @mkdir(HISTORY_DIR, 0755, true);
    withJson(historyFile($name), ['games' => []], function (&$h) use ($entry) {
        if (!isset($h['games']) || !is_array($h['games'])) $h['games'] = [];
        $h['games'][] = $entry;
        if (count($h['games']) > 300) $h['games'] = array_slice($h['games'], -300);
        return [true, true];
    });
    withJson(USERS_FILE, [], function (&$users) use ($name) {
        $k = nameKey($name);
        if (!isset($users[$k])) return [true, false];
        $users[$k]['games'] = intval($users[$k]['games'] ?? 0) + 1;
        $users[$k]['seen'] = time();
        return [true, true];
    });
}

/** Estadísticas del perfil calculadas a partir del historial. */
function profileStats(array $games) {
    $solo = array_values(array_filter($games, function ($g) { return empty($g['multi']); }));
    $multi = array_values(array_filter($games, function ($g) { return !empty($g['multi']); }));
    $rounds = 0; $points = 0; $perfects = 0; $distSum = 0.0; $distN = 0;
    $best = [];
    $daily = 0; $dailyBestRank = null; $timeMs = 0;
    foreach ($solo as $g) {
        $rounds += intval($g['rounds'] ?? 0);
        $points += intval($g['points'] ?? 0);
        $perfects += intval($g['perfects'] ?? 0);
        $timeMs += intval($g['timeMs'] ?? 0);
        if (isset($g['avgKm']) && $g['avgKm'] !== null) { $distSum += (float)$g['avgKm']; $distN++; }
        $k = ($g['daily'] ?? null) ? 'daily' : (($g['mode'] ?? 'normal') . '_' . intval($g['rounds'] ?? 0));
        if (!isset($best[$k]) || intval($g['score'] ?? 0) > $best[$k]['score']) {
            $best[$k] = ['mode' => $g['mode'] ?? 'normal', 'rounds' => intval($g['rounds'] ?? 0), 'score' => intval($g['score'] ?? 0),
                         'points' => intval($g['points'] ?? 0), 'daily' => $g['daily'] ?? null, 't' => intval($g['t'] ?? 0)];
        }
        if (!empty($g['daily'])) {
            $daily++;
            if (isset($g['rank']) && $g['rank'] !== null && ($dailyBestRank === null || $g['rank'] < $dailyBestRank)) $dailyBestRank = intval($g['rank']);
        }
    }
    $wins = 0;
    foreach ($multi as $g) if (intval($g['rank'] ?? 0) === 1) $wins++;
    $modeCount = [];
    foreach ($games as $g) {
        $m = $g['mode'] ?? 'normal';
        $modeCount[$m] = ($modeCount[$m] ?? 0) + 1;
    }
    arsort($modeCount);
    // Racha de días consecutivos jugando el reto diario (hasta hoy o ayer).
    $days = [];
    foreach ($solo as $g) if (!empty($g['daily'])) $days[$g['daily']] = true;
    $streak = 0;
    $d = new DateTime(dailyDate(), new DateTimeZone(DAILY_TZ));
    if (!isset($days[$d->format('Y-m-d')])) $d->modify('-1 day');
    while (isset($days[$d->format('Y-m-d')])) { $streak++; $d->modify('-1 day'); }
    return [
        'games' => count($games),
        'soloGames' => count($solo),
        'multiGames' => count($multi),
        'multiWins' => $wins,
        'rounds' => $rounds,
        'points' => $points,
        'avgPerRound' => $rounds ? (int)round($points / $rounds) : 0,
        'perfects' => $perfects,
        'avgKm' => $distN ? round($distSum / $distN, 3) : null,
        'timePlayedMs' => $timeMs,
        'dailyPlayed' => $daily,
        'dailyBestRank' => $dailyBestRank,
        'dailyStreak' => $streak,
        'favoriteMode' => $modeCount ? array_key_first($modeCount) : null,
        'best' => array_values($best),
    ];
}

/* ------------------------------ Reto diario ------------------------------ */

function dailyDate() {
    $d = new DateTime('now', new DateTimeZone(DAILY_TZ));
    return $d->format('Y-m-d');
}

function validDate($d) {
    return is_string($d) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) === 1;
}

/** Modo del día: rota de forma fija (o el que fije el administrador). */
function dailyConfig($date) {
    $modes = ['normal', 'satellite', 'static', 'blur', 'temporal', 'flashlight', 'tunnel', 'satellite', 'static_blur', 'static_tunnel'];
    $s = settings();
    $override = $s['dailyOverride'][$date] ?? null;
    $epoch = (int)floor(strtotime($date . ' 12:00:00 UTC') / 86400);
    $mode = in_array($override, $modes, true) ? $override : $modes[$epoch % count($modes)];
    return ['date' => $date, 'mode' => $mode, 'rounds' => 10, 'temporalSeconds' => 3, 'tunnelSeconds' => 5, 'blurSeconds' => 5,
            'timeMax' => soloTimeMax(10, $mode)];
}

/** Ubicaciones del día: idénticas para todos (semilla derivada de la fecha). */
function dailyLocations($date, $mode) {
    mt_srand(crc32('gg-tlalte-daily|' . $date . '|' . $mode));
    $locs = $mode === 'satellite'
        ? pickSatLocations(10)
        : array_map(function ($i) { return ['i' => $i]; }, pickLocations(10));
    mt_srand();
    return $locs;
}

function dailyFile($date) {
    return DAILY_DIR . '/' . $date . '.json';
}

/* ============================ Entrada / ruteo ============================ */

if (defined('GG_LIB_ONLY')) {
    return; // Usado por herramientas CLI (generador del banco satelital).
}

ensureDataDir();

$IN = $_GET;
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $IN = array_merge($IN, $_POST);
    $raw = @file_get_contents('php://input', false, null, 0, 65536);
    if ($raw) {
        $json = json_decode($raw, true);
        if (is_array($json)) $IN = array_merge($IN, $json);
    }
}
$action = is_string($IN['action'] ?? null) ? $IN['action'] : '';

switch ($action) {
    case 'time': {
        // Reloj común para revelar las rondas multijugador en el mismo instante en todos los dispositivos.
        header('Cache-Control: no-store');
        out(['ok' => true, 't' => (int) round(microtime(true) * 1000)]);
    }

    case 'version': {
        $v = loadJson(__DIR__ . '/version.json', ['version' => APP_VERSION_FALLBACK]);
        out(['ok' => true, 'version' => $v['version'] ?? APP_VERSION_FALLBACK]);
    }

    /* ----------------------------- USUARIOS ----------------------------- */
    case 'check-name': {
        $name = normalizeName(str_in('name', 40));
        $users = loadJson(USERS_FILE, []);
        out(['ok' => true, 'available' => $name !== '' && !isset($users[nameKey($name)]), 'name' => $name]);
    }
    case 'register-name': {
        rateLimit('reg', 15, 3600);
        $name = normalizeName(str_in('name', 40));
        $key = str_in('key', 64);
        if ($name === '' || !validKey($key)) fail('nombre no válido');
        $users = loadJson(USERS_FILE, []);
        if (isset($users[nameKey($name)])) fail('nombre no disponible');
        $canon = authUser($name, $key, true);
        if ($canon === false) fail('nombre no disponible');
        out(['ok' => true, 'name' => $canon]);
    }
    case 'login': {
        // Verifica (o reclama, en cuentas antiguas sin clave) el nombre con la clave del dispositivo.
        rateLimit('login', 60, 3600);
        $canon = requireUser(true);
        out(['ok' => true, 'name' => $canon]);
    }

    /* ------------------------- SOLITARIO SEGURO ------------------------- */
    case 'solo-start': {
        rateLimit('solo', 60, 3600);
        requireOpen();
        $name = requireUser(true);
        $daily = !empty(input('daily', false)) ? dailyDate() : null;
        if ($daily) {
            // Reto diario: mismo modo y mismas 10 ubicaciones para todos; un intento por día.
            $cfg = dailyConfig($daily);
            $rounds = 10;
            $mode = $cfg['mode'];
            $tunnel = $cfg['tunnelSeconds'];
            $blur = $cfg['blurSeconds'];
            $already = withJson(dailyFile($daily), ['attempts' => [], 'entries' => []], function (&$d) use ($name) {
                $k = nameKey($name);
                if (isset($d['attempts'][$k])) return [true, false];
                $d['attempts'][$k] = ['t' => time(), 'name' => $name];
                return [false, true];
            });
            if ($already === true) fail('Ya jugaste el reto de hoy. ¡Vuelve mañana por uno nuevo!');
            $locs = dailyLocations($daily, $mode);
        } else {
            $rounds = intval(input('rounds', 5));
            if (!in_array($rounds, $ROUND_OPTIONS, true)) fail('rondas no válidas');
            $mode = str_in('gameMode', 20);
            if (!in_array($mode, $SOLO_MODES, true)) $mode = 'normal';
            $tunnel = max(2, min(15, intval(input('tunnelSeconds', 3))));
            $blur = max(2, min(15, intval(input('blurSeconds', 3))));
            $sat = $mode === 'satellite' ? satParams() : null;
            $locs = $mode === 'satellite'
                ? pickSatLocations($rounds, $sat['pct'])
                : array_map(function ($i) { return ['i' => $i]; }, pickLocations($rounds));
        }
        if ($mode === 'satellite' && empty($sat)) $sat = satParamsStd();
        if (count($locs) < $rounds) fail('no hay suficientes ubicaciones');
        $token = newToken();
        $session = [
            'kind' => 'solo',
            'name' => $name,
            'daily' => $daily,
            'mode' => $mode,
            'rounds' => $rounds,
            'cfg' => ['tunnel' => $tunnel, 'blur' => $blur],
            'sat' => $mode === 'satellite' ? $sat : null,
            'locs' => $locs,
            'cur' => 1,
            'served' => [],
            'guesses' => [],
            'streak' => 0,
            'total' => 0,
            'done' => false,
            'created' => time(),
            'ip' => clientIp(),
        ];
        $res = withJson(SESSIONS_FILE, [], function (&$all) use ($token, $session, $name) {
            cleanupSessions($all);
            // Una sola partida en solitario activa por jugador.
            foreach ($all as $t => $s) {
                if (($s['kind'] ?? '') === 'solo' && nameKey($s['name'] ?? '') === nameKey($name) && empty($s['done'])) {
                    unset($all[$t]);
                }
            }
            $all[$token] = $session;
            return [true, true];
        });
        if ($res !== true) fail('no se pudo crear la partida');
        out(['ok' => true, 'token' => $token, 'rounds' => $rounds, 'mode' => $mode, 'daily' => $daily,
             'tunnelSeconds' => $tunnel, 'blurSeconds' => $blur, 'timeMax' => soloTimeMax($rounds, $mode),
             'sat' => $mode === 'satellite' ? $sat : null]);
    }

    case 'solo-round': {
        $token = str_in('token', 40);
        $round = intval(input('round', 0));
        $res = withJson(SESSIONS_FILE, [], function (&$all) use ($token, $round) {
            if (!validToken($token) || !isset($all[$token])) return [['error' => 'partida no encontrada'], false];
            $s = &$all[$token];
            if (($s['kind'] ?? '') !== 'solo' || !empty($s['done'])) return [['error' => 'partida cerrada'], false];
            if ($round !== intval($s['cur']) || $round < 1 || $round > intval($s['rounds'])) {
                return [['error' => 'ronda fuera de orden'], false];
            }
            $loc = $s['locs'][$round - 1];
            $dirty = false;
            if ($s['mode'] !== 'satellite' && !isset($s['served'][(string)$round])) {
                $s['served'][(string)$round] = nowMs();
                $dirty = true;
            }
            if ($s['mode'] === 'satellite') {
                return [['round' => $round, 'satellite' => true], $dirty];
            }
            $c = coordOf(intval($loc['i']));
            return [['round' => $round, 'pano' => $c ? $c['pano'] : null], $dirty];
        });
        if (isset($res['__error'])) fail($res['__error']);
        if (isset($res['error'])) fail($res['error']);
        out(['ok' => true] + $res);
    }

    case 'solo-guess': {
        $token = str_in('token', 40);
        $round = intval(input('round', 0));
        $lat = input('lat', null);
        $lng = input('lng', null);
        $hasGuess = is_numeric($lat) && is_numeric($lng)
            && abs((float)$lat) <= 90 && abs((float)$lng) <= 180;
        $zoomStep = max(1, min(4, intval(input('zoomStep', 1))));
        $blurPhase = intval(input('blurPhase', 0));
        if ($blurPhase < 0 || $blurPhase > 5) $blurPhase = 0;
        $now = nowMs();

        $res = withJson(SESSIONS_FILE, [], function (&$all) use ($token, $round, $hasGuess, $lat, $lng, $zoomStep, $blurPhase, $now) {
            if (!validToken($token) || !isset($all[$token])) return [['error' => 'partida no encontrada'], false];
            $s = &$all[$token];
            if (($s['kind'] ?? '') !== 'solo' || !empty($s['done'])) return [['error' => 'partida cerrada'], false];
            if ($round !== intval($s['cur'])) return [['error' => 'ronda fuera de orden'], false];
            $served = $s['served'][(string)$round] ?? null;
            if ($served === null) return [['error' => 'la ronda aún no se ha mostrado'], false];

            $mode = $s['mode'];
            $c = locCoord($s['locs'][$round - 1]);
            if (!$c) return [['error' => 'ubicación no disponible'], false];
            $elapsed = max(0, $now - intval($served));
            $grace = loadGraceMs($mode);

            // Tiempo acumulado de la partida (sólo rondas): fuera del límite, la ronda vale 0.
            $usedMs = 0;
            foreach ($s['guesses'] as $g) $usedMs += intval($g['ms'] ?? 0);
            $timeMaxMs = soloTimeMax(intval($s['rounds']), $mode) * 1000;
            $overTime = ($usedMs + $elapsed - $grace * $round) > $timeMaxMs + 3000;

            $dist = null;
            $score = 0;
            $perfect = false;
            $owl = false;
            $suspect = false;
            if ($hasGuess) {
                $dist = haversineKm($c['lat'], $c['lng'], (float)$lat, (float)$lng);
                $perfect = $dist <= PERFECT_KM;
                $effSec = max(0, ($elapsed - $grace) / 1000);
                if (isTunnelMode($mode)) {
                    // El servidor sabe cuánto tiempo pasó: no se puede reclamar un zoom mayor al real.
                    $secs = intval($s['cfg']['tunnel'] ?? 3);
                    $serverStep = max(1, 4 - (int)floor($effSec / max(1, $secs)));
                    $step = min($zoomStep, $serverStep);
                    $maxes = [5000, 5250, 5750, 6500];
                    $decays = [1.2, 1.4, 1.7, 2.1];
                    $score = scoreCurve($dist, $maxes[$step - 1], $decays[$step - 1]);
                } elseif (isBlurMode($mode)) {
                    $secs = intval($s['cfg']['blur'] ?? 3);
                    $serverIdx = min(5, (int)floor($effSec / max(1, $secs)));
                    $claimIdx = $blurPhase === 0 ? 5 : $blurPhase - 1;
                    $idx = max($claimIdx, $serverIdx);
                    $maxes = [7000, 6400, 5900, 5500, 5200, 5000];
                    $decays = [2.2, 1.9, 1.6, 1.4, 1.3, 1.2];
                    $score = scoreCurve($dist, $maxes[$idx], $decays[$idx]);
                    if ($perfect) {
                        $s['streak'] = intval($s['streak']) + 1;
                        $score += max(0, $s['streak'] - 1) * 750;
                    } else {
                        $s['streak'] = 0;
                    }
                } else {
                    $score = scoreCurve($dist, BASE_SCORE, $mode === 'satellite' ? SAT_DECAY_KM : SCORE_DECAY_KM);
                    if ($mode === 'flashlight' && $perfect) {
                        $score += 2000;
                        $owl = true;
                    }
                }
                if ($elapsed < MIN_ROUND_MS) $score = 0;
                if ($perfect && $elapsed < SUSPECT_ROUND_MS) $suspect = true;
            } elseif (isBlurMode($mode)) {
                $s['streak'] = 0;
            }
            if ($overTime) $score = 0;

            $s['guesses'][(string)$round] = [
                'lat' => $hasGuess ? round((float)$lat, 6) : null,
                'lng' => $hasGuess ? round((float)$lng, 6) : null,
                'd' => $dist,
                'p' => $score,
                'ms' => $elapsed,
                'sus' => $suspect,
            ];
            $s['total'] = intval($s['total']) + $score;
            $s['cur'] = $round + 1;
            return [[
                'round' => $round,
                'real' => ['lat' => $c['lat'], 'lng' => $c['lng']],
                'distanceKm' => $dist,
                'score' => $score,
                'isPerfect' => $perfect,
                'owlBonus' => $owl,
                'perfectStreak' => intval($s['streak']),
                'total' => intval($s['total']),
                'overTime' => $overTime,
            ], true];
        });
        if (isset($res['__error'])) fail($res['__error']);
        if (isset($res['error'])) fail($res['error']);
        out(['ok' => true] + $res);
    }

    case 'solo-finish': {
        $token = str_in('token', 40);
        $clientMs = max(0, intval(input('clientTimeMs', 0)));
        $now = nowMs();
        $s = withJson(SESSIONS_FILE, [], function (&$all) use ($token) {
            if (!validToken($token) || !isset($all[$token])) return [['error' => 'partida no encontrada'], false];
            $sess = &$all[$token];
            if (($sess['kind'] ?? '') !== 'solo') return [['error' => 'partida no válida'], false];
            if (!empty($sess['done'])) return [['error' => 'esta partida ya fue registrada'], false];
            $sess['done'] = true;
            return [$sess, true];
        });
        if (isset($s['__error'])) fail($s['__error']);
        if (isset($s['error'])) fail($s['error']);

        $rounds = intval($s['rounds']);
        $mode = $s['mode'];
        $timeMax = soloTimeMax($rounds, $mode);
        $grace = loadGraceMs($mode);
        $serverMs = 0;
        $points = 0;
        $suspects = 0;
        foreach ($s['guesses'] as $g) {
            $serverMs += intval($g['ms']);
            $points += intval($g['p']);
            if (!empty($g['sus'])) $suspects++;
        }
        $guessed = count($s['guesses']);
        if ($guessed === 0) {
            out(['ok' => true, 'saved' => false, 'points' => 0, 'timeMs' => 0,
                 'error' => 'La partida no llegó a jugarse, así que no se registró en el leaderboard.']);
        }
        $timedOut = $guessed < $rounds;
        $timeMs = $timedOut
            ? $timeMax * 1000
            : min($timeMax * 1000, max($clientMs, $serverMs - $grace * $rounds, $rounds * MIN_ROUND_MS));

        if ($suspects >= 2) {
            securityLog('partida marcada como sospechosa: ' . $s['name'] . " ($mode, $rounds rondas, $points pts, $suspects perfects < 5 s)");
            out(['ok' => true, 'saved' => false, 'flagged' => true, 'points' => $points, 'timeMs' => $timeMs,
                'error' => 'Partida no registrada: el sistema anti-trampas detectó un patrón automatizado.']);
        }

        $score = leaderScore($rounds, $points, $timeMs, $timeMax, $mode);
        $key = $mode . '_' . $rounds;
        $name = $s['name'];
        $perfects = 0;
        $dSum = 0.0;
        $dN = 0;
        foreach ($s['guesses'] as $g) {
            if ($g['d'] !== null) {
                $dSum += (float)$g['d'];
                $dN++;
                if ((float)$g['d'] <= PERFECT_KM) $perfects++;
            }
        }
        $hist = ['t' => time(), 'mode' => $mode, 'rounds' => $rounds, 'points' => $points, 'score' => $score,
                 'timeMs' => $timeMs, 'perfects' => $perfects, 'avgKm' => $dN ? round($dSum / $dN, 3) : null,
                 'daily' => $s['daily'] ?? null, 'timedOut' => $timedOut];

        if (!empty($s['daily'])) {
            $date = $s['daily'];
            $rank = withJson(dailyFile($date), ['attempts' => [], 'entries' => []], function (&$d) use ($name, $points, $timeMs, $score, $perfects) {
                $d['entries'] = array_values(array_filter($d['entries'] ?? [], function ($e) use ($name) {
                    return nameKey($e['name']) !== nameKey($name);
                }));
                $d['entries'][] = ['name' => $name, 'points' => $points, 'timeMs' => $timeMs, 'score' => $score,
                                   'perfects' => $perfects, 't' => time()];
                usort($d['entries'], function ($a, $b) {
                    if (intval($b['score']) === intval($a['score'])) return intval($a['timeMs']) - intval($b['timeMs']);
                    return intval($b['score']) - intval($a['score']);
                });
                foreach ($d['entries'] as $i => $e) if (nameKey($e['name']) === nameKey($name)) return [$i + 1, true];
                return [null, true];
            });
            $hist['rank'] = is_int($rank) ? $rank : null;
            appendHistory($name, $hist);
            out(['ok' => true, 'saved' => true, 'daily' => $date, 'points' => $points, 'timeMs' => $timeMs, 'timedOut' => $timedOut,
                 'score' => $score, 'rank' => $hist['rank'], 'newBest' => false, 'best' => $score]);
        }
        $satCfg = $s['sat'] ?? null;
        if ($mode === 'satellite' && is_array($satCfg) && empty($satCfg['ranked'])) {
            // Ojo de Halcón con ajustes propios: se guarda en el perfil, pero no compite en el leaderboard.
            $hist['custom'] = true;
            $hist['sat'] = ['zoom' => intval($satCfg['zoom']), 'src' => strval($satCfg['src']), 'city' => intval($satCfg['city'])];
            appendHistory($name, $hist);
            out(['ok' => true, 'saved' => false, 'custom' => true, 'points' => $points, 'timeMs' => $timeMs,
                 'timedOut' => $timedOut, 'score' => $score,
                 'error' => 'Partida personalizada: se guardó en tu perfil. Solo la configuración estándar (280 m · 60 % centro / 40 % afuera) cuenta para el leaderboard.']);
        }
        $result = withJson(LEADERBOARD_FILE, [], function (&$lb) use ($key, $name, $points, $timeMs, $timeMax, $score, $mode) {
            if (!isset($lb[$key]) || !is_array($lb[$key])) $lb[$key] = [];
            $entry = ['name' => $name, 'points' => $points, 'timeMs' => $timeMs, 'timeMax' => $timeMax,
                      'score' => $score, 'gameMode' => $mode, 'date' => time(), 'games' => 1];
            $found = false;
            $newBest = false;
            $best = $score;
            foreach ($lb[$key] as $i => $e) {
                if (nameKey($e['name'] ?? '') === nameKey($name)) {
                    $found = true;
                    $games = intval($e['games'] ?? 1) + 1;
                    if ($score > intval($e['score'] ?? 0)) {
                        $entry['games'] = $games;
                        $lb[$key][$i] = $entry;
                        $newBest = true;
                    } else {
                        $lb[$key][$i]['games'] = $games;
                        $best = intval($e['score']);
                    }
                    break;
                }
            }
            if (!$found) {
                $lb[$key][] = $entry;
                $newBest = true;
            }
            usort($lb[$key], function ($a, $b) {
                if (intval($b['score']) === intval($a['score'])) return intval($a['timeMs']) - intval($b['timeMs']);
                return intval($b['score']) - intval($a['score']);
            });
            $lb[$key] = array_slice($lb[$key], 0, 100);
            $rank = null;
            foreach ($lb[$key] as $i => $e) {
                if (nameKey($e['name'] ?? '') === nameKey($name)) { $rank = $i + 1; break; }
            }
            return [['best' => $best, 'newBest' => $newBest, 'rank' => $rank], true];
        });
        if (isset($result['__error'])) fail('no se pudo guardar el puntaje');
        appendHistory($name, $hist);
        out(['ok' => true, 'saved' => true, 'points' => $points, 'timeMs' => $timeMs, 'timedOut' => $timedOut,
             'score' => $score, 'best' => $result['best'], 'newBest' => $result['newBest'], 'rank' => $result['rank']]);
    }

    /* ------------------- OJO DE HALCÓN (multijugador) ------------------- */
    case 'room-sat-start': {
        rateLimit('roomsat', 30, 3600);
        requireOpen();
        $host = requireUser(true);
        $rounds = intval(input('rounds', 5));
        if (!in_array($rounds, $ROUND_OPTIONS, true)) fail('rondas no válidas');
        $names = input('players', []);
        if (!is_array($names)) $names = [];
        $players = [nameKey($host)];
        foreach (array_slice($names, 0, 30) as $n) {
            $k = nameKey(is_string($n) ? $n : '');
            if ($k !== '' && !in_array($k, $players, true)) $players[] = $k;
        }
        $sat = satParams();
        $locs = pickSatLocations($rounds, $sat['pct']);
        if (count($locs) < $rounds) fail('no hay suficientes ubicaciones');
        $token = newToken();
        $session = [
            'kind' => 'room',
            'sat' => $sat,
            'host' => nameKey($host),
            'players' => $players,
            'mode' => 'satellite',
            'rounds' => $rounds,
            'locs' => $locs,
            'guesses' => [],
            'revealed' => [],
            'created' => time(),
            'ip' => clientIp(),
        ];
        withJson(SESSIONS_FILE, [], function (&$all) use ($token, $session) {
            cleanupSessions($all);
            $all[$token] = $session;
            return [true, true];
        });
        out(['ok' => true, 'token' => $token, 'rounds' => $rounds, 'sat' => $sat]);
    }

    case 'sat-image': {
        $token = str_in('t', 40);
        $round = intval(input('r', 0));
        $s = getSession($token);
        if (!$s || ($s['mode'] ?? '') !== 'satellite') fail('partida no encontrada', 404);
        if ($round < 1 || $round > intval($s['rounds'])) fail('ronda no válida', 404);
        if ($s['kind'] === 'solo') {
            if (!empty($s['done']) || $round !== intval($s['cur'])) fail('ronda no disponible', 403);
            // El reloj de la ronda empieza cuando la imagen está lista para entregarse.
            serveSatImageSolo($s, $token, $round);
        } else {
            $maxRevealed = 0;
            foreach (array_keys($s['revealed'] ?? []) as $r) $maxRevealed = max($maxRevealed, intval($r));
            if ($round > $maxRevealed + 1) fail('ronda no disponible', 403);
            serveSatImage($s, $token, $round);
        }
        break;
    }

    case 'sat-guess': {
        $name = requireUser(false);
        $token = str_in('token', 40);
        $round = intval(input('round', 0));
        $lat = input('lat', null);
        $lng = input('lng', null);
        if (!is_numeric($lat) || !is_numeric($lng) || abs((float)$lat) > 90 || abs((float)$lng) > 180) fail('chincheta no válida');
        $res = withJson(SESSIONS_FILE, [], function (&$all) use ($token, $round, $name, $lat, $lng) {
            if (!validToken($token) || !isset($all[$token])) return [['error' => 'partida no encontrada'], false];
            $s = &$all[$token];
            if (($s['kind'] ?? '') !== 'room') return [['error' => 'partida no válida'], false];
            $k = nameKey($name);
            if (!in_array($k, $s['players'], true)) return [['error' => 'no formas parte de esta partida'], false];
            if ($round < 1 || $round > intval($s['rounds'])) return [['error' => 'ronda no válida'], false];
            if (!empty($s['revealed'][(string)$round])) return [['error' => 'la ronda ya terminó', 'closed' => true], false];
            $dirty = false;
            if (!isset($s['guesses'][(string)$round][$k])) {
                $s['guesses'][(string)$round][$k] = ['lat' => round((float)$lat, 6), 'lng' => round((float)$lng, 6), 'ms' => nowMs()];
                $dirty = true;
            }
            return [['locked' => true], $dirty];
        });
        if (isset($res['__error'])) fail($res['__error']);
        if (isset($res['error'])) out(['ok' => false] + $res);
        out(['ok' => true] + $res);
    }

    case 'sat-reveal': {
        $name = requireUser(false);
        $token = str_in('token', 40);
        $round = intval(input('round', 0));
        $res = withJson(SESSIONS_FILE, [], function (&$all) use ($token, $round, $name) {
            if (!validToken($token) || !isset($all[$token])) return [['error' => 'partida no encontrada'], false];
            $s = &$all[$token];
            if (($s['kind'] ?? '') !== 'room') return [['error' => 'partida no válida'], false];
            // Sólo el anfitrión cierra la ronda; si aún no fijó chincheta, pierde su turno.
            if (nameKey($name) !== $s['host']) return [['error' => 'sólo el anfitrión puede cerrar la ronda'], false];
            if ($round < 1 || $round > intval($s['rounds'])) return [['error' => 'ronda no válida'], false];
            $s['revealed'][(string)$round] = nowMs();
            $c = locCoord($s['locs'][$round - 1]);
            if (!$c) return [['error' => 'ubicación no disponible'], false];
            $guesses = [];
            foreach (($s['guesses'][(string)$round] ?? []) as $k => $g) {
                $guesses[$k] = ['lat' => $g['lat'], 'lng' => $g['lng']];
            }
            return [['round' => $round, 'real' => ['lat' => $c['lat'], 'lng' => $c['lng']], 'guesses' => $guesses], true];
        });
        if (isset($res['__error'])) fail($res['__error']);
        if (isset($res['error'])) fail($res['error']);
        out(['ok' => true] + $res);
    }

    /* ------------------------ CUENTA Y PERFIL ------------------------ */
    case 'site-info': {
        $s = settings();
        out(['ok' => true, 'maintenance' => !empty($s['maintenance']), 'maintenanceMsg' => $s['maintenanceMsg'],
             'announcement' => (string)$s['announcement'], 'daily' => dailyConfig(dailyDate())]);
    }

    case 'account-info': {
        $name = requireUser(false);
        $users = loadJson(USERS_FILE, []);
        $u = $users[nameKey($name)] ?? [];
        out(['ok' => true, 'name' => $name, 'created' => intval($u['t'] ?? 0), 'hasPassword' => !empty($u['pw']),
             'hasRecovery' => !empty($u['rc']), 'devices' => count(userKeys($u))]);
    }

    case 'account-set-password': {
        rateLimit('pw', 20, 3600);
        $name = requireUser(false);
        $pw = (string)input('password', '');
        if (strlen($pw) < 6 || strlen($pw) > 72) fail('La contraseña debe tener entre 6 y 72 caracteres.');
        withJson(USERS_FILE, [], function (&$users) use ($name, $pw) {
            $users[nameKey($name)]['pw'] = password_hash($pw, PASSWORD_DEFAULT);
            return [true, true];
        });
        out(['ok' => true]);
    }

    case 'account-recovery-code': {
        rateLimit('rc', 10, 3600);
        $name = requireUser(false);
        $code = recoveryCode();
        withJson(USERS_FILE, [], function (&$users) use ($name, $code) {
            $users[nameKey($name)]['rc'] = password_hash(normalizeRecovery($code), PASSWORD_DEFAULT);
            return [true, true];
        });
        out(['ok' => true, 'code' => $code]);
    }

    case 'account-login': {
        // Iniciar sesión en otro dispositivo con contraseña o código de recuperación.
        rateLimit('acclogin', 10, 900);
        $name = normalizeName(str_in('name', 40));
        $newKey = str_in('key', 64);
        $pw = (string)input('password', '');
        $code = normalizeRecovery(input('code', ''));
        if ($name === '' || !validKey($newKey)) fail('Datos incompletos.');
        $res = withJson(USERS_FILE, [], function (&$users) use ($name, $newKey, $pw, $code) {
            $k = nameKey($name);
            if (!isset($users[$k])) return [['error' => 'Usuario o contraseña incorrectos.'], false];
            $u = &$users[$k];
            if (!empty($u['banned'])) return [['error' => 'Esta cuenta está suspendida.'], false];
            $okPw = $pw !== '' && !empty($u['pw']) && password_verify($pw, $u['pw']);
            $okCode = $code !== '' && !empty($u['rc']) && password_verify($code, $u['rc']);
            if (!$okPw && !$okCode) return [['error' => 'Usuario o contraseña incorrectos.'], false];
            addDeviceKey($u, keyHash($newKey));
            if ($okCode) unset($u['rc']); // el código de recuperación es de un solo uso
            $u['seen'] = time();
            return [['name' => $u['name'], 'usedCode' => $okCode], true];
        });
        if (isset($res['error'])) {
            securityLog('login fallido para "' . $name . '"');
            usleep(400000);
            fail($res['error'], 403);
        }
        out(['ok' => true] + $res);
    }

    case 'account-logout-others': {
        $name = requireUser(false);
        $key = str_in('key', 64);
        withJson(USERS_FILE, [], function (&$users) use ($name, $key) {
            $k = nameKey($name);
            $users[$k]['keys'] = [keyHash($key)];
            unset($users[$k]['kh']);
            return [true, true];
        });
        out(['ok' => true]);
    }

    case 'profile': {
        $name = normalizeName(str_in('name', 40));
        $users = loadJson(USERS_FILE, []);
        $u = $users[nameKey($name)] ?? null;
        if (!$u) fail('Jugador no encontrado.', 404);
        $h = loadJson(historyFile($name), ['games' => []]);
        $games = is_array($h['games'] ?? null) ? $h['games'] : [];
        out(['ok' => true, 'name' => $u['name'] ?? $name, 'created' => intval($u['t'] ?? 0), 'seen' => intval($u['seen'] ?? 0),
             'stats' => profileStats($games), 'recent' => array_reverse(array_slice($games, -40))]);
    }

    case 'profile-record-multi': {
        // Resultado de una partida multijugador para el historial (lo reporta el propio jugador).
        rateLimit('recmulti', 40, 3600);
        $name = requireUser(false);
        $mode = str_in('gameMode', 20);
        if (!in_array($mode, $GAME_MODES, true)) $mode = 'normal';
        appendHistory($name, [
            't' => time(), 'multi' => true, 'mode' => $mode,
            'rounds' => max(1, min(15, intval(input('rounds', 5)))),
            'score' => max(0, min(200000, intval(input('score', 0)))),
            'rank' => max(1, min(30, intval(input('rank', 1)))),
            'players' => max(2, min(30, intval(input('players', 2)))),
        ]);
        out(['ok' => true]);
    }

    /* ---------------------------- RETO DIARIO ---------------------------- */
    case 'daily-info': {
        $date = dailyDate();
        $cfg = dailyConfig($date);
        $d = loadJson(dailyFile($date), ['attempts' => [], 'entries' => []]);
        $name = normalizeName(str_in('name', 40));
        $mine = null;
        $played = false;
        if ($name !== '') {
            $k = nameKey($name);
            $played = isset($d['attempts'][$k]);
            foreach (($d['entries'] ?? []) as $i => $e) {
                if (nameKey($e['name']) === $k) { $mine = $e + ['rank' => $i + 1]; break; }
            }
        }
        $tomorrow = new DateTime('tomorrow', new DateTimeZone(DAILY_TZ));
        out(['ok' => true] + $cfg + ['played' => $played, 'mine' => $mine, 'players' => count($d['entries'] ?? []),
             'nextInSec' => max(0, $tomorrow->getTimestamp() - time())]);
    }

    case 'daily-leaderboard': {
        $date = str_in('date', 10);
        if (!validDate($date)) $date = dailyDate();
        $d = loadJson(dailyFile($date), ['entries' => []]);
        $dates = [];
        foreach (glob(DAILY_DIR . '/*.json') ?: [] as $f) $dates[] = basename($f, '.json');
        rsort($dates);
        $entries = array_map(function ($e) {
            return ['name' => $e['name'], 'points' => intval($e['points']), 'timeMs' => intval($e['timeMs']),
                    'score' => intval($e['score']), 'perfects' => intval($e['perfects'] ?? 0)];
        }, $d['entries'] ?? []);
        out(['ok' => true, 'date' => $date, 'mode' => dailyConfig($date)['mode'], 'entries' => $entries,
             'dates' => array_slice($dates, 0, 60)]);
    }

    /* ---------------------------- LEADERBOARD ---------------------------- */
    case 'leaderboard': {
        $rounds = intval(input('rounds', 5));
        if (!in_array($rounds, $ROUND_OPTIONS, true)) $rounds = 5;
        $mode = str_in('mode', 20);
        if (!in_array($mode, $SOLO_MODES, true)) $mode = 'normal';
        $lb = loadJson(LEADERBOARD_FILE, []);
        $entries = $lb[$mode . '_' . $rounds] ?? [];
        $outEntries = [];
        foreach ($entries as $e) {
            $outEntries[] = [
                'name' => (string)($e['name'] ?? ''),
                'points' => intval($e['points'] ?? 0),
                'timeMs' => intval($e['timeMs'] ?? 0),
                'score' => intval($e['score'] ?? 0),
                'games' => intval($e['games'] ?? 1),
                'date' => intval($e['date'] ?? 0),
            ];
        }
        out(['ok' => true, 'rounds' => $rounds, 'mode' => $mode, 'entries' => $outEntries]);
    }

    case 'save-score': {
        // Endpoint antiguo: el cliente ya no puede declarar su propio puntaje.
        fail('Actualiza la página (Shift + F5): los puntajes ahora se validan en el servidor.');
    }

    /* ------------------------- SALAS & MENSAJERÍA ------------------------ */
    case 'create': {
        rateLimit('create', 60, 3600);
        requireOpen();
        $id = roomId(input('id', ''));
        if ($id === '') fail('id requerido');
        $name = normalizeName(str_in('name', 40));
        if ($name === '') $name = 'Anónimo';
        $hostToken = substr(preg_replace('/[^A-Za-z0-9_\-]/', '', (string)input('hostToken', '')), 0, 64);
        $gameMode = str_in('gameMode', 20);
        if (!in_array($gameMode, $GAME_MODES, true)) $gameMode = 'normal';
        $room = [
            'name' => $name,
            'hostToken' => $hostToken,
            'limit' => max(2, min(25, intval(input('limit', 8)))),
            'count' => 1,
            'rounds' => in_array(intval(input('rounds', 5)), $ROUND_OPTIONS, true) ? intval(input('rounds', 5)) : 5,
            'gameMode' => $gameMode,
            'flashlightMode' => intval(input('flashlightMode', $gameMode === 'flashlight' ? 1 : 0)) ? 1 : 0,
            'temporalSeconds' => max(1, min(10, intval(input('temporalSeconds', 3)))),
            'tunnelSeconds' => max(2, min(15, intval(input('tunnelSeconds', 3)))),
            'blurSeconds' => max(2, min(15, intval(input('blurSeconds', 3)))),
            'raceDistance' => max(100, min(5000, intval(input('raceDistance', 1000)))),
            'raceSeconds' => max(30, min(600, intval(input('raceSeconds', 150)))),
            'satZoom' => satParams()['zoom'],
            'satSource' => satParams()['src'],
            'satCity' => satParams()['city'],
            'status' => 'waiting',
            'updated' => time(),
            'isPublic' => intval(input('isPublic', 1)) ? 1 : 0,
            'messages' => [],
            'lastSeq' => 0,
        ];
        $ok = withJson(ROOMS_FILE, [], function (&$rooms) use ($id, $room, $hostToken, $name) {
            cleanupRooms($rooms);
            $lower = nameKey($name);
            $generic = in_array($lower, ['anonimo', 'anónimo', 'invitado', 'player', 'jugador'], true);
            foreach ($rooms as $oldId => $old) {
                if ($oldId === $id) continue;
                if (($hostToken !== '' && ($old['hostToken'] ?? '') === $hostToken)
                    || (!$generic && nameKey($old['name'] ?? '') === $lower)) {
                    unset($rooms[$oldId]);
                }
            }
            $rooms[$id] = $room;
            if (count($rooms) > 300) return [false, false];
            return [true, true];
        });
        if ($ok !== true) fail('no se pudo crear la sala');
        out(['ok' => true]);
    }
    case 'update': {
        $id = roomId(input('id', ''));
        $count = intval(input('count', 0));
        $status = str_in('status', 20);
        if (!in_array($status, ['', 'waiting', 'in_progress', 'finished'], true)) $status = '';
        withJson(ROOMS_FILE, [], function (&$rooms) use ($id, $count, $status) {
            cleanupRooms($rooms);
            if (!isset($rooms[$id])) return [true, true];
            if ($count > 0) $rooms[$id]['count'] = max(1, min(30, $count));
            if ($status !== '') $rooms[$id]['status'] = $status;
            $rooms[$id]['updated'] = time();
            return [true, true];
        });
        out(['ok' => true]);
    }
    case 'delete': {
        $id = roomId(input('id', ''));
        withJson(ROOMS_FILE, [], function (&$rooms) use ($id) {
            if (!isset($rooms[$id])) return [true, false];
            unset($rooms[$id]);
            return [true, true];
        });
        out(['ok' => true]);
    }
    case 'check-room': {
        $id = roomId(input('id', ''));
        $rooms = loadJson(ROOMS_FILE, []);
        cleanupRooms($rooms);
        if ($id === '' || !isset($rooms[$id])) fail('sala no existe');
        $room = $rooms[$id];
        out(['ok' => true, 'id' => $id] + publicRoom($room));
    }
    case 'list': {
        $rooms = loadJson(ROOMS_FILE, []);
        cleanupRooms($rooms);
        uasort($rooms, function ($a, $b) { return intval($b['updated'] ?? 0) <=> intval($a['updated'] ?? 0); });
        $list = [];
        $seen = [];
        foreach ($rooms as $id => $room) {
            if (isset($room['isPublic']) && intval($room['isPublic']) === 0) continue;
            $tok = trim($room['hostToken'] ?? '');
            if ($tok !== '') {
                if (isset($seen[$tok])) continue;
                $seen[$tok] = true;
            }
            $list[] = ['id' => $id] + publicRoom($room);
        }
        out(['ok' => true, 'rooms' => $list]);
    }

    case 'send-msg': {
        $id = roomId(input('id', ''));
        $from = substr((string)input('from', ''), 0, 96);
        $to = substr((string)input('to', 'all'), 0, 96);
        $payload = (string)input('payload', '');
        if ($id === '' || trim($payload) === '') fail('id y payload requeridos');
        if (strlen($payload) > 16384) fail('mensaje demasiado grande');
        $seq = withJson(ROOMS_FILE, [], function (&$rooms) use ($id, $from, $to, $payload) {
            if (!isset($rooms[$id])) {
                if (strpos($payload, '"hostLeft"') !== false) return [0, false];
                $rooms[$id] = ['name' => 'Sala ' . substr($id, -4), 'limit' => 12, 'count' => 1, 'status' => 'waiting',
                               'updated' => time(), 'isPublic' => 0, 'messages' => [], 'lastSeq' => 0];
            }
            if (!isset($rooms[$id]['messages']) || !is_array($rooms[$id]['messages'])) {
                $rooms[$id]['messages'] = [];
                $rooms[$id]['lastSeq'] = 0;
            }
            $now = time();
            $rooms[$id]['lastSeq'] = intval($rooms[$id]['lastSeq'] ?? 0) + 1;
            $seq = $rooms[$id]['lastSeq'];
            $rooms[$id]['messages'][] = ['seq' => $seq, 'from' => $from, 'to' => $to, 'payload' => $payload, 'time' => $now];
            $msgs = array_slice($rooms[$id]['messages'], -120);
            $rooms[$id]['messages'] = array_values(array_filter($msgs, function ($m) use ($now) {
                return ($now - intval($m['time'] ?? 0)) < 60;
            }));
            $rooms[$id]['updated'] = $now;
            return [$seq, true];
        });
        out(['ok' => true, 'seq' => $seq]);
    }

    case 'poll-msgs': {
        $id = roomId(input('id', ''));
        $peerId = substr((string)input('peerId', ''), 0, 96);
        $since = intval(input('since', 0));
        $rooms = loadJson(ROOMS_FILE, []);
        if ($id === '' || !isset($rooms[$id])) fail('sala no existe');
        if (time() - intval($rooms[$id]['updated'] ?? 0) >= 10) {
            withJson(ROOMS_FILE, [], function (&$rs) use ($id) {
                if (!isset($rs[$id])) return [true, false];
                $rs[$id]['updated'] = time();
                return [true, true];
            });
        }
        $out = [];
        $maxSeq = $since;
        foreach (($rooms[$id]['messages'] ?? []) as $m) {
            $s = intval($m['seq']);
            if ($s <= $since) continue;
            if ($m['from'] !== $peerId && ($m['to'] === 'all' || $m['to'] === $peerId)) {
                $out[] = ['seq' => $s, 'from' => $m['from'], 'payload' => $m['payload']];
            }
            if ($s > $maxSeq) $maxSeq = $s;
        }
        out(['ok' => true, 'messages' => $out, 'lastSeq' => $maxSeq]);
    }

    default:
        fail('acción no válida');
}

function publicRoom($room) {
    $mode = strval($room['gameMode'] ?? 'normal');
    return [
        'name' => strval($room['name'] ?? ''),
        'limit' => intval($room['limit'] ?? 0),
        'count' => intval($room['count'] ?? 0),
        'rounds' => intval($room['rounds'] ?? 5),
        'gameMode' => $mode,
        'flashlightMode' => intval($room['flashlightMode'] ?? ($mode === 'flashlight' ? 1 : 0)),
        'temporalSeconds' => intval($room['temporalSeconds'] ?? 3),
        'tunnelSeconds' => intval($room['tunnelSeconds'] ?? 3),
        'blurSeconds' => intval($room['blurSeconds'] ?? 3),
        'raceDistance' => intval($room['raceDistance'] ?? 1000),
        'raceSeconds' => intval($room['raceSeconds'] ?? 150),
        'satZoom' => intval($room['satZoom'] ?? SAT_STD_ZOOM),
        'satSource' => strval($room['satSource'] ?? 'both'),
        'satCity' => intval($room['satCity'] ?? SAT_STD_CITY),
        'status' => strval($room['status'] ?? 'waiting'),
    ];
}

/** Solitario satelital: entrega la imagen y arranca el reloj de la ronda. */
function serveSatImageSolo($session, $token, $round) {
    $file = satImagePath($session, $token, $round);
    withJson(SESSIONS_FILE, [], function (&$all) use ($token, $round) {
        if (!isset($all[$token])) return [true, false];
        if (isset($all[$token]['served'][(string)$round])) return [true, false];
        $all[$token]['served'][(string)$round] = nowMs();
        return [true, true];
    });
    outputJpeg($file);
}
