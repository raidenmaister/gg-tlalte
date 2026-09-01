# gg-tlalte

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View.
Hecho solo con HTML, CSS, JavaScript, PHP y [PeerJS](https://peerjs.com) (sin frameworks).

## Características

- Pantalla de bienvenida que pide el nombre del jugador (se guarda en `localStorage`).
- Menú de modos: **crear sala**, **unirse a sala** y **jugar en solitario**.
- Salas **públicas** (sin código, aparecen en una lista) y **privadas** (con código de 4 caracteres).
- Límite de jugadores configurable al crear la sala: 2, 3, 5, 7 o infinito.
- Lobby con la lista de jugadores conectados, el anfitrión marcado y contador `jugadores / límite`.
- Panorámicas 360° navegables (arrastrar para rotar, flechas o scroll para moverse por la calle).
- Interfaz responsive: se adapta desde pantallas muy pequeñas hasta pantallas muy grandes.

## Estructura

```
gg-tlalte/
├── index.html   # Estructura de la página
├── style.css    # Estilos
├── script.js    # Lógica del juego y del multijugador (PeerJS)
├── api.php      # Backend PHP: registro/lista de salas públicas
└── rooms.json   # Almacenamiento de las salas públicas
```

## Cómo funciona el multijugador

- La comunicación entre jugadores es **P2P con PeerJS**: el anfitrión abre un `Peer` y los
  demás se conectan a él con `peer.connect(id)`.
- **Salas privadas**: el `id` del Peer es el código de 4 caracteres que se comparte.
- **Salas públicas**: el `id` es un string interno de 8 caracteres que nunca se muestra.
  `api.php` registra la sala (con nombre, límite y jugadores) en `rooms.json`; los jugadores
  ven la lista de salas públicas y se unen a la que quieran. El anfitrión hace un *heartbeat*
  cada 5 s para mantener la sala activa (las salas se borran tras 15 s sin actividad).

`api.php` expone estas acciones:

- `?action=list` — lista de salas públicas activas.
- `POST action=create` (`id`, `name`, `limit`) — registra una sala.
- `POST action=update` (`id`, `count`) — actualiza el nº de jugadores (heartbeat).
- `POST action=delete` (`id`) — elimina una sala.

## Uso local

1. Clona el repositorio:

   ```bash
   git clone https://github.com/raidenmaister/gg-tlalte.git
   ```

2. Coloca tu archivo `coordenadas_validas.json` en la raíz con el formato:

   ```json
   [
     {
       "lat": 21.77071322490846,
       "lng": -103.2842473670169,
       "pano_id": "rN89gpZf7j3437qMq8OoiQ",
       "date": "2024-04"
     }
   ]
   ```

3. Sirve el proyecto con un servidor local (necesario para `fetch`):

   ```bash
   python -m http.server 8000
   ```

4. Abre `http://localhost:8000` e introduce tu API Key de Google Maps cuando se te solicite.

> Las salas públicas requieren un servidor con PHP. En local, `python -m http.server`
> no ejecuta `api.php`, así que solo funcionarán las salas privadas y el modo solitario.
> Para probar las públicas, despliega en un hosting con PHP (por ejemplo, InfinityFree).

## Despliegue en hosting con PHP

1. Sube todos los archivos a la raíz web (`htdocs`).
2. Asegúrate de que PHP pueda escribir en `rooms.json` (permisos `666` o `777` según el host).
3. Restringe la API Key de Google Maps a tu dominio.

## API Key

La API Key **no** está incluida en el código. Necesitas una key de la
[Google Maps JavaScript API](https://console.cloud.google.com/apis/credentials).

Puedes introducirla de dos formas:

- Al abrir el juego, se te pedirá mediante un diálogo.
- Pegándola directamente en la constante `API_KEY` dentro de `script.js`.

Restringe la key a tu dominio o a `localhost` desde la consola de Google Cloud.
