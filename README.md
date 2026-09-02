# GG-TLALTE

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View, inspirado en GeoGuessr y ambientado en Tlaltenango de Sánchez Román, Zacatecas. Incluye modo solitario con leaderboard y partidas multijugador en duelo 1v1 y hasta 12 jugadores.

## Características

- **Modo solitario**: elige 5, 7 o 10 rondas, con tiempo global para toda la partida.
  - 5 rondas → 1:45
  - 7 rondas → 2:00
  - 10 rondas → 2:30
- **Leaderboard de solitario** separado en categorías de 5, 7 y 10 rondas.
- **Puntuación calibrada a escala local**:
  - Fórmula exponencial adaptada a distancias urbanas (~1.2 km de constante de decaimiento).
  - Aciertos a menos de 25 m = 5,000 pts (puntuación perfecta).
  - Diferencias claras y justas de puntos y daño en distancias de calles y colonias.
- **Nombres de usuario únicos** (no repetidos, insensibles a mayúsculas/minúsculas).
- **Partidas multijugador P2P híbridas** (WebRTC vía PeerJS con fallback HTTP ultraligero):
  - **Prioridad P2P absoluta**: Al establecer conexión directa WebRTC entre jugadores, el sondeo al servidor PHP se detiene completamente (0% consumo de CPU/hits en hosting gratuito como InfinityFree).
  - Salas privadas con código de 4 caracteres.
  - Salas públicas con listado y heartbeat inteligente.
  - Sistema de prisa sincronizado (reloj de 15 segundos cuando el primer jugador confirma su guess).
  - **Reglas de Duelo GeoGuessr**: El jugador con mejor puntuación en la ronda inflige daño a los rivales según la diferencia multiplicada por el factor de ronda.
  - Resultados sobre minimapa a pantalla completa: chincheta real y de cada jugador, con nombres y conectadas por líneas geodésicas.
  - Barras de vida animadas con reflejo de daño recibido en tiempo real.
- **Efectos visuales y audio**:
  - Fondo orbital con la Tierra en arte ASCII renderizada en Canvas 2D de alto rendimiento.
  - Visor Street View con bloqueo de navegación y control de punto de vista.
  - Audio sintetizado por Web Audio API para aciertos, temporizador y victorias/derrotas.
- **Backend PHP ligero**:
  - Persiste usuarios, salas y leaderboard en archivos JSON (sin necesidad de MySQL).

## Estructura

```
gg-tlalte/
├── index.html           # Estructura de la aplicación
├── style.css            # Estilos y diseño responsivo
├── api.php              # Backend PHP (salas, usuarios, leaderboard, relay P2P)
├── rooms.json           # Salas públicas activas
├── coordenadas_validas.json # Banco de ubicaciones 360° validadas
└── js/
    ├── app.js           # Orquestador principal y eventos de UI
    ├── ascii-earth.js   # Fondo animado de la Tierra en ASCII
    ├── audio.js         # Efectos de sonido con Web Audio API
    ├── config.js        # Constantes, servidores STUN/TURN y configuración
    ├── game.js          # Máquina de estados del juego (solo y multi)
    ├── minimap.js       # Minimapa interactivo con Leaflet
    ├── net.js           # Capa de red híbrida WebRTC / PeerJS / HTTP relay
    ├── panorama.js      # Visor Google Maps Street View
    └── utils.js         # Cálculos geodésicos (Haversine) y fórmulas
```

## Uso local

1. Clona el repositorio:

   ```bash
   git clone https://github.com/raidenmaister/gg-tlalte.git
   ```

2. Sirve el proyecto con un servidor local (necesario para módulos ES y `fetch`):

   - **Con PHP (Recomendado, habilita salas públicas y leaderboard):**
     ```bash
     cd gg-tlalte
     php -S localhost:8000
     ```

   - **Con Python:**
     ```bash
     python -m http.server 8000
     ```

3. Abre en tu navegador `http://localhost:8000`.

## API Key de Google Maps y Servidores ICE

La API Key y credenciales privadas **no** se suben a GitHub. Configura tu archivo local `js/keys.js` (ignorado por git):

```js
// js/keys.js
window.GG_GOOGLE_MAPS_API_KEY = 'TU_GOOGLE_MAPS_API_KEY';

// Opcional: Servidores TURN para redes restringidas
window.GG_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // { urls: 'turn:...', username: '...', credential: '...' }
];
```

Si no se configura `js/keys.js`, la aplicación solicitará la clave de Google Maps en un prompt interactivo al iniciar.

## Despliegue (Deploy)

El proyecto está preparado para desplegarse por FTP en cualquier hosting compartido con soporte PHP (como InfinityFree, ByetHost, etc.):

```bash
node deploy.mjs
```

El script de despliegue conserva de forma segura los archivos de estado (`rooms.json`, `users.json`, `leaderboard.json`) en el servidor sin sobreescribirlos.
