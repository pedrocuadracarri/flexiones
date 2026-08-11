# CLAUDE.md

Guía para trabajar en este repo. Lee esto antes de tocar código.

## Qué es

App web que cuenta flexiones con la cámara y evalúa la técnica en tiempo real.
Todo corre en el navegador: MediaPipe Pose detecta 33 puntos del cuerpo, el resto
es geometría propia. El vídeo nunca sale del dispositivo y no hay servidor.

Desplegada en GitHub Pages: https://pedrocuadracarri.github.io/flexiones/

## Restricciones del proyecto

- **Sin build, sin dependencias npm, sin framework.** HTML + CSS + un módulo ES.
  MediaPipe entra por CDN como módulo. Si añades algo, que siga sin build.
- **Todo el texto de la interfaz en español.**
- **Móvil primero.** Se usa con el teléfono en el suelo mientras haces flexiones:
  botones grandes, información legible de lejos y en ángulo raro, nada que exija
  precisión al tocar.
- La app tiene que seguir funcionando **offline** tras la primera visita.

## Archivos

| Archivo | Contenido |
|---|---|
| `index.html` | Las tres pantallas (`setup`, `workout`, `summary`) en un solo documento |
| `styles.css` | Todo el estilo; variables de color en `:root` |
| `app.js` | Toda la lógica, en secciones separadas por comentarios `// --- nombre ---` |
| `sw.js` | Service worker: caché de la app y del modelo |
| `manifest.webmanifest` | Instalación como PWA |
| `logo.png` | Marca en la pantalla de preparación |
| `icon-192.png`, `icon-512.png` | Iconos de la PWA y favicon |

Los tres PNG salen de un JPEG con fondo de gimnasio (`~/Downloads/Flexiones.jpeg`).
El fondo se quita por saturación y oscuridad, no por color plano, porque es una
foto desenfocada y no un blanco liso. En `logo.png` la tipografía azul marino se
recolorea a tinta clara —solo los píxeles no naranjas de la mitad inferior— para
que se lea sobre el fondo oscuro de la app; la figura y las flechas no se tocan.
Si hay que regenerarlos, ese es el procedimiento.

`app.js` está ordenado así: geometría → encuadre y calibración → lógica de
repeticiones → fatiga → clip → series y descansos → voz y vibración → render →
bucle → cámara → sesión (start/stop) → historial → progreso → plan → listeners.

## Dos vistas de cámara

`plan.view` vale `"side"` o `"front"` y cambia qué se puede medir. No es una
preferencia estética: son geometrías distintas.

| | De lado (`side`) | De frente (`front`) |
|---|---|---|
| Ángulo de codo | el del lado visible | media de los dos brazos |
| Profundidad | sí | sí |
| Línea de cadera y «gusano» | sí | **no**, la cadera queda tapada |
| Apertura de codos y simetría | **no**, no se aprecia | sí |
| Encuadre exige | hombro, codo, muñeca, cadera y rodilla; hombros juntos; cuerpo horizontal | los dos brazos enteros; hombros separados |

Todo lo que dependa de la vista pasa por `isFront()`. Si añades una detección,
decide en cuál de las dos tiene sentido antes de escribirla: medir la cadera de
frente da avisos inventados.

## Máquinas de estado

Dos, y conviene no confundirlas:

- **`stage`** (`framing` → `calibrating` → `counting` ⇄ `resting`): en qué punto
  del entrenamiento estás. Lo consulta `processFrame` y el bucle.
- **`rep.phase`** (`up` ⇄ `down`): dónde estás dentro de una repetición.

La pantalla visible es aparte: `#app[data-screen]` con valores `setup`, `workout`
y `summary`, y se cambia solo con `showScreen(...)`.

**`tickRest()` solo debe llamarse cuando `stage === "resting"`** — lo gestiona el
bucle. Si lo llamas suelto (por ejemplo en un test), avanza de serie de más.

## Invariantes que se rompen fácil

1. **Los cálculos van en píxeles, no en coordenadas normalizadas.** MediaPipe
   devuelve `x`/`y` en 0–1 respecto a ancho y alto por separado, así que en vídeo
   16:9 los ángulos salen deformados. El bucle convierte a píxeles antes de
   pasar los puntos a `processFrame`. No metas geometría antes de esa conversión.
2. **Contar no puede depender solo de la calibración.** Con el móvil en el suelo
   la perspectiva puede hacer que un brazo estirado se mida como 150°, y un
   umbral fijo derivado de ahí resulta inalcanzable: cero repeticiones y la app
   pareciendo rota. Por eso `triggers()` observa el recorrido que estás haciendo
   de verdad y coloca los disparadores en su punto medio, quedándose siempre con
   el más permisivo entre ese y el de la calibración. El aviso «te faltaron X°»
   existe para que un intento corto nunca parezca una avería.
3. **Los umbrales de técnica son relativos a tu calibración, no absolutos.** `cal.upElbow` y
   `cal.neutralBody` se miden en 3 s de plancha; de ahí salen `cal.upAngle` y
   `cal.downAngle`, y la desviación de cadera se mide contra `cal.neutralBody`.
   Comparar contra 180° teóricos genera falsos avisos.
