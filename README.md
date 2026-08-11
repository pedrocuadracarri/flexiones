<img src="logo.png" alt="Flex-Up · Push-Up Trainer" width="260">

# Flex-Up · Contador de Flexiones

App web que cuenta tus flexiones con la cámara del móvil y corrige tu técnica
mientras las haces. No necesita instalación ni conexión: todo el análisis ocurre
en el navegador y **el vídeo nunca sale de tu dispositivo**.

**→ https://pedrocuadracarri.github.io/flexiones/**

## Cómo se usa

1. Apoya el móvil **de lado**, a ras de suelo, a metro y medio o dos. Tienen que
   verse hombro, cadera y rodilla. De frente no funciona: la línea del cuerpo no
   se puede medir.
2. Elige series, repeticiones y descanso (o marca *Modo libre* para contar sin
   objetivo) y pulsa **Empezar**.
3. Colócate en plancha. La app comprueba el encuadre, se calibra contigo durante
   3 segundos y avisa cuando puedes empezar.
4. Haz la serie. Cuenta en voz alta, vibra y corrige sobre la marcha.
5. Al terminar verás la nota de la sesión, los fallos que más se repitieron y el
   vídeo de tu peor repetición.

Con Chrome o Safari puedes añadirla a la pantalla de inicio y se abre como una app.

## Qué mide

**Encuadre.** Antes de contar nada comprueba que se ven las articulaciones
necesarias, que estás de lado y en posición de plancha. Si algo falla te dice qué
corregir en vez de contar mal.

**Calibración.** Durante 3 segundos mide tu extensión real de codo y tu línea
neutra de cadera. Los umbrales se ajustan a tu cuerpo, no a un valor teórico —
esto es lo que evita que te avise de fallos que no estás cometiendo. Si cambias
de sitio, el botón *Recalibrar* repite la medida.

**Repeticiones.** Máquina de estados sobre el ángulo hombro–codo–muñeca. Una
repetición cuenta cuando bajas por debajo de tu umbral y vuelves a extender.

**Profundidad.** Objetivo: codo a 90° o menos. El medidor lateral se llena según
bajas y marca dónde está tu objetivo.

**Alineación de cadera.** Compara tu ángulo hombro–cadera–rodilla con tu neutro y
distingue si la cadera cae o se eleva. Avisa por voz durante la bajada, no al
terminar, que es cuando aún puedes corregir.

**"Gusano".** Compara el instante en que la cadera toca fondo con el instante en
que lo hace el pecho. Si la cadera sube primero, estás subiendo por partes en vez
de empujar con los brazos. Es el fallo más común y el más difícil de notar solo.

**Tempo.** Avisa si la repetición es demasiado rápida o demasiado lenta.

**Fatiga.** Compara las últimas repeticiones con el arranque de la serie. Cuando
pierdes recorrido o te frenas, te avisa una vez: sabes que te quedan pocas buenas
antes de que la técnica se rompa.

**Clip de la peor repetición.** Graba cada repetición con el esqueleto dibujado
encima y conserva la peor puntuada. Verte fallar explica más que cualquier texto.

## Progreso

Cada sesión se guarda en el navegador con reps, calidad media, duración y series.
En *Progreso e historial* hay totales, récord, racha de días seguidos y dos
gráficas: repeticiones por sesión y calidad por sesión.

El historial se puede **exportar** a JSON y **importar** después; al importar se
fusiona por fecha, así que no pierdes sesiones al restaurar una copia.

## Privacidad

No hay servidor, ni cuenta, ni analítica. El vídeo se procesa en el dispositivo y
no se envía a ninguna parte. Los clips y el historial se guardan solo en tu
navegador. Lo único que se descarga de internet es el modelo de MediaPipe, y
queda cacheado para funcionar sin conexión.

## Ejecutar en local

```bash
python -m http.server 5500
```

Abre http://localhost:5500. La cámara exige `localhost` o HTTPS.

## Publicar

GitHub Pages sirve la carpeta raíz de la rama `main` (Settings → Pages). Al ser
HTTPS, el móvil permite el acceso a la cámara.

## Bajo el capó

Sin build, sin dependencias, sin framework: HTML, CSS y un módulo ES.
[MediaPipe Pose](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker)
detecta 33 puntos del cuerpo y el resto es geometría propia sobre esos puntos. Un
service worker cachea la app y el modelo (unos 5 MB) para que arranque al instante
y funcione sin datos.

Los detalles de arquitectura, umbrales y cómo probar están en [CLAUDE.md](CLAUDE.md).

## Limitaciones

- Solo detecta desde una **vista lateral**. Los fallos que necesitan vista frontal
  (codos abiertos, asimetría entre brazos) no se miden todavía.
- Los umbrales del gusano y de la fatiga están ajustados contra poses simuladas,
  no contra vídeo real, así que pueden necesitar retoque.
- Una sola persona en el encuadre.
