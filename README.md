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
- **Historial**: sesiones guardadas en el navegador (localStorage).

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
