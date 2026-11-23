# LensTom — Motion Video Editor (v0.1)

Editor de video de escritorio estilo Filmora: **Electron + Angular 22 (standalone, signals, zoneless) + FFmpeg nativo**.

## Requisitos

- Node 20+ (probado con Node 24)
- FFmpeg y ffprobe en el `PATH` (probado con FFmpeg 9.1 de gyan.dev, `winget install Gyan.FFmpeg`).
  También se pueden indicar rutas con las variables `FFMPEG_PATH` / `FFPROBE_PATH`.

## Scripts

| Comando | Qué hace |
|---|---|
| `npm start` | Desarrollo: `ng serve` + compila el main y abre Electron apuntando a `localhost:4200` (live reload del renderer). |
| `npm run build` | Build de producción de Angular (`dist/`) + main/preload (`dist-electron/`). |
| `npm run start:prod` | Build + abre Electron cargando el build local. |
| `npm run typecheck` | Chequeo de tipos de main y renderer. |

> Los cambios en `electron/` requieren reiniciar `npm start` (el renderer sí se recarga solo).

## Uso rápido

1. **Importar**: botón *Importar* (Ctrl+I) o arrastrar archivos desde el Explorador a la ventana.
   Con el proyecto vacío, la resolución y los fps se adaptan al primer video importado.
2. **Timeline**: arrastrar medios desde el panel a la pista de video o de audio.
   - Mover: arrastrar el clip. Recortar: arrastrar sus bordes. Dividir: `S` o `Ctrl+B`. Borrar: `Supr`.
   - Imantado a bordes y playhead (botón 🧲; mantener `Alt` lo desactiva temporalmente).
   - Zoom: `Ctrl + rueda`, `+`/`-`, slider o *Ajustar*. Clic/arrastre en la regla para mover el playhead.
   - Superposición: al soltar o mover un clip sobre otro, **sobrescribe** (recorta/divide lo que haya debajo).
   - **Pistas**: *＋ Video* / *＋ Audio* agregan pistas (la nueva queda lista para nombrar). Doble clic o ✎ en el
     nombre para renombrar (Enter confirma, Esc cancela); ✕ quita la pista (siempre queda al menos una de cada tipo).
     Las pistas de video de arriba tapan a las de abajo; donde no hay clip se ve lo de abajo. El audio de todas se mezcla.
   - **Transiciones**: pestaña *Transiciones* del panel izquierdo (pasá el mouse para ver la animación).
     Arrastrala al borde de un clip: sobre un corte entre dos clips pegados hace un **cruce** centrado en el corte;
     en un borde libre hace una **entrada/salida** sobre lo que haya debajo. Clic en la marca ✦ para cambiar
     tipo o duración en la barra de la timeline; `Supr` la quita. El audio hace fundido cruzado automáticamente.
3. **Vista previa**: `Espacio` play/pausa, `←`/`→` frame a frame (`Shift` = 10 frames), `Inicio`/`Fin`.
4. **Deshacer/Rehacer**: `Ctrl+Z` / `Ctrl+Y` (o `Ctrl+Shift+Z`).
5. **Proyecto**: `Ctrl+N` nuevo, `Ctrl+O` abrir, `Ctrl+S` guardar, `Ctrl+Shift+S` guardar como (`.vproj`, JSON).
6. **Exportar**: `Ctrl+E` → MP4 H.264 (CRF 20) + AAC 192k con la resolución/fps del proyecto. Barra de progreso y cancelar.

## Arquitectura