4. **El clip se graba por repetición, no como buffer continuo.** Un trozo suelto
   de un `MediaRecorder` no es reproducible (le faltan las cabeceras). Se arranca
   al empezar la bajada y se para al cerrar la rep.
5. **`el.canvas.captureStream()` graba el canvas, no la cámara**, y por eso el
   clip lleva el esqueleto dibujado. Si grabaras `stream` perderías eso.
6. **El service worker es red-primero para los archivos propios** y caché-primero
   para el CDN (URLs con versión). Al revés servirías una versión vieja de la app.
7. **Especificidad CSS**: la regla que muestra cada pantalla es
   `#app[data-screen="x"] [data-name="x"]`. Cualquier `display` que quieras
   imponer después (por ejemplo el `grid` de horizontal) necesita al menos esa
   especificidad o no se aplica.

## Umbrales

Todos en `app.js`, arriba o en la función que los usa.

| Qué | Valor | Dónde |
|---|---|---|
| Profundidad correcta | codo ≤ 90° | `GOOD_DEPTH` |
| Poco recorrido / falta profundidad | > 110° / > 90° | `completeRep` |
| Entra en bajada / vuelve a arriba | `upElbow − 50` (85–115) / `upElbow − 12` | `runCalibration` |
| Disparadores adaptativos | punto medio ±10% del recorrido observado, si ese recorrido ≥ 45° | `triggers` |
| Cadera desviada: aviso / grave | > 12° / > 20° del neutro | `completeRep` |
| Aviso de cadera en vivo | > 18° durante la bajada | `processFrame` |
| Gusano | cadera toca fondo > 200 ms antes y ya subió > 5% del torso | `completeRep` |
| Tempo | < 0,9 s rápido, > 6 s lento | `completeRep` |
| Fatiga | 8° menos de recorrido o 60% más lento, desde la 5ª rep | `checkFatigue` |
| Codos abiertos: aviso / grave | codo a > 0,9 / > 1,15 anchos de hombro (solo frontal) | `completeRep` |
| Asimetría entre brazos | > 15° abajo (solo frontal) | `completeRep` |
| En lateral, rechaza vista frontal | separación de hombros > 55% del torso | `framingProblem` |
| En frontal, rechaza vista lateral | separación de hombros < 35% del brazo | `framingProblem` |
| No es plancha (rechaza, solo lateral) | inclinación del cuerpo > 40° | `framingProblem` |
| Confianza mínima de un punto | 0.6 | `MIN_VISIBILITY` |
| Inferencia | 24 fps | `MIN_FRAME_MS` |
| Suavizado del ángulo de codo | EMA 0.6 / 0.4 | `processFrame` |

Los de gusano y fatiga son los menos validados: están ajustados contra poses
sintéticas, no contra vídeo real.

## Almacenamiento

`localStorage`, siempre con prefijo `flexiones.`:

- `flexiones.history` — hasta 50 sesiones `{date, reps, quality, duration, sets, target}`
- `flexiones.plan` — `{sets, target, rest, free}`
- `flexiones.facing` — `"user"` o `"environment"`

Cachés del service worker: `flexiones-shell-v1` y `flexiones-deps-v1`.

## Cómo ejecutar

```bash
python -m http.server 5500
```

La cámara solo funciona en `localhost` o con HTTPS. En el móvil, usa la URL de
GitHub Pages.

## Cómo probar

No hay cámara en el entorno de desarrollo, así que la lógica se prueba
**inyectando poses sintéticas**: se construye un array de 33 puntos en píxeles
con hombro, codo, muñeca, cadera, rodilla y tobillo, y se llama a `processFrame`
en secuencia simulando la bajada y la subida.

Para eso hay que exponer las funciones internas temporalmente al final de
`app.js`, y **borrar ese hook antes de commitear**:

```js
window.__t = { processFrame, tickRest, plan, cal, session,
  get stage() { return stage; }, set stage(v) { stage = v; } };
```

Dos cosas que cuestan tiempo si no las sabes:

- **Con el panel del navegador oculto, `setTimeout` se estrangula a 1 s.** Un test
  con `sleep(50)` tarda 20 veces más y revienta el límite de la herramienta. Usa
  espera activa: `const spin = ms => { const t = performance.now(); while (performance.now() - t < ms); }`.
- **El arnés sintético llama a las funciones internas directamente**, saltándose
  las guardas del bucle. Dos consecuencias conocidas y esperadas: `tickRest`
  suelto adelanta series, y sin pasar por `start()` la duración de sesión sale
  disparatada porque `session.startedAt` vale 0. No son bugs de la app.

Además, antes de dar algo por bueno: recargar y revisar consola sin errores, y
comprobar la geometría del layout en 375×812 y en 812×375 (sin scroll horizontal,
sin solapes, botones dentro de pantalla).

## Estado actual

Funciona y está desplegado. Lo que falta es **validación con vídeo real**: los
umbrales están calibrados contra simulaciones, no contra una serie de verdad.
Antes de añadir detecciones nuevas, conviene ajustar las que ya hay con datos
reales de una sesión.
