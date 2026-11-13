# GG-TLALTE · GeoGuessr P2P (v1.0.0)

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View, inspirado en GeoGuessr y ambientado en Tlaltenango de Sánchez Román, Zacatecas. Incluye modo solitario con leaderboard global por modos y partidas multijugador en duelo 1v1 y hasta 25 jugadores simultáneos.

## Características Principales

- **Versión 1.0.0 (lanzamiento oficial, fuera de beta)**:
  - **📅 Reto diario**: 10 imágenes iguales para todos, con un modo distinto cada día; un intento por jugador y clasificación por día (hora de Tlaltenango).
  - **👤 Perfil del jugador**: estadísticas, mejores marcas por modo e historial de partidas (solitario, reto diario y multijugador). Los perfiles son públicos desde el leaderboard.
  - **🔐 Cuenta en varios dispositivos**: contraseña opcional y código de recuperación de un solo uso para entrar desde otro celular o PC.
  - **📲 App instalable (PWA)**: manifiesto, íconos y service worker (`sw.js`); botón «Instalar app» en el menú. Requiere HTTPS en el hosting.
  - **🛠️ Panel de administración** (`administracion.html` + `admin-api.php`): inicio de sesión con contraseña cifrada (bcrypt), sesión con CSRF y límite de intentos. Gestiona jugadores, leaderboards, retos diarios, salas, partidas sospechosas, avisos, modo mantenimiento, registros y respaldos. Las credenciales iniciales se generan en `config/admin.php` (sólo el hash; no se sube a GitHub).
  - **Ojo de Halcón 60/40**: 60% de las imágenes dentro de la ciudad (≤ 2 km del centro) y 40% fuera.

- **Nuevo modo «🛰️ Ojo de Halcón» (v2.1.0, Solitario y Multijugador)**:
  - Una foto satelital con zoom máximo cubre toda la pantalla, girada a un ángulo aleatorio y sin brújula. El jugador abre el minimapa y pone la chincheta donde cree que está el centro de la imagen; al final el minimapa a pantalla completa revela cuánto acertó cada uno.
  - La imagen la compone el servidor (`api.php`, proxy de teselas con GD): las coordenadas nunca llegan al navegador antes de fijar la chincheta. En multijugador sólo el anfitrión puede cerrar la ronda y, al hacerlo, pierde su turno si aún no había adivinado.
  - Leaderboard propio y +1 minuto de tiempo en solitario.
  - Banco pre-generado (`satpool/`, bloqueado) con más de 1,600 vistas de **todo el municipio**: cabecera, rancherías, caminos rurales, campo y sierra. Se regenera con `satpool-puntos.mjs` (reparte puntos con datos de OpenStreetMap) y `generar_satpool.php build K N` / `merge` (herramientas locales que no se suben al hosting).
- **Seguridad y anti-trampas (v2.1.0)**:
  - Partidas en solitario validadas por el servidor: el servidor elige las ubicaciones, entrega una ronda a la vez (sólo el `pano_id`), calcula distancia, puntos, bonificaciones y tiempo. El endpoint antiguo `save-score` quedó deshabilitado.
  - Cada nombre está protegido por una clave secreta generada en el dispositivo (`localStorage`), límites de peticiones por IP, detección de patrones automatizados (perfects en < 5 s) y rondas imposiblemente rápidas valen 0.
  - Datos persistentes en `data/` (bloqueado por `.htaccess`) con escrituras atómicas y bloqueo exclusivo (`flock`) para no perder puntajes por concurrencia.

- **Sistema Anti-Empalme y Anti-Colisión Dinámico en Minimapa (Smart Leader Lines)**:
  - Al terminar la ronda o partida a pantalla completa, las chinchetas físicas de los jugadores y la «📍 Ubicación real» se mantienen en sus coordenadas reales exactas mientras que las etiquetas informativas (nombres, daño y puntos) se desacoplan dinámicamente en estantes verticales no superpuestos.
  - Las etiquetas nunca se tapan entre sí ni cubren la meta.
  - Líneas conectoras Bézier SVG dinámicas con los colores de cada jugador y puntos de anclaje de alto contraste que se ajustan suavemente con el zoom y paneo a 60 FPS.
  - Micro-interacción bidireccional: al pasar el ratón o tocar una etiqueta o chincheta, se realza simultáneamente el conjunto completo (etiqueta, chincheta con halo brillante, línea conectora y trayectoria geodésica).
