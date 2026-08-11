# Contador de Flexiones

App web que cuenta flexiones con la cámara y evalúa la técnica en tiempo real
(MediaPipe Pose en el navegador, sin servidor: el vídeo nunca sale del dispositivo).

## Qué mide

- **Encuadre**: antes de contar comprueba que se ven hombro, codo, cadera y rodilla,
  que estás de lado (no de frente) y en posición de plancha.
- **Calibración de 3 s**: mide tu extensión real de codo y tu línea neutra de cadera,
  y ajusta los umbrales a tu cuerpo (botón *Recalibrar* si cambias de sitio).
- **Repeticiones**: ángulo hombro–codo–muñeca con máquina de estados sobre esos umbrales.
- **Profundidad**: codo a 90° o menos por repetición.
- **Alineación**: ángulo hombro–cadera–rodilla respecto a tu neutro; detecta cadera
  caída o elevada y avisa por voz durante la bajada, no al terminar.
- **Tempo**: avisa si la repetición es demasiado rápida o demasiado lenta.
- **"Gusano"**: compara cuándo toca fondo la cadera y cuándo el pecho. Si la cadera
  sube primero, estás subiendo por partes en vez de empujar con los brazos.
- **Fatiga**: compara las últimas reps con el arranque de la serie y avisa una vez
  cuando pierdes recorrido o te frenas; el resumen final cuantifica la caída.
- **Clip de la peor repetición**: graba cada rep del canvas (con el esqueleto dibujado)
  y guarda la peor puntuada para verla al terminar.
- **Series y descansos**: fija series, reps por serie y descanso; la serie se cierra
  sola al llegar al objetivo y la cuenta atrás del descanso se avisa por voz
  (o marca *Libre* para contar sin objetivo).
- **Avisos por vibración** además de la voz, para cuando hay ruido alrededor.
- **Objetivo sugerido**: propone el plan de hoy a partir de la última sesión
  (sube una rep por serie si la calidad fue 80 o más).
- **Exportar / importar** el historial en JSON; al importar se fusiona por fecha,
  no se reemplaza.
- **Historial y progreso**: sesiones guardadas en el navegador (localStorage), con
  totales, récord, racha de días y gráficas de reps y calidad por sesión.
- **Offline**: un service worker cachea la app y el modelo (~5 MB), así que después
  de la primera visita arranca al instante y funciona sin datos.

## Interfaz

Tres pantallas: **preparar** (plan con botones +/−, sugerencia del día, historial),
**entrenar** (cámara a pantalla casi completa, contador gigante, medidor de
profundidad lateral, una sola línea de consejo y overlay de descanso con anillo) y
**resumen** (anillo de calidad, totales, fallos repetidos y clip de la peor rep).

## Uso

Apoya el móvil **de lado**, a ras de suelo, a 1,5–2 m, de forma que se vean hombro,
cadera y rodilla. De frente no se puede medir la línea del cuerpo.

## Ejecutar en local

```bash
python -m http.server 5500
```

Abre http://localhost:5500 (la cámara solo funciona en `localhost` o con HTTPS).

## Publicar en GitHub Pages

Settings → Pages → Source: `Deploy from a branch` → rama `main`, carpeta `/ (root)`.
Pages sirve por HTTPS, requisito para que el móvil dé acceso a la cámara.
