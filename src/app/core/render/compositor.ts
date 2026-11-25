import type { ColorAdjust, ClipTransform } from '../../../../shared/model';
import type { TransitionType } from '../../../../shared/transitions';
import { FULLSCREEN_VS, LAYER_FS, LAYER_VS, TRANSITION_FS, transitionIndex } from './shaders';

/** Fuente de una capa ya subida a una textura del compositor. */
export interface LayerDraw {
  /** Clave de la textura (ver `upload`). */
  texture: string;
  /** Tamaño natural de la fuente (para el encaje "contain"). */
  width: number;
  height: number;
  /** Rotación propia del archivo (metadatos de celulares), en grados: 0, 90, 180 o 270. */
  sourceRotation?: number;
  /**
   * 'contain' (video/imagen): se encaja en el cuadro. 'none' (texto): tamaño natural, con
   * width/height en píxeles del cuadro del proyecto.
   */
  fit?: 'contain' | 'none';
  /** Espejado horizontal / vertical (en la orientación en que se ve). */
  flipX?: boolean;
  flipY?: boolean;
  transform: ClipTransform;
  adjust: ColorAdjust;
}

/** Lo que se dibuja de una pista en un cuadro: una capa, o dos con una transición. */
export interface TrackDraw {
  from?: LayerDraw;
  to?: LayerDraw;
  main?: LayerDraw;
  transition?: { type: TransitionType; progress: number };
}

type GL = WebGL2RenderingContext;

function compile(gl: GL, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(`Error compilando shader: ${gl.getShaderInfoLog(s)}`);
  }
  return s;
}

function program(gl: GL, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'a_pos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Error enlazando programa: ${gl.getProgramInfoLog(p)}`);
  return p;
}

interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

/**
 * Compositor WebGL2: único código de dibujo para la vista previa y la exportación.
 * Trabaja en alpha premultiplicado; las pistas se apilan de abajo hacia arriba sobre el fondo.
 */
