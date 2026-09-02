# GG-TLALTE

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View, inspirado en GeoGuessr. Incluye modo solitario con leaderboard y partidas multijugador P2P de hasta 12 jugadores.

## Características

- **Modo solitario**: elige 5, 7 o 10 rondas, con tiempo global para toda la partida.
  - 5 rondas → 1:45
  - 7 rondas → 2:00
  - 10 rondas → 2:30
- **Leaderboard de solitario** separado en categorías de 5, 7 y 10 rondas.
- **Puntuación equilibrada**: combina precisión (5000 pts por ronda) y velocidad, para que un intento rápido pero impreciso no quede por encima de uno acertado.
- **Nombres de usuario únicos** (no repetidos, insensibles a mayúsculas/minúsculas).
- **Partidas multijugador P2P** con PeerJS, de 2 a 12 jugadores:
  - Salas privadas con código de 4 caracteres.
  - Salas públicas con listado y heartbeat.
  - Resultados sobre minimapa a pantalla completa: chincheta real y de cada jugador, con su nombre y conectadas por líneas.
  - Barras de vida por jugador con previsualización de daño y color según la vida restante (verde, amarillo o rojo).
- **Backend PHP** que persiste usuarios, salas y leaderboard en archivos JSON (sin base de datos).

## Estructura

```
gg-tlalte/
├── index.html           # Estructura de la página
├── style.css            # Estilos
├── api.php              # Backend PHP (salas, usuarios, leaderboard)
├── rooms.json           # Salas públicas (plantilla)
├── coordenadas_validas.json
└── js/
    ├── app.js           # Punto de entrada y UI
    ├── game.js          # Máquina de estados del juego
    ├── net.js           # Capa de red PeerJS
    ├── panorama.js      # Visor Street View
    ├── minimap.js       # Minimapa Leaflet
    ├── config.js        # Constantes y reglas
    ├── audio.js
    └── utils.js
```

Los archivos auxiliares de desarrollo (deploy, descarga de panorámicas, visor de prueba) se mantienen fuera de este repositorio.

## Uso local

1. Clona el repositorio:

   ```bash
   git clone https://github.com/raidenmaister/gg-tlalte.git
   ```

2. Sirve el proyecto con un servidor local (necesario para `fetch`):

   ```bash
   cd gg-tlalte
   python -m http.server 8000
   ```

3. Abre `http://localhost:8000`.

> Las salas públicas y el leaderboard requieren un servidor con PHP. En local con `python -m http.server` no se ejecuta `api.php`, por lo que solo funcionarán las salas privadas y el modo solitario.

## API Key de Google Maps

La API Key **no** está incluida en este repositorio. Para que el juego no la pida, configura un archivo local `js/keys.js` con:

```js
window.GG_GOOGLE_MAPS_API_KEY = 'TU_API_KEY';
```

Ese archivo está en `.gitignore`, así que no se sube a GitHub. Si no existe, el visor pedirá la key por prompt al cargar.

Restringe la key a tu dominio (o a `localhost`) desde la consola de Google Cloud.

## Deploy a hosting con PHP

El deploy se hace desde local con un script (`deploy.mjs`) que no se incluye en GitHub. Configura las credenciales FTP en `.env.deploy` y ejecuta:

```bash
node deploy.mjs
```

Sube los archivos web al web root preservando los datos del juego (`users.json`, `leaderboard.json`, `rooms.json`). El script excluye tooling local y secretos (`.env*`, `.commandcode/`, `node_modules/`, `deploy.mjs`, etc.).
