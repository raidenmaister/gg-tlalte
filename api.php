<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$dataFile = __DIR__ . '/rooms.json';
$action = isset($_GET['action']) ? $_GET['action'] : (isset($_POST['action']) ? $_POST['action'] : '');
$staleSeconds = 15;

function loadRooms($file) {
    if (!file_exists($file)) return [];
    $raw = @file_get_contents($file);
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function saveRooms($file, $rooms) {
    $result = @file_put_contents($file, json_encode($rooms), LOCK_EX);
    return $result !== false;
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

$rooms = loadRooms($dataFile);
$rooms = cleanupRooms($rooms, $staleSeconds);

switch ($action) {
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
        if (!saveRooms($dataFile, $rooms)) {
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
            saveRooms($dataFile, $rooms);
        }
        echo json_encode(['ok' => true]);
        break;
    }
    case 'delete': {
        $id = trim($_POST['id'] ?? '');
        unset($rooms[$id]);
        saveRooms($dataFile, $rooms);
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
    default: {
        echo json_encode(['ok' => false, 'error' => 'acción no válida']);
    }
}