export class Compositor {
  readonly gl: GL;
  private width = 0;
  private height = 0;
  /** Píxeles de canvas por píxel del cuadro del proyecto (la vista previa puede ir a menor resolución). */
  private unit = 1;
  private readonly layerProg: WebGLProgram;
  private readonly transProg: WebGLProgram;
  private readonly quad: WebGLVertexArrayObject;
  private readonly textures = new Map<string, { tex: WebGLTexture; w: number; h: number }>();
  private targets: [Target, Target] | null = null;
  private readonly uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: true,
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    }) as GL | null;
    if (!gl) throw new Error('WebGL2 no está disponible.');
    this.gl = gl;
    this.layerProg = program(gl, LAYER_VS, LAYER_FS);
    this.transProg = program(gl, FULLSCREEN_VS, TRANSITION_FS);

    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  }

  /** @param frameWidth ancho del cuadro del proyecto (si el canvas es más chico, p. ej. en la vista previa). */
  setSize(width: number, height: number, frameWidth = width): void {
    this.unit = width / frameWidth;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    this.disposeTargets();
    const gl = this.gl;
    const make = (): Target => {
      const tex = this.createTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { fbo, tex };
    };
    this.targets = [make(), make()];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** Sube (o actualiza) una textura con la fuente dada. Devuelve false si la fuente no tiene datos. */
  upload(key: string, source: TexImageSource, width: number, height: number): boolean {
    if (width <= 0 || height <= 0) return false;
    const gl = this.gl;
    let entry = this.textures.get(key);
    if (!entry) {
      entry = { tex: this.createTexture(), w: width, h: height };
      this.textures.set(key, entry);
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    entry.w = width;
    entry.h = height;
    return true;
  }

  hasTexture(key: string): boolean {
    return this.textures.has(key);
  }

  releaseTexture(key: string): void {
    const entry = this.textures.get(key);
    if (entry) this.gl.deleteTexture(entry.tex);
    this.textures.delete(key);
  }

  /** Dibuja un cuadro completo: fondo + pistas (de abajo hacia arriba). */
  render(background: string, tracks: TrackDraw[]): void {
    const gl = this.gl;
    const [r, g, b] = parseColor(background);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(r, g, b, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    for (const track of tracks) {
      if (track.transition && (track.from || track.to)) {
        this.drawTransition(track);
      } else if (track.main) {
        this.drawLayer(track.main, null);
      }
    }
    gl.bindVertexArray(this.quad);
  }

  dispose(): void {
    for (const key of [...this.textures.keys()]) this.releaseTexture(key);
    this.disposeTargets();
  }

  // ------------------------------------------------------------------ internos

  private createTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private disposeTargets(): void {
    if (!this.targets) return;
    for (const t of this.targets) {
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.tex);
    }
    this.targets = null;
  }

  private uniform(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let map = this.uniforms.get(prog);
    if (!map) this.uniforms.set(prog, (map = new Map()));
    if (!map.has(name)) map.set(name, this.gl.getUniformLocation(prog, name));
    return map.get(name)!;
  }

  /** Dibuja una capa en el destino (null = canvas) con mezcla premultiplicada. */
  private drawLayer(layer: LayerDraw, target: Target | null): void {
    const gl = this.gl;
    const entry = this.textures.get(layer.texture);
    if (!entry) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.layerProg);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.tex);
    const p = this.layerProg;
    gl.uniform1i(this.uniform(p, 'u_tex'), 0);
    gl.uniformMatrix3fv(this.uniform(p, 'u_matrix'), false, this.layerMatrix(layer));
    const { transform: t, adjust: a } = layer;
    gl.uniform1f(this.uniform(p, 'u_opacity'), Math.min(1, Math.max(0, t.opacity)));
    gl.uniform1f(this.uniform(p, 'u_brightness'), a.brightness);
    gl.uniform1f(this.uniform(p, 'u_contrast'), a.contrast);
    gl.uniform1f(this.uniform(p, 'u_saturation'), a.saturation);
    gl.uniform1f(this.uniform(p, 'u_temperature'), a.temperature);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private drawTransition(track: TrackDraw): void {
    const gl = this.gl;
    const [ta, tb] = this.targets!;
    for (const [layer, target] of [
      [track.from, ta],
      [track.to, tb],
    ] as const) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, this.width, this.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (layer) this.drawLayer(layer, target);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const p = this.transProg;
    gl.useProgram(p);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ta.tex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, tb.tex);
    gl.uniform1i(this.uniform(p, 'u_a'), 0);
    gl.uniform1i(this.uniform(p, 'u_b'), 1);
    gl.uniform1i(this.uniform(p, 'u_hasA'), track.from ? 1 : 0);
    gl.uniform1i(this.uniform(p, 'u_hasB'), track.to ? 1 : 0);
    gl.uniform2f(this.uniform(p, 'u_res'), this.width, this.height);
    // xfade usa progreso 1 → 0.
    gl.uniform1f(this.uniform(p, 'u_progress'), 1 - track.transition!.progress);
    gl.uniform1i(this.uniform(p, 'u_type'), transitionIndex(track.transition!.type));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }

  /** Matriz quad unitario → clip space: encaje "contain", escala, rotación y desplazamiento. */
  private layerMatrix(layer: LayerDraw): Float32Array {
    const W = this.width;
    const H = this.height;
    const t = layer.transform;
    const srcRot = layer.sourceRotation ?? 0;
    const swapped = srcRot % 180 !== 0;
    // El encaje usa el tamaño ya rotado; el quad se dibuja con el tamaño original y se rota.
    const fit =
      layer.fit === 'none'
        ? this.unit
        : swapped
          ? Math.min(W / layer.height, H / layer.width)
          : Math.min(W / layer.width, H / layer.height);
    // Espejado: escala negativa en el eje de la textura (si el archivo viene rotado 90°, los ejes se cruzan).
    const fx = (swapped ? layer.flipY : layer.flipX) ? -1 : 1;
    const fy = (swapped ? layer.flipX : layer.flipY) ? -1 : 1;
    const dw = layer.width * fit * t.scale * fx;
    const dh = layer.height * fit * t.scale * fy;
    const cx = W / 2 + t.x * W;
    const cy = H / 2 + t.y * H;
    const rad = ((t.rotation + srcRot) * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // píxel = C + R · ((u - 0.5)·dw, (v - 0.5)·dh)
    const a = cos * dw, b = sin * dw; // columna u
    const c = -sin * dh, d = cos * dh; // columna v
    const ex = cx - 0.5 * a - 0.5 * c;
    const ey = cy - 0.5 * b - 0.5 * d;
    // clip = (2·px/W - 1, 1 - 2·py/H)
    const sx = 2 / W, sy = -2 / H;
    return new Float32Array([
      a * sx, b * sy, 0,
      c * sx, d * sy, 0,
      ex * sx - 1, ey * sy + 1, 1,
    ]);
  }
}

function parseColor(css: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
