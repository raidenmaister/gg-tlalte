<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$roomsFile = __DIR__ . '/rooms.json';
$usersFile = __DIR__ . '/users.json';
$leaderboardFile = __DIR__ . '/leaderboard.json';

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

$rooms = cleanupRooms(loadRooms($roomsFile), $staleSeconds);
$users = loadJson($usersFile, []);
$leaderboard = loadJson($leaderboardFile, ['5' => [], '7' => [], '10' => []]);

switch ($action) {
    /* --------------------------- SALAS --------------------------- */
    case 'create': {
        $id = trim($_POST['id'] ?? '');
        $name = trim($_POST['name'] ?? 'Anónimo');
        $limit = intval($_POST['limit'] ?? 0);
        if ($id === '') {
            echo json_encode(['ok' => false, 'error' => 'id requerido']);
            exit;
        }
        $rooms[$id] = [
            'name' => $name,
            'limit' => $limit,
            'count' => 1,
            'updated' => time(),
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
