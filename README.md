# SHOTON — Video Editor

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

## Ramas, versiones y actualización automática

| Rama | Qué pasa al hacer push | Quién lo recibe |
|---|---|---|
| `dev` | Se publica **SHOTON Dev** `0.1.N-dev` (prerelease; se conservan las 5 últimas) | quien tenga instalada SHOTON Dev (app aparte, convive con la otra) |
| `test` | Se publica una **beta** `0.1.N-beta` en GitHub Releases (prerelease) | quienes tengan instalada una beta |
| `production` | Se publica la **versión estable** `0.1.N` | todos los usuarios |

Flujo: trabajar en `dev` → `git checkout test && git merge dev && git push` → probar la beta →
`git checkout production && git merge test && git push`.

- La app instalada busca actualizaciones al abrir y cada 4 h (`electron/updater.ts`), descarga en segundo plano
  y la instala al cerrarse (o al tocar *Reiniciar y actualizar* en la barra superior).
- El canal sale de la versión instalada: una estable solo recibe estables; una beta recibe betas y estables más nuevas.
- `N` es el número de ejecución del workflow (`.github/workflows/release.yml`), así cada publicación es más nueva.
- Para cambiar la versión mayor/menor, editar `version` en `package.json` (p. ej. `0.2.0` → las siguientes serán `0.2.N`).
- El instalador incluye FFmpeg (build *full* de gyan.dev, con Whisper; licencia GPL): el usuario no necesita instalar nada.
- `npm run dist` genera el instalador localmente en `release/` (requiere `vendor/ffmpeg/ffmpeg.exe` y `ffprobe.exe`).
- El instalador no está firmado: Windows SmartScreen muestra un aviso la primera vez ("Más información → Ejecutar de todas formas").

## Uso rápido

1. **Importar**: *Importar* (Ctrl+I) o arrastrar archivos a la ventana. Los formatos que el motor no decodifica
   (ProRes, AVI viejos…) se convierten solos a una copia intermedia H.264 para editar.