- **Modos y Variantes de Juego (Solitario y Multijugador)**:
  - **Normal**: Exploración completa en 360° con variantes especializadas:
    - *Estándar*: Giro libre y zoom interactivo.
    - *Con Zoom*: Zoom ultra-telescópico progresivo que se aleja paso a paso a intervalos configurables (2s a 15s).
    - *Borroso (Desenfoque Progresivo)*: La panorámica inicia con un fuerte desenfoque óptico 360° que disminuye nivel a nivel. Acelerado por hardware para un giro y arrastre de imagen totalmente fluido a 60 FPS sin sobrecargar la GPU.
    - *Carrera al Objetivo (Rally Equidistante)*: Carrera urbana en tiempo real donde todos inician a la misma distancia de la meta con verificación vial de transitabilidad continua.
    - *Linterna Táctica (Niebla Nocturna 360°)*: Todo el entorno está sumergido en penumbra y el jugador explora con un haz de luz focalizado que sigue el cursor o dedo táctil. La batería se congela al 100% durante la cortina ciega de 3s y solo se consume al mover la luz durante la ronda (consumo 0% en reposo), con calibración equilibrada y aviso crítico. ¡Adivinar a ≤ 25m otorga la insignia honorífica "🦉 ¡BÚHO NOCTURNO!" (+2,000 pts)!
  - **Estático**: Visión fija hacia adelante sin rotación (desafío puro de observación):
    - *Estándar*: Cámara fija bloqueada al frente.
    - *Con Zoom*: Cámara fija hacia adelante combinada con zoom ultra-telescópico progresivo.
    - *Borroso*: Cámara fija hacia adelante combinada con desenfoque progresivo.
  - **Temporal**: La panorámica se muestra únicamente durante un tiempo configurable (1s a 10s); luego una cortina ciega la oculta para conjeturar de memoria.
- **Chat Grupal en el Lobby P2P**:
  - Chat interactivo integrado en el lobby de salas públicas y privadas antes de iniciar la partida.
  - Mensajería en tiempo real impulsada por canales de datos WebRTC (PeerJS) de latencia ultra-baja y sin consumo de cuotas del servidor.
  - Muestra nombre de usuario, hora local de envío e indicador animado de escritura (*"X está escribiendo..."* estilo WhatsApp/Discord).
  - Anuncio automático de *"Iniciando partida..."* y autodestrucción total de la interfaz y los oyentes de eventos al iniciar la partida para maximizar el rendimiento.
- **Separación Geográfica Global Estricta (≥ 161 metros)**:
  - Algoritmo de dispersión geográfica acumulativa que garantiza que cada nueva ronda esté separada por al menos 161 metros de **todas** las ubicaciones previas de la partida, eliminando concentraciones repetidas en partidas de hasta 15 rondas.
- **Tiempo Equitativo en Solitario**:
  - Bonificación automática de **+1 minuto** de tiempo total en solitario para las variantes con Zoom y Borroso (tanto en Normal como en Estático) para compensar el tiempo de revelación visual.
- **Prevención AFK y Rescate de Conjeturas**:
  - Mecanismo de doble transporte (WebRTC directo + respaldo HTTP relay) para registrar suposiciones incluso con microcortes de red.
  - El anfitrión rescata automáticamente cualquier chincheta que un jugador haya fijado en el mapa, evitando falsos positivos por inactividad (AFK) y pérdidas accidentales de puntos.
