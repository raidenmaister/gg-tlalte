<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$roomsFile = __DIR__ . '/rooms.json';
$usersFile = __DIR__ . '/users.json';
$leaderboardFile = __DIR__ . '/leaderboard.json';

$rawInput = @file_get_contents('php://input');
if ($rawInput) {
    $jsonData = @json_decode($rawInput, true);
    if (is_array($jsonData)) {
        $_POST = array_merge($_POST, $jsonData);
    }
}

$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');
$staleSeconds = 15;

if (!function_exists('loadJson')) {
    function loadJson($file, $default = []) {
        if (!file_exists($file)) return $default;
        $raw = @file_get_contents($file);
        if ($raw === false || trim($raw) === '') {
            usleep(8000);
            $raw = @file_get_contents($file);
        }
        $data = json_decode($raw, true);
        return is_array($data) ? $data : $default;
    }
}

if (!function_exists('saveJson')) {
    function saveJson($file, $data) {
        $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        $temp = $file . '.' . uniqid('tmp_', true);
        if (@file_put_contents($temp, $json, LOCK_EX) !== false) {
            if (@rename($temp, $file)) {
                return true;
            }
            @unlink($temp);
        }
        return @file_put_contents($file, $json, LOCK_EX) !== false;
    }
}

if (!function_exists('loadRooms')) {
    function loadRooms($file) {
        return loadJson($file, []);
    }
}

if (!function_exists('saveRooms')) {
    function saveRooms($file, $rooms) {
        return saveJson($file, $rooms);
    }
}

if (!function_exists('cleanupRooms')) {
    function cleanupRooms($rooms, $staleSeconds) {
        $now = time();
        foreach ($rooms as $id => $room) {
            $threshold = ($room['status'] ?? '') === 'in_progress' ? 90 : max(45, $staleSeconds);
            if ($now - intval($room['updated'] ?? 0) > $threshold) {
                unset($rooms[$id]);
            }
        }
        return $rooms;
    }
}

/** Puntuación del leaderboard: prima la precisión y ajusta por velocidad. */
if (!function_exists('leaderScore')) {
    function leaderScore($rounds, $points, $timeMs, $timeMaxSec, $mode = 'normal') {
        $maxPerRound = in_array($mode, ['tunnel', 'static_tunnel', 'blur', 'static_blur'], true) ? 6500 : 5000;
        $maxPoints = max(1, $rounds * $maxPerRound);
        $points = max(0, min(intval($points), $maxPoints));
        $timeMaxMs = max(1, intval($timeMaxSec) * 1000);
        $timeRatio = min(1, max(0, intval($timeMs) / $timeMaxMs));
        // Factor velocidad entre 0.5 (límite de tiempo) y 1.0 (instantáneo).
        $speedFactor = 1 - 0.5 * $timeRatio;
        return round($points * $speedFactor * 10);
    }
}

if (!function_exists('soloTimeMax')) {
    function soloTimeMax($rounds, $gameMode = 'normal') {
        $map = [5 => 105, 7 => 120, 10 => 150, 15 => 210];
        $base = isset($map[$rounds]) ? $map[$rounds] : 105;
        if (in_array($gameMode, ['tunnel', 'static_tunnel', 'blur', 'static_blur'], true)) {
            $base += 60;
        }
        return $base;
    }
}

if (!function_exists('normalizeName')) {
    function normalizeName($name) {
        $name = trim((string)$name);
        $name = preg_replace('/\s+/u', ' ', $name);
        return function_exists('mb_substr') ? mb_substr($name, 0, 20) : substr($name, 0, 20);
    }
}

if (!function_exists('sameName')) {
    function sameName($a, $b) {
        if (function_exists('mb_strtolower')) {
            return mb_strtolower($a) === mb_strtolower($b);
        }
        return strcasecmp($a, $b) === 0;
    }
}

if (!function_exists('userExists')) {
    function userExists($users, $name) {
        $name = normalizeName($name);
        if ($name === '') return true; // nombre vacío no se permite
        foreach ($users as $existing) {
            if (sameName($existing, $name)) return true;
        }
        return false;
    }
}

$staleSeconds = 600; // 10 minutos de gracia para no purgar salas activas

$rooms = cleanupRooms(loadRooms($roomsFile), $staleSeconds);
$users = loadJson($usersFile, []);
$leaderboard = loadJson($leaderboardFile, ['5' => [], '7' => [], '10' => []]);