2. **Timeline**: arrastrá medios a una pista. Mover, recortar desde los bordes, dividir (`S`/`Ctrl+B`), borrar (`Supr`),
   imantado (🧲, `Alt` lo desactiva), zoom (`Ctrl`+rueda). Pistas: *＋ Video*/*＋ Audio*, doble clic para renombrar, ✕ para quitar.
3. **Propiedades** (se abre al seleccionar un clip, o con clic sobre él en la vista previa):
   - Transformación: posición, escala, rotación, opacidad — también con las manijas sobre la vista previa
     (Shift = rotación de a 15°; se imanta al centro). Así se arma un picture-in-picture.
   - Color: brillo, contraste, saturación, temperatura.
   - **Keyframes**: botón ◆ en cada propiedad (agrega/quita en el playhead); con keyframes, editar el valor crea uno nuevo.
   - Velocidad (0,25×–4× o personalizada, sin cambiar el tono) y Audio (volumen 0–200 % con keyframes, fundidos,
     silenciar, *Separar audio*).
4. **Texto**: pestaña *Texto* → elegí un estilo; se agrega en el playhead. Editalo en *Propiedades*
   (fuente, tamaño, color, contorno, sombra, fondo, animaciones de entrada/salida).
5. **Transiciones**: pestaña *Transiciones* (41 tipos: fundidos, barridos, deslizar, zoom, giro, remolino, onda, glitch,
   corazón, iris, puertas, persianas, mosaico, barrido rápido…) → arrastrá al borde de un clip. Clic en la marca ✦ para editarla.
6. **Imágenes y stickers** (png, jpg, webp, bmp, gif): se importan igual que los videos; entran con 5 s y se estiran
   sin límite. La transparencia de los PNG se respeta.
7. **Efectos** (pestaña *Efectos*): corazones, fuegos artificiales, confeti, nieve, brillos, burbujas, lluvia, cielo
   estrellado, luces bokeh, pétalos, hojas de otoño, globos, notas musicales, destello de luz y luces de escenario. Se agregan en
   el playhead sobre el video (en su propia pista si hace falta). En *Propiedades*: intensidad, tamaño, velocidad, color,
   multicolor y *Variar* (otra distribución). También admiten transformación, keyframes y transiciones.
   Se dibujan a partir del tiempo con aleatorios fijos: vista previa y exportación salen idénticas.
   **Filtros** (misma pestaña, 27: blanco y negro, sepia, vintage, cine, noir, terror, VHS, película vieja, glitch,
   desenfoque, boceto, ojo de pez…): con un clip seleccionado se aplica a ese clip; sin selección se agrega una
   *capa de filtro* que afecta a todo lo que está debajo mientras dure. Tipo e intensidad se cambian en *Propiedades → Filtro*.
8. **Subtítulos automáticos** (botón *💬 Subtítulos* en la timeline): transcribe lo que se escucha (toda la timeline o
   el clip seleccionado) con Whisper, sin internet, y crea una pista "Subtítulos" con un texto por frase en el estilo
   elegido (clásico, con fondo o redes). La primera vez baja el modelo (base 148 MB, small 488 MB, large-v3-turbo 1,6 GB)
   a la carpeta de datos de la app. También se pueden guardar como `.srt`.
9. **Edición**: Ctrl/Shift + clic para seleccionar varios clips; `Ctrl+C`/`Ctrl+X`/`Ctrl+V` (pega en el playhead),
   `Ctrl+D` duplicar, `Shift+Supr` borrar cerrando el hueco, `M` marcador (clic derecho sobre él para quitarlo),
   ▲/▼ en el encabezado para reordenar pistas.
10. **Audio**: en *Propiedades* → *Limpieza y ecualizador*: reducción de ruido (se aplica al exportar), quitar viento,
    zumbido y siseo, balance izquierda/derecha y ecualizador de 10 bandas con estilos prearmados.
    En *Transformación*, los botones de espejado dan vuelta la imagen horizontal o verticalmente.
11. **Atajos**: `Espacio` play/pausa, `←`/`→` cuadro a cuadro, `Ctrl+Z`/`Ctrl+Y`, `Ctrl+S` guardar, `Ctrl+E` exportar.

**Importar de Filmora** (botón de claqueta, *Archivo → Importar proyecto de Filmora* o soltando el `.wfp` en la
ventana): convierte el proyecto (probado con Filmora 14) con sus pistas, clips, recortes, velocidad, volumen, fundidos,
posición/escala, espejado, transiciones de video y de audio, limpieza de audio (ruido, viento, zumbido, siseo),
ecualizador, balance y los títulos con su animación de entrada. Las transiciones y efectos de los packs de Filmora se
reemplazan por el equivalente más parecido de SHOTON (los filtros de la biblioteca pasan a capas de filtro); lo que no
tiene equivalente (máscaras, filtros de color por clip, algunos overlays) se lista en el resumen.
Si los archivos están en otra ruta (otra PC), *Buscar archivos…* pide una carpeta y los vincula por nombre;
el aviso "Faltan N archivos" del panel de medios hace lo mismo para cualquier proyecto.

**Sesión automática**: la app guarda sola el estado de edición (proyecto, archivo abierto, playhead y zoom) en
`%APPDATA%SHOTONsession.json` y al abrirla te deja donde estabas, aunque no hayas guardado el `.vproj` o se haya
cerrado de golpe. El punto amarillo junto al nombre sigue indicando cambios sin guardar en el archivo del proyecto.

## Motor de render

La vista previa y la exportación usan **el mismo compositor WebGL2** (`src/app/core/render/`): capas por pista,
transformaciones, color, texto y transiciones (shaders con las fórmulas de `xfade`). Lo que se ve es lo que se exporta.

- **Vista previa**: `<video>` ocultos como fuente de cuadros → compositor → canvas; audio por Web Audio.
- **Exportación**: Mediabunny decodifica cuadros exactos con WebCodecs → compositor → H.264 por WebCodecs
  (en el renderer) → el proceso main mezcla el audio con FFmpeg y lo multiplexa sin recodificar el video.

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

- Sin LUTs, recorte (crop) ni máscaras todavía.
- Con varios clips seleccionados, arrastrar mueve solo el clip tomado (borrar/copiar/duplicar sí actúan sobre todos).
- Los GIF animados se toman como imagen fija (primer cuadro).
- La vista previa usa `<video>`: pequeños cortes al cambiar de archivo y sincronía aproximada (±250 ms);
  la exportación sí es exacta cuadro a cuadro.
- Las rutas del `.vproj` son absolutas. Sin instalador todavía.
- Mediabunny tiene licencia MPL-2.0: si se modifica su código, esos archivos deben publicarse (usarla tal cual no obliga a nada).