```
electron/            Proceso main (Node). Único lugar donde se ejecuta FFmpeg.
  main.ts            Ventana (contextIsolation, sandbox, sin nodeIntegration), menú, ciclo de vida.
  preload.ts         contextBridge → window.tl (API tipada, solo importa 'electron').
  ipc.ts             Handlers IPC: diálogos, probe, miniaturas, ondas, proyecto, exportación.
  media-protocol.ts  Protocolo media:// con soporte de Range para reproducir archivos locales.
  ffmpeg/            probe, thumbnail (caché en userData), waveform (picos en streaming),
                     export-graph (modelo → filtergraph, función pura), export (proceso, progreso, cancelar).
shared/              Código y tipos compartidos main ↔ renderer.
  model.ts           Modelo del proyecto (fuente de verdad) + helpers puros.
  transitions.ts     Tipos de transición y resolución en el tiempo (compartido por preview y exportación).
  ipc-contract.ts    Contrato de la API window.tl.
src/app/core/        Lógica sin UI.
  state/             ProjectStore: proyecto en un signal + historial de comandos (undo/redo).
  commands/          Comandos (Project → Project) deshacibles.
  timeline/          Operaciones puras de timeline (mover, trim, split, sobrescritura), snap, tiempo.
  playback/          PlaybackService (reloj) + PlaybackEngine (interfaz) + HtmlMediaEngine,
                     compose (capas por pista en el instante t) y transition-styles (emulación CSS de xfade).
  media/             Importación y assets en runtime (miniaturas, ondas, archivos faltantes).
  export/            Estado del diálogo de exportación.
src/app/features/    Componentes de UI: toolbar, library (medios | transiciones), preview, timeline, export-dialog, toasts.
```

### Modelo

`Project → tracks[] → clips[]`, con `clip = { sourceId, start, inPoint, outPoint }` (segundos).
El modelo es inmutable; cada comando produce un proyecto nuevo y el historial guarda referencias
(structural sharing), así deshacer es O(1). Las miniaturas y ondas **no** se guardan en el `.vproj`: se regeneran.

Transiciones: `clip.transitionIn` (cruce con el clip pegado anterior, o entrada si no hay) y `clip.transitionOut`
(salida, solo si no hay clip pegado después), con `{ type, duration }`. Los tipos usan los nombres de `xfade`.
En un cruce de duración d, el clip saliente se extiende d/2 después del corte y el entrante d/2 antes, usando
material del archivo fuente o congelando el primer/último cuadro si no hay; así la timeline no se desplaza.

Campos opcionales reservados para próximas versiones: `clip.volume`, `speed`, `effects[]`,
`keyframes{propiedad: Keyframe[]}`; tipos de pista adicionales (`text`, etc.).

### Migración futura a WebCodecs + WebGL

La vista previa depende solo de la interfaz `PlaybackEngine` (`sync(project, time, playing)`),
inyectada con el token `PLAYBACK_ENGINE` en `app.config.ts`. El reloj vive en `PlaybackService`.
Un motor WebCodecs implementaría la misma interfaz dibujando en el `canvas` de `PlaybackSurface`.

## Limitaciones conocidas

- Las pistas no se pueden reordenar todavía (las de video nuevas se agregan arriba de todo).
- Los clips de las pistas superiores ocupan todo el cuadro (letterbox opaco); el picture-in-picture llegará con transformaciones.
- Transiciones: la vista previa las emula con CSS. Barridos, deslizamientos, círculos y fundidos coinciden con la exportación;
  *Fundido a negro* y *Zoom* son aproximaciones, y los círculos tienen un borde levemente distinto (curva vs. lineal).
- Vista previa con `<video>`/`<audio>`: pequeños cortes al pasar entre archivos distintos (sin precarga),
  sincronía aproximada (±250 ms antes de corregir), algunos códecs que Chromium no decodifica (p. ej. ProRes, HEVC
  según el equipo) no se ven en la vista previa aunque sí se exportan.
- Los videos con audio se reproducen/exportan con su audio embebido en la pista de video (no hay audio "desvinculado").
  Silenciar la pista de video silencia ese audio.
- Selección de un solo clip; sin copiar/pegar ni ripple delete.
- Sin auto-scroll al arrastrar cerca del borde de la timeline.
- Imágenes fijas no soportadas.
- Las rutas del `.vproj` son absolutas.
- Sin empaquetado/instalador todavía (electron-builder queda para otra etapa).