switch ($action) {
    /* --------------------------- SALAS & MENSAJERÍA --------------------------- */
    case 'create': {
        $id = trim($_POST['id'] ?? '');
        $name = trim($_POST['name'] ?? 'Anónimo');
        $limit = intval($_POST['limit'] ?? 0);
        $isPublic = isset($_POST['isPublic']) ? intval($_POST['isPublic']) : 1;
        $rounds = intval($_POST['rounds'] ?? 5);
        $gameMode = trim($_POST['gameMode'] ?? 'normal');
        if (!in_array($gameMode, ['normal', 'static', 'temporal', 'tunnel', 'static_tunnel', 'blur', 'static_blur'], true)) {
            $gameMode = 'normal';
        }
        $temporalSeconds = intval($_POST['temporalSeconds'] ?? 3);
        $tunnelSeconds = intval($_POST['tunnelSeconds'] ?? 3);
        $blurSeconds = intval($_POST['blurSeconds'] ?? 3);
        if ($id === '') {
            echo json_encode(['ok' => false, 'error' => 'id requerido']);
            exit;
        }
        $rooms[$id] = [
            'name' => $name,
            'limit' => $limit,
            'count' => 1,
            'rounds' => $rounds,
            'gameMode' => $gameMode,
            'temporalSeconds' => $temporalSeconds,
            'tunnelSeconds' => $tunnelSeconds,
            'blurSeconds' => $blurSeconds,
            'status' => 'waiting',
            'updated' => time(),
            'isPublic' => $isPublic,
            'messages' => [],
            'lastSeq' => 0,
        ];
        if (!saveRooms($roomsFile, $rooms)) {
            echo json_encode(['ok' => false, 'error' => 'no se pudo escribir rooms.json']);
            exit;
        }
        echo json_encode(['ok' => true]);
        break;
    }
    case 'update': {
        $id = trim($_POST['id'] ?? '');
        $count = isset($_POST['count']) ? intval($_POST['count']) : 0;
        $status = trim($_POST['status'] ?? '');
        if (isset($rooms[$id])) {
            if ($count > 0) {
                $rooms[$id]['count'] = max(1, $count);
            }
            if ($status !== '') {
                $rooms[$id]['status'] = $status;
            }
            $rooms[$id]['updated'] = time();
            saveRooms($roomsFile, $rooms);
        }
        echo json_encode(['ok' => true]);
        break;
    }
    case 'delete': {
        $id = trim($_POST['id'] ?? '');
        unset($rooms[$id]);
        saveRooms($roomsFile, $rooms);
        echo json_encode(['ok' => true]);
        break;
    }
    case 'check-room': {
        $id = trim($_GET['id'] ?? $_POST['id'] ?? '');
        if ($id === '' || !isset($rooms[$id])) {
            echo json_encode(['ok' => false, 'error' => 'sala no existe']);
            exit;
        }
        $room = $rooms[$id];
        echo json_encode([
            'ok' => true,
            'id' => $id,
            'name' => strval($room['name'] ?? ''),
            'limit' => intval($room['limit'] ?? 0),
            'count' => intval($room['count'] ?? 0),
            'status' => strval($room['status'] ?? 'waiting'),
            'gameMode' => strval($room['gameMode'] ?? 'normal'),
            'rounds' => intval($room['rounds'] ?? 5),
            'temporalSeconds' => intval($room['temporalSeconds'] ?? 3),
            'tunnelSeconds' => intval($room['tunnelSeconds'] ?? 3),
            'blurSeconds' => intval($room['blurSeconds'] ?? 3),
        ]);
        break;
    }
    case 'list': {
        $out = [];
        foreach ($rooms as $id => $room) {
            // No listar salas privadas en el listado público
            if (isset($room['isPublic']) && intval($room['isPublic']) === 0) continue;
            $out[] = [
                'id' => $id,
                'name' => $room['name'],
                'limit' => intval($room['limit']),
                'count' => intval($room['count']),
                'rounds' => intval($room['rounds'] ?? 5),
                'gameMode' => strval($room['gameMode'] ?? 'normal'),
                'temporalSeconds' => intval($room['temporalSeconds'] ?? 3),
                'tunnelSeconds' => intval($room['tunnelSeconds'] ?? 3),
                'blurSeconds' => intval($room['blurSeconds'] ?? 3),
                'status' => strval($room['status'] ?? 'waiting'),
            ];
        }
        echo json_encode(['ok' => true, 'rooms' => $out]);
        break;
    }

    case 'send-msg': {
        $id = trim($_POST['id'] ?? '');
        $from = trim($_POST['from'] ?? '');
        $to = trim($_POST['to'] ?? 'all');
        $payload = trim($_POST['payload'] ?? '');

        if ($id === '' || $payload === '') {
            echo json_encode(['ok' => false, 'error' => 'id y payload requeridos']);
            exit;
        }

        // Si la sala no existe en rooms.json, no re-crearla si es mensaje de cierre
        if (!isset($rooms[$id])) {
            if (strpos($payload, '"hostLeft"') !== false) {
                echo json_encode(['ok' => true]);
                exit;
            }
            $rooms[$id] = [
                'name' => 'Sala ' . substr($id, -4),
                'limit' => 12,
                'count' => 1,
                'status' => 'waiting',
                'updated' => time(),
                'isPublic' => 0,
                'messages' => [],
                'lastSeq' => 0,
            ];
        }

        if (!isset($rooms[$id]['messages']) || !is_array($rooms[$id]['messages'])) {
            $rooms[$id]['messages'] = [];
            $rooms[$id]['lastSeq'] = 0;
        }

        $rooms[$id]['lastSeq'] = intval($rooms[$id]['lastSeq'] ?? 0) + 1;
        $seq = $rooms[$id]['lastSeq'];
        $now = time();

        $rooms[$id]['messages'][] = [
            'seq' => $seq,
            'from' => $from,
            'to' => $to,
            'payload' => $payload,
            'time' => $now,
        ];

        // Conservar los últimos 120 mensajes para soportar hasta 25 jugadores y purgar los de más de 60 segundos
        if (count($rooms[$id]['messages']) > 120) {
            $rooms[$id]['messages'] = array_slice($rooms[$id]['messages'], -120);
        }
        $rooms[$id]['messages'] = array_values(array_filter($rooms[$id]['messages'], function ($m) use ($now) {
            return ($now - intval($m['time'] ?? 0)) < 60;
        }));

        $rooms[$id]['updated'] = $now;
        saveRooms($roomsFile, $rooms);

        echo json_encode(['ok' => true, 'seq' => $seq]);
        break;
    }

    case 'poll-msgs': {
        $id = trim($_GET['id'] ?? $_POST['id'] ?? '');
        $peerId = trim($_GET['peerId'] ?? $_POST['peerId'] ?? '');
        $since = intval($_GET['since'] ?? $_POST['since'] ?? 0);

        if ($id === '' || !isset($rooms[$id])) {
            echo json_encode(['ok' => false, 'error' => 'sala no existe']);
            exit;
        }

        // Mantener viva la sala sin sobrecargar escrituras en disco en cada lectura frecuente
        $now = time();
        if (($now - intval($rooms[$id]['updated'] ?? 0)) >= 10) {
            $rooms[$id]['updated'] = $now;
            saveRooms($roomsFile, $rooms);
        }

        $msgs = isset($rooms[$id]['messages']) && is_array($rooms[$id]['messages'])
            ? $rooms[$id]['messages']
            : [];

        $out = [];
        $maxSeq = $since;
        foreach ($msgs as $m) {
            $s = intval($m['seq']);
            if ($s > $since) {
                // Filtrar para mí: si no soy yo el emisor, y va para 'all' o va para mí
                if ($m['from'] !== $peerId && ($m['to'] === 'all' || $m['to'] === $peerId)) {
                    $out[] = [
                        'seq' => $s,
                        'from' => $m['from'],
                        'payload' => $m['payload'],
                    ];
                }
                if ($s > $maxSeq) $maxSeq = $s;
            }
        }

        echo json_encode(['ok' => true, 'messages' => $out, 'lastSeq' => $maxSeq]);
        break;
    }

    /* --------------------------- USUARIOS --------------------------- */
    case 'check-name': {
        $name = normalizeName($_POST['name'] ?? '');
        echo json_encode([
            'ok' => true,
            'available' => $name !== '' && !userExists($users, $name),
            'name' => $name,
        ]);
        break;
    }
    case 'register-name': {
        $name = normalizeName($_POST['name'] ?? '');
        if ($name === '' || userExists($users, $name)) {
            echo json_encode(['ok' => false, 'error' => 'nombre no disponible']);
            exit;
        }
        $users[] = $name;
        if (!saveJson($usersFile, $users)) {
            echo json_encode(['ok' => false, 'error' => 'no se pudo guardar el nombre']);
            exit;
        }
        echo json_encode(['ok' => true, 'name' => $name]);
        break;
    }

    /* --------------------------- LEADERBOARD --------------------------- */
    case 'save-score': {
        $name = normalizeName($_POST['name'] ?? '');
        $rounds = intval($_POST['rounds'] ?? 0);
        $points = intval($_POST['points'] ?? 0);
        $timeMs = intval($_POST['timeMs'] ?? 0);

        if (!in_array($rounds, [5, 7, 10, 15], true)) {
            echo json_encode(['ok' => false, 'error' => 'rondas no válidas']);
            exit;
        }
        if ($name === '' || !userExists($users, $name)) {
            echo json_encode(['ok' => false, 'error' => 'usuario no registrado']);
            exit;
        }

        $gameMode = trim($_POST['gameMode'] ?? 'normal');
        if (!in_array($gameMode, ['normal', 'static', 'temporal', 'tunnel', 'static_tunnel', 'blur', 'static_blur'], true)) {
            $gameMode = 'normal';
        }
        $timeMax = soloTimeMax($rounds, $gameMode);

        $key = $gameMode . '_' . $rounds;
        if (!isset($leaderboard[$key]) || !is_array($leaderboard[$key])) {
            $leaderboard[$key] = [];
        }

        $newScore = leaderScore($rounds, $points, $timeMs, $timeMax, $gameMode);
        $entry = [
            'name' => $name,
            'points' => $points,
            'timeMs' => $timeMs,
            'timeMax' => $timeMax,
            'score' => $newScore,
            'gameMode' => $gameMode,
            'date' => time(),
        ];

        // Conserva solo la mejor puntuación de cada usuario en esta categoría.
        $replaced = false;
        foreach ($leaderboard[$key] as $i => $existing) {
            if (sameName($existing['name'] ?? '', $name)) {
                if ($newScore > intval($existing['score'] ?? 0)) {
                    $leaderboard[$key][$i] = $entry;
                }
                $replaced = true;
                break;
            }
        }
        if (!$replaced) {
            $leaderboard[$key][] = $entry;
        }

        // Ordena por score desc, luego tiempo asc, y conserva los 100 mejores.
        usort($leaderboard[$key], function ($a, $b) {
            if ($b['score'] === $a['score']) return $a['timeMs'] - $b['timeMs'];
            return $b['score'] - $a['score'];
        });
        $leaderboard[$key] = array_slice($leaderboard[$key], 0, 100);

        if (!saveJson($leaderboardFile, $leaderboard)) {
            echo json_encode(['ok' => false, 'error' => 'no se pudo guardar el score']);
            exit;
        }
        echo json_encode(['ok' => true, 'score' => $entry['score']]);
        break;
    }
    case 'leaderboard': {
        $rounds = intval($_GET['rounds'] ?? $_POST['rounds'] ?? 5);
        if (!in_array($rounds, [5, 7, 10, 15], true)) $rounds = 5;
        $gameMode = trim($_GET['mode'] ?? $_POST['mode'] ?? 'normal');
        if (!in_array($gameMode, ['normal', 'static', 'temporal', 'tunnel', 'static_tunnel', 'blur', 'static_blur'], true)) {
            $gameMode = 'normal';
        }
        $key = $gameMode . '_' . $rounds;

        // Soporte retrocompatible para puntuaciones previas
        $entries = [];
        $actualKey = $key;
        if (isset($leaderboard[$key]) && is_array($leaderboard[$key])) {
            $entries = $leaderboard[$key];
        } elseif ($gameMode === 'normal' && isset($leaderboard[(string)$rounds]) && is_array($leaderboard[(string)$rounds])) {
            $entries = $leaderboard[(string)$rounds];
            $actualKey = (string)$rounds;
        }

        // Calibrar/normalizar puntuaciones según el tiempo límite oficial actual de la categoría
        $timeMax = soloTimeMax($rounds, $gameMode);
        $dirty = false;
        foreach ($entries as $i => &$entry) {
            $pts = intval($entry['points'] ?? 0);
            $tMs = intval($entry['timeMs'] ?? 0);
            $expectedScore = leaderScore($rounds, $pts, $tMs, $timeMax, $gameMode);
            if (!isset($entry['timeMax']) || intval($entry['timeMax']) !== $timeMax || intval($entry['score'] ?? 0) !== $expectedScore) {
                $entry['timeMax'] = $timeMax;
                $entry['score'] = $expectedScore;
                $dirty = true;
            }
        }
        unset($entry);

        if ($dirty) {
            usort($entries, function ($a, $b) {
                if ($b['score'] === $a['score']) return $a['timeMs'] - $b['timeMs'];
                return $b['score'] - $a['score'];
            });
            $leaderboard[$actualKey] = $entries;
            saveJson($leaderboardFile, $leaderboard);
        }

        echo json_encode(['ok' => true, 'rounds' => $rounds, 'mode' => $gameMode, 'entries' => $entries]);
        break;
    }

    default: {
        echo json_encode(['ok' => false, 'error' => 'acción no válida']);
    }
}