- **Mecánica de Duelo con Recuperación de Vida y Racha ("Perfects")**:
  - Las conjeturas a menos de 25 metros otorgan la insignia "¡PERFECTO!", bonificación de 5,000 puntos, racha acumulativa y regeneración de +2,000 HP en duelos multijugador.
  - Multiplicadores de daño dinámicos por ronda (hasta x3.5 en rondas 10-14 y x4.0 en ronda 15) con reloj de prisa de 15 segundos al confirmar el primer jugador.
- **Chincheta Dorada de Ubicación Real**:
  - Al revelar resultados, la ubicación real luce un distintivo degradado dorado brillante con aro de pulso animado y prioridad visual (`z-index`) sobre los marcadores de los jugadores.
- **Minimapa Interactivo con Capa Satelital**:
  - Controles integrados para alternar entre mapa de calles y satelital HD híbrido, con botón de recentrado rápido en Tlaltenango y reposicionamiento inteligente en pantalla de resultados.
- **Fondo Cósmico ASCII en Canvas 2D**:
  - Simulación orbital de la Tierra en 3D en arte ASCII con continentes reales, terminador día/noche y cielo estrellado titilante con persistencia fluida entre menús.
- **Música y Audio Procedural**:
  - Banda sonora ambiental sintetizada en tiempo real mediante la Web Audio API (sin archivos de audio pesados) y efectos de sonido interactivos para clics, temporizadores, daño y victorias.
- **Leaderboard Global por Categorías y Modos**:
  - Clasificación en tiempo real filtrable por modo de juego (Normal, Zoom, Borroso, Estático, Temporal) y número de rondas (5, 7, 10 y 15).
- **Historial Completo de Versiones**:
  - Modal interactivo accesible desde el menú principal con el registro detallado de novedades, fechas de lanzamiento y correcciones desde la primera BETA hasta el lanzamiento oficial v1.0.0.
- **Backend PHP Ultraligero y Eficiente**:
  - Optimizado para hostings compartidos con límites estrictos de E/S: reducción del 95% de escrituras a disco durante partidas activas, persistencia local en JSON sin necesidad de MySQL.

## Estructura

```
gg-tlalte/
├── index.html               # Estructura HTML, modales, HUD y vistas
├── style.css                # Estilos, diseño responsivo y efectos visuales
├── api.php                  # Backend PHP (salas, sesiones seguras, cuentas, perfil, reto diario, leaderboard, relay P2P)
├── admin-api.php            # API del panel de administración (requiere inicio de sesión)
├── administracion.html      # Panel de administración
├── manifest.webmanifest     # App instalable (PWA)
├── sw.js                    # Service worker
├── icons/                   # Íconos de la app
├── config/                  # (bloqueado) credenciales del panel: sólo hash, fuera de git
├── data/                    # (sólo servidor, bloqueado) usuarios, leaderboard, sesiones e imágenes satelitales
├── version.json             # Control de versiones del cliente
├── coordenadas_validas.json # Banco de ubicaciones 360° validadas en Tlaltenango
└── js/
    ├── app.js               # Orquestador principal, eventos de UI, chat y menús
    ├── menu-pano.js         # Fondo panorámico 360° ambiental de Tlaltenango con rotación y transiciones
    ├── audio.js             # Efectos de sonido y sintetizador procedural (Web Audio API)
    ├── config.js            # Constantes, servidores STUN/TURN y configuración
    ├── game.js              # Máquina de estados del juego (solo y multi, duelos y rondas)
    ├── minimap.js           # Minimapa interactivo con Leaflet y capas satelitales
    ├── net.js               # Capa de red híbrida WebRTC / PeerJS / HTTP relay
    ├── panorama.js          # Visor Street View, gestión de zoom y blur progresivo
    ├── satview.js           # Visor satelital del modo «Ojo de Halcón»
    ├── secure.js            # Identidad del jugador (clave del dispositivo) y API de partidas validadas
    ├── features.js          # Reto diario, perfil, inicio de sesión en otros dispositivos e instalación
    ├── admin.js             # Lógica del panel de administración
    └── utils.js             # Cálculos geodésicos (Haversine) y fórmulas de puntaje
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
