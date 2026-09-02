# GG-TLALTE

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View, inspirado en GeoGuessr. Incluye modo solitario con leaderboard y duelos P2P 1v1.

## Características

- **Modo solitario**: elige 5, 7 o 10 rondas, con tiempo global para toda la partida.
  - 5 rondas → 1:45
  - 7 rondas → 2:00
  - 10 rondas → 2:30
- **Leaderboard de solitario** separado en categorías de 5, 7 y 10 rondas.
- **Puntuación equilibrada**: combina precisión (5000 pts por ronda) y velocidad, para que un intento rápido pero impreciso no quede por encima de uno acertado.
- **Nombres de usuario únicos** (no repetidos, insensibles a mayúsculas/minúsculas).
- **Duelos 1v1 P2P** con PeerJS:
  - Salas privadas con código de 4 caracteres.
  - Salas públicas con listado y heartbeat.
- **Backend PHP** que persiste usuarios, salas y leaderboard en archivos JSON (sin base de datos).

## Estructura

```
gg-tlalte/
├── dist/                     # Juego desplegable (se sube al hosting)
│   ├── index.html
│   ├── style.css
│   ├── api.php               # Backend PHP (salas, usuarios, leaderboard)
│   ├── rooms.json            # Salas públicas (plantilla)
│   └── js/                   # app.js, game.js, net.js, etc.
├── deploy.mjs                # Deploy FTP a InfinityFree
├── descargar_panos.py        # Descarga de panorámicas
├── encontar-pano-valido.cjs  # Validación de panorámicas
├── panorama.html             # Visor auxiliar de panorámicas
└── package.json
```

## Uso local

1. Clona el repositorio:

   ```bash
   git clone https://github.com/raidenmaister/gg-tlalte.git
   ```

2. Sirve la carpeta `dist/` con un servidor local (necesario para `fetch`):

   ```bash
   cd gg-tlalte/dist
   python -m http.server 8000
   ```

3. Abre `http://localhost:8000` e introduce tu API Key de Google Maps cuando se te solicite.

> Las salas públicas y el leaderboard requieren un servidor con PHP. En local con `python -m http.server` no se ejecuta `api.php`, por lo que solo funcionarán las salas privadas y el modo solitario.

## API Key de Google Maps

La API Key **no** está incluida en el código. Puedes configurarla de dos formas:

- Dejar el campo vacío y escribirla en el prompt al abrir el juego.
- Configurarla en `dist/js/config.js` en `GOOGLE_API_KEY` (sin subirla al repositorio).

Restringe la key a tu dominio (o a `localhost`) desde la consola de Google Cloud.

## Deploy a hosting con PHP

1. Configura las credenciales FTP en `.env.deploy` (ver `.env.deploy` como referencia; no se sube a GitHub).
2. Ejecuta:

   ```bash
   node deploy.mjs
   ```

El script sube el contenido de `dist/` al web root, excluyendo la carpeta `.commandcode/` y preservando los archivos de datos (`users.json`, `leaderboard.json`, `rooms.json`) para no perder puntuaciones.
