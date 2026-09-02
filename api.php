<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
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
        $_POST = array_merge($jsonData, $_POST);
    }
}

$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');
$staleSeconds = 15;

function loadJson($file, $default = []) {
    if (!file_exists($file)) return $default;
    $raw = @file_get_contents($file);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $default;
}

function saveJson($file, $data) {
    return @file_put_contents($file, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX) !== false;
}

function loadRooms($file) {
    return loadJson($file, []);
}

function saveRooms($file, $rooms) {
    return saveJson($file, $rooms);
}

function cleanupRooms($rooms, $staleSeconds) {
    $now = time();
    foreach ($rooms as $id => $room) {
        if ($now - intval($room['updated'] ?? 0) > $staleSeconds) {
            unset($rooms[$id]);
        }
    }
    return $rooms;
}

/** Puntuación del leaderboard: prima la precisión y ajusta por velocidad. */
function leaderScore($rounds, $points, $timeMs, $timeMaxSec) {
    $maxPoints = max(1, $rounds * 5000);
    $points = max(0, min(intval($points), $maxPoints));
    $timeMaxMs = max(1, intval($timeMaxSec) * 1000);
    $timeRatio = min(1, max(0, intval($timeMs) / $timeMaxMs));
    // Factor velocidad entre 0.5 (límite de tiempo) y 1.0 (instantáneo).
    $speedFactor = 1 - 0.5 * $timeRatio;
    return round($points * $speedFactor * 10);
}

function soloTimeMax($rounds) {
    $map = [5 => 105, 7 => 120, 10 => 150];
    return isset($map[$rounds]) ? $map[$rounds] : 105;
}

function normalizeName($name) {
    $name = trim((string)$name);
    $name = preg_replace('/\s+/u', ' ', $name);
    return function_exists('mb_substr') ? mb_substr($name, 0, 20) : substr($name, 0, 20);
}

function sameName($a, $b) {
    if (function_exists('mb_strtolower')) {
        return mb_strtolower($a) === mb_strtolower($b);
    }
    return strcasecmp($a, $b) === 0;
}

function userExists($users, $name) {
    $name = normalizeName($name);
    if ($name === '') return true; // nombre vacío no se permite
    foreach ($users as $existing) {
        if (sameName($existing, $name)) return true;
    }
    return false;
}

$staleSeconds = 30;

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
        if ($id === '') {
            echo json_encode(['ok' => false, 'error' => 'id requerido']);
            exit;
        }
        $rooms[$id] = [
            'name' => $name,
            'limit' => $limit,
            'count' => 1,
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
        $count = intval($_POST['count'] ?? 0);
        if (isset($rooms[$id])) {
            $rooms[$id]['count'] = max(1, $count);
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

        // Si la sala no existe en rooms.json (por ejemplo privada), inicializarla
        if (!isset($rooms[$id])) {
            $rooms[$id] = [
                'name' => 'Sala ' . substr($id, -4),
                'limit' => 12,
                'count' => 1,
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

        // Conservar solo los últimos 60 mensajes y purgar los de más de 60 segundos
        if (count($rooms[$id]['messages']) > 60) {
            $rooms[$id]['messages'] = array_slice($rooms[$id]['messages'], -60);
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

        // Mantener viva la sala
        $rooms[$id]['updated'] = time();
        saveRooms($roomsFile, $rooms);

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
        $timeMax = soloTimeMax($rounds);

        if (!in_array($rounds, [5, 7, 10], true)) {
            echo json_encode(['ok' => false, 'error' => 'rondas no válidas']);
            exit;
        }
        if ($name === '' || !userExists($users, $name)) {
            echo json_encode(['ok' => false, 'error' => 'usuario no registrado']);
            exit;
        }

        $key = (string)$rounds;
        if (!isset($leaderboard[$key]) || !is_array($leaderboard[$key])) {
            $leaderboard[$key] = [];
        }

        $newScore = leaderScore($rounds, $points, $timeMs, $timeMax);
        $entry = [
            'name' => $name,
            'points' => $points,
            'timeMs' => $timeMs,
            'timeMax' => $timeMax,
            'score' => $newScore,
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
        if (!in_array($rounds, [5, 7, 10], true)) $rounds = 5;
        $key = (string)$rounds;
        $entries = isset($leaderboard[$key]) && is_array($leaderboard[$key])
            ? $leaderboard[$key]
            : [];
        echo json_encode(['ok' => true, 'rounds' => $rounds, 'entries' => $entries]);
        break;
    }

    default: {
        echo json_encode(['ok' => false, 'error' => 'acción no válida']);
    }
}
