# gg-tlalte

Juego de adivinar ubicaciones con panorámicas 360° de Google Maps Street View.
Hecho solo con HTML, CSS y JavaScript (sin frameworks).

## Características

- Pantalla de bienvenida que pide el nombre del jugador (se guarda en `localStorage`).
- Menú de modos: **crear sala**, **unirse a sala** y **jugar en solitario**.
- Panorámicas 360° navegables (arrastrar para rotar, flechas o scroll para moverse por la calle).
- Selector de ubicación, botones de anterior / siguiente y aleatorio.
- Interfaz responsive: se adapta desde pantallas muy pequeñas hasta pantallas muy grandes.

## Estructura

```
gg-tlalte/
├── index.html   # Estructura de la página
├── style.css    # Estilos
└── script.js    # Lógica del juego
```

## Uso

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

## API Key

La API Key **no** está incluida en el código. Necesitas una key de la
[Google Maps JavaScript API](https://console.cloud.google.com/apis/credentials).

Puedes introducirla de dos formas:

- Al abrir el juego, se te pedirá mediante un diálogo.
- Pegándola directamente en la constante `API_KEY` dentro de `script.js`.

Restringe la key a tu dominio o a `localhost` desde la consola de Google Cloud.
