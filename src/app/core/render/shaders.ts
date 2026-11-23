import { TRANSITION_TYPES, type TransitionType } from '../../../../shared/transitions';

/** Quad unitario (0..1) transformado por una matriz 3x3 (afín) a clip space. */
export const LAYER_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
uniform mat3 u_matrix;
out vec2 v_uv;
void main() {
  vec3 p = u_matrix * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = a_pos;
}`;

/**
 * Dibuja una capa (cuadro de video, imagen o texto) con ajustes de color y opacidad.
 * La textura llega premultiplicada; la salida también.
 */
export const LAYER_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_temperature;
out vec4 outColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 rgb = c.rgb / c.a;
  rgb += u_brightness;
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, u_saturation);
  rgb += vec3(0.1, 0.0, -0.1) * u_temperature;
  rgb = clamp(rgb, 0.0, 1.0);
  float a = c.a * u_opacity;
  outColor = vec4(rgb * a, a);
}`;

/** Pasada de pantalla completa (quad unitario → clip space). */
export const FULLSCREEN_VS = /* glsl */ `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0); }`;

/**
 * Cuerpo GLSL de cada transición (fórmulas portadas de xfade de FFmpeg). Debe asignar `c`.
 * Disponibles: a, b (píxel actual), A(px), B(px), xmix(a,b,m) = a*m + b*(1-m), P (1 → 0), x, y, W, H.
 */
const TRANSITION_GLSL: Record<TransitionType, string> = {
  fade: 'c = xmix(a, b, P);',
  fadeblack: `
    vec4 k = vec4(0.0, 0.0, 0.0, 1.0);
    vec4 i1 = xmix(a, k, smoothstep(0.8, 1.0, P));
    vec4 i2 = xmix(k, b, smoothstep(0.2, 1.0, P));
    c = xmix(i1, i2, P);`,
  dissolve: 'float s = frand(px) * 2.0 + P * 2.0 - 1.5; c = s >= 0.5 ? a : b;',
  wipeleft: 'c = x > W * P ? b : a;',
  wiperight: 'c = x > W * (1.0 - P) ? a : b;',
  wipeup: 'c = y > H * P ? b : a;',
  wipedown: 'c = y > H * (1.0 - P) ? a : b;',
  smoothleft: 'float s = 1.0 + x / W - P * 2.0; c = xmix(b, a, smoothstep(0.0, 1.0, s));',
  smoothright: 'float s = 1.0 + (W - 1.0 - x) / W - P * 2.0; c = xmix(b, a, smoothstep(0.0, 1.0, s));',
  slideleft: `
    float zx = x - P * W; vec2 q = vec2(mod(zx, W), y);
    c = (zx >= 0.0 && zx < W) ? B(q) : A(q);`,
  slideright: `
    float zx = x + P * W; vec2 q = vec2(mod(zx, W), y);
    c = (zx >= 0.0 && zx < W) ? B(q) : A(q);`,
  slideup: `
    float zy = y - P * H; vec2 q = vec2(x, mod(zy, H));
    c = (zy >= 0.0 && zy < H) ? B(q) : A(q);`,
  slidedown: `
    float zy = y + P * H; vec2 q = vec2(x, mod(zy, H));
    c = (zy >= 0.0 && zy < H) ? B(q) : A(q);`,
  circleopen: `
    float z = length(vec2(W, H) * 0.5); float p = (P - 0.5) * 3.0;
    float s = smoothstep(0.0, 1.0, length(px - vec2(W, H) * 0.5) / z + p);
    c = xmix(a, b, s);`,
  circleclose: `
    float z = length(vec2(W, H) * 0.5); float p = (1.0 - P - 0.5) * 3.0;
    float s = smoothstep(0.0, 1.0, length(px - vec2(W, H) * 0.5) / z + p);
    c = xmix(b, a, s);`,
  radial: `
    float s = atan(x - W * 0.5, y - H * 0.5) - (P - 0.5) * (3.14159265 * 2.5);
    c = xmix(b, a, smoothstep(0.0, 1.0, s));`,
  zoomin: `
    float zf = smoothstep(0.5, 1.0, P);
    vec2 uv = zf * (px / vec2(W, H) - 0.5) + 0.5;
    vec4 f1 = A(uv * vec2(W, H));
    c = xmix(f1, b, smoothstep(0.0, 0.5, P));`,
  pixelize: `
    float d = min(P, 1.0 - P);
    float dist = ceil(d * 50.0) / 50.0;
    float sq = 2.0 * dist * min(W, H) / 20.0;
    vec2 q = dist > 0.0 ? min((floor(px / sq) + 0.5) * sq, vec2(W, H) - 1.0) : px;
    c = xmix(A(q), B(q), P);`,
};

/**
 * Transición entre los FBOs A (sale) y B (entra). Si falta un lado (entrada/salida sobre
 * lo que haya debajo) se usa transparente. La salida es premultiplicada.
 */
export const TRANSITION_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform bool u_hasA;
uniform bool u_hasB;
uniform vec2 u_res;
uniform float u_progress;
uniform int u_type;
out vec4 outColor;

vec4 A(vec2 px) { return u_hasA ? texture(u_a, vec2(px.x / u_res.x, 1.0 - px.y / u_res.y)) : vec4(0.0); }
vec4 B(vec2 px) { return u_hasB ? texture(u_b, vec2(px.x / u_res.x, 1.0 - px.y / u_res.y)) : vec4(0.0); }
vec4 xmix(vec4 a, vec4 b, float m) { return a * m + b * (1.0 - m); }
float frand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.545); }

void main() {
  float W = u_res.x, H = u_res.y, P = u_progress;
  vec2 px = vec2(gl_FragCoord.x, H - gl_FragCoord.y);
  float x = px.x, y = px.y;
  vec4 a = A(px), b = B(px);
  vec4 c = xmix(a, b, P);
  ${TRANSITION_TYPES.map((t, i) => `${i ? 'else ' : ''}if (u_type == ${i}) { ${TRANSITION_GLSL[t]} }`).join('\n  ')}
  outColor = c;
}`;

/** Copia una textura premultiplicada (para mezclar un FBO sobre el destino). */
export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_res;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, vec2(gl_FragCoord.x / u_res.x, gl_FragCoord.y / u_res.y));
}`;

export function transitionIndex(type: TransitionType): number {
  return TRANSITION_TYPES.indexOf(type);
}
