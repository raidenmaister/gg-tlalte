# GG-TLALTE · GeoGuessr P2P (BETA v1.0.0)

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View, inspirado en GeoGuessr y ambientado en Tlaltenango de Sánchez Román, Zacatecas. Incluye modo solitario con leaderboard por modos y partidas multijugador en duelo 1v1 y hasta 25 jugadores simultáneos.

## Características

- **3 Modos de Juego (disponibles en Solitario y Multijugador)**:
  - **Normal**: Exploración completa en 360° con giro y zoom interactivo.
  - **Estático**: Visión fija, sin posibilidad de girar ni mover la cámara (desafío puro de reconocimiento visual).
  - **Temporal**: La panorámica se muestra únicamente durante un tiempo configurable (1s, 2s, 3s, 5s o 10s); luego una cortina ciega la oculta e indica *"Coloca tu chincheta en el mapa"*, abriendo el minimapa para conjeturar.
- **Distribución de Ubicaciones Inteligente**:
  - Algoritmo de dispersión que garantiza que cada nueva ronda esté a más de **161 metros** de distancia de la anterior.
- **Modo Solitario con Cronómetro Pausado**:
  - El tiempo de partida se detiene de forma justa mientras examinas los resultados sobre el mapa y solo se reanuda al pulsar *"Siguiente ronda"*.
  - Opciones de 5, 7 y 10 rondas (1:45, 2:00 y 2:30 de tiempo total).
- **Leaderboard Global por Categorías y Modos**:
  - Filtros interactivos por **Modo** (Normal, Estático, Temporal) y por **Rondas** (5, 7, 10).
  - Puntuación basada en precisión geográfica con bonificación por rapidez.
- **Multijugador Masivo y Duelos (hasta 25 jugadores)**:
  - **Chinchetas de color real**: En la sala de espera (Lobby) cada jugador cuenta con un icono de chincheta con el color exacto asignado que utilizará al colocar su marcador en el mapa y en la revelación de resultados.
  - **25 Colores Únicos y Contrastantes** con HUD adaptativo en cuadrícula para salas concurridas.
  - **Barrera de sincronización anti-trampas**: Todos los jugadores ven la imagen exactamente al mismo milisegundo mediante saludo `panoReady` y `syncStart`, evitando ventajas de carga y eliminando la pantalla azul.
  - **Reglas de Duelo GeoGuessr**: Sistema de daño dinámico con multiplicador progresivo según rondas y reloj de prisa de 15 segundos cuando el primer jugador confirma su suposición.
  - Conexión híbrida WebRTC / PeerJS de prioridad P2P absoluta con fallback HTTP relay.
- **Fondo Cósmico ASCII en Canvas 2D**:
  - Simulación orbital de la Tierra en 3D en arte ASCII con terminador día/noche.
  - Cielo estrellado con caracteres ASCII titilantes a ritmo suave y pausado.
  - Persistencia continua del fondo entre todas las pantallas de menús.
  - Indicador sutil **BETA v1.0.0** en los menús.
- **Backend PHP ligero**:
  - Persiste usuarios, salas y leaderboard estructurado en archivos JSON locales sin dependencias de base de datos MySQL.

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
