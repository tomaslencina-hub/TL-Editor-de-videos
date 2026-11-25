import { FILTER_TYPES, type FilterType } from '../../../../shared/filters';
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

/** Constantes GLSL `F_<TIPO>` con el índice de cada filtro (el mismo que `filterIndex`). */
const FILTER_CONSTS = FILTER_TYPES.map((t, i) => `const int F_${t.toUpperCase()} = ${i};`).join('\n');

/**
 * Dibuja una capa (cuadro de video, imagen o texto) con ajustes de color, filtro y opacidad.
 * La textura llega premultiplicada; la salida también.
 * Filtros (shared/filters.ts): primero los que cambian dónde se lee la textura (desenfoque,
 * pixelado, glitch…), después los de color, mezclados con la intensidad `u_amount`.
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
uniform int u_filter;      // -1 = sin filtro
uniform float u_amount;    // 0..1
uniform float u_time;      // s desde el inicio del clip (grano, glitch, VHS…)
uniform vec2 u_texSize;    // tamaño de la textura en píxeles
out vec4 outColor;

${FILTER_CONSTS}
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec4 tex(vec2 uv) { return texture(u_tex, uv); }
vec3 unpm(vec4 c) { return c.a > 0.0 ? c.rgb / c.a : vec3(0.0); }
float aspect() { return u_texSize.x / max(u_texSize.y, 1.0); }
/** Viñeta: 1 en el centro, 1-k en las esquinas. */
float vig(vec2 uv, float k) {
  vec2 d = (uv - 0.5) * vec2(aspect(), 1.0);
  return 1.0 - k * smoothstep(0.3, 1.0, length(d) * 1.1);
}
vec3 sepia(vec3 c) {
  return vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
}
/** Desenfoque gaussiano 9×9 con radio r (fracción del alto). */
vec4 blur(vec2 uv, float r) {
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  vec2 st = vec2(1.0 / aspect(), 1.0) * (r / 4.0);
  for (int i = -4; i <= 4; i++) {
    for (int j = -4; j <= 4; j++) {
      float w = exp(-float(i * i + j * j) / 8.0);
      acc += tex(uv + vec2(float(i), float(j)) * st) * w;
      wsum += w;
    }
  }
  return acc / wsum;
}

/** Etapa 1: lectura de la textura (premultiplicada). */
vec4 sampleFiltered(vec2 uv) {
  float k = u_amount;
  float ar = aspect();
  if (u_filter == F_BLUR) return blur(uv, 0.03 * k);
  if (u_filter == F_DREAM) {
    vec4 base = tex(uv);
    vec3 b = unpm(base), g = unpm(blur(uv, 0.02));
    vec3 scr = 1.0 - (1.0 - b) * (1.0 - g * 0.85);
    vec3 res = mix(b, scr * vec3(1.03, 1.0, 1.06), k);
    return vec4(min(res, 1.0) * base.a, base.a);
  }
  if (u_filter == F_SHARPEN) {
    vec2 t = 1.5 / u_texSize;
    vec4 c = tex(uv);
    vec4 n = tex(uv + vec2(t.x, 0.0)) + tex(uv - vec2(t.x, 0.0)) + tex(uv + vec2(0.0, t.y)) + tex(uv - vec2(0.0, t.y));
    vec4 s = c + (c * 4.0 - n) * (k * 1.2);
    return vec4(clamp(s.rgb, vec3(0.0), vec3(c.a)), c.a);
  }
  if (u_filter == F_PIXELATE) {
    float cells = mix(150.0, 16.0, k);
    vec2 g = vec2(cells * ar, cells);
    return tex((floor(uv * g) + 0.5) / g);
  }
  if (u_filter == F_RGBSPLIT) {
    float o = 0.015 * k;
    vec4 c = tex(uv);
    return vec4(tex(uv + vec2(o, 0.0)).r, c.g, tex(uv - vec2(o, 0.0)).b, c.a);
  }
  if (u_filter == F_GLITCH) {
    float tt = floor(u_time * 12.0);
    float burst = step(0.65, hash(vec2(tt, 3.1)));
    float row = floor(uv.y * 28.0);
    float n = hash(vec2(row, tt));
    float shift = (n - 0.5) * 0.12 * k * step(0.72 - 0.25 * burst, hash(vec2(row * 1.7, tt + 0.5))) * (0.35 + burst);
    vec2 p = vec2(uv.x + shift, uv.y);
    float o = 0.005 * k * (1.0 + 2.5 * burst);
    vec4 c = tex(p);
    return vec4(tex(p + vec2(o, 0.0)).r, c.g, tex(p - vec2(o, 0.0)).b, c.a);
  }
  if (u_filter == F_VHS) {
    float wob = sin(uv.y * 35.0 + u_time * 2.7) * 0.0012
      + (hash(vec2(floor(uv.y * 240.0), floor(u_time * 30.0))) - 0.5) * 0.0018;
    vec2 p = vec2(uv.x + wob * k, uv.y);
    float o = 0.004 * k;
    vec4 c = tex(p);
    return vec4(tex(p + vec2(o, 0.0)).r, c.g, tex(p - vec2(o, 0.0)).b, c.a);
  }
  if (u_filter == F_MIRROR) {
    return tex(vec2(uv.x < 0.5 ? uv.x : 1.0 - uv.x, uv.y));
  }
  if (u_filter == F_FISHEYE) {
    vec2 d = (uv - 0.5) * vec2(ar, 1.0);
    float r2 = dot(d, d);
    vec2 p = d * (1.0 - 0.45 * k + 0.9 * k * r2) / vec2(ar, 1.0) + 0.5;
    vec4 c = tex(p);
    bool inside = all(greaterThanEqual(p, vec2(0.0))) && all(lessThanEqual(p, vec2(1.0)));
    return inside ? c : vec4(0.0, 0.0, 0.0, tex(uv).a);
  }
  if (u_filter == F_SKETCH) {
    vec2 t = vec2(1.0 / ar, 1.0) / 700.0;
    float tl = dot(unpm(tex(uv + t * vec2(-1.0, -1.0))), LUMA), tc = dot(unpm(tex(uv + t * vec2(0.0, -1.0))), LUMA);
    float tr = dot(unpm(tex(uv + t * vec2(1.0, -1.0))), LUMA), ml = dot(unpm(tex(uv + t * vec2(-1.0, 0.0))), LUMA);
    float mr = dot(unpm(tex(uv + t * vec2(1.0, 0.0))), LUMA), bl = dot(unpm(tex(uv + t * vec2(-1.0, 1.0))), LUMA);
    float bc = dot(unpm(tex(uv + t * vec2(0.0, 1.0))), LUMA), br = dot(unpm(tex(uv + t * vec2(1.0, 1.0))), LUMA);
    float gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
    float gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
    float e = clamp(length(vec2(gx, gy)) * 2.2, 0.0, 1.0);
    vec4 c = tex(uv);
    vec3 sk = vec3(0.97, 0.96, 0.92) * (1.0 - e);
    return vec4(mix(unpm(c), sk, k) * c.a, c.a);
  }
  return tex(uv);
}

/** Etapa 2: color (sobre RGB sin premultiplicar), mezclado con la intensidad. */
vec3 colorFilter(vec3 c, vec2 uv) {
  float l = dot(c, LUMA);
  vec3 f = c;
  if (u_filter == F_BW) f = vec3(l);
  else if (u_filter == F_SEPIA) f = sepia(c);
  else if (u_filter == F_VINTAGE) { f = mix(c, sepia(c), 0.4) * 0.82 + vec3(0.1, 0.08, 0.05); f *= vig(uv, 0.35); }
  else if (u_filter == F_CINEMA) {
    f = (c - 0.5) * 1.12 + 0.5;
    f = mix(f, f * vec3(0.82, 1.0, 1.15), 1.0 - smoothstep(0.0, 0.55, l));
    f = mix(f, f * vec3(1.14, 1.0, 0.84), smoothstep(0.45, 1.0, l));
    f *= vig(uv, 0.25);
  }
  else if (u_filter == F_DRAMATIC) { f = (mix(vec3(l), c, 0.6) - 0.5) * 1.45 + 0.5; f *= vig(uv, 0.3); }
  else if (u_filter == F_VIVID) f = (mix(vec3(l), c, 1.55) - 0.5) * 1.1 + 0.5;
  else if (u_filter == F_NOIR) f = vec3(clamp((l - 0.5) * 1.7 + 0.5, 0.0, 1.0)) * vig(uv, 0.55);
  else if (u_filter == F_COLD) f = c * vec3(0.88, 1.0, 1.15) + vec3(0.0, 0.01, 0.04);
  else if (u_filter == F_WARM) f = c * vec3(1.12, 1.02, 0.85) + vec3(0.03, 0.01, 0.0);
  else if (u_filter == F_INVERT) f = 1.0 - c;
  else if (u_filter == F_POSTERIZE) f = floor(c * 4.999) / 4.0;
  else if (u_filter == F_DUOTONE) f = mix(vec3(0.16, 0.05, 0.35), vec3(1.0, 0.62, 0.3), smoothstep(0.05, 0.95, l));
  else if (u_filter == F_THERMAL) {
    f = mix(vec3(0.0, 0.0, 0.5), vec3(0.0, 0.8, 1.0), smoothstep(0.0, 0.25, l));
    f = mix(f, vec3(0.1, 1.0, 0.2), smoothstep(0.25, 0.5, l));
    f = mix(f, vec3(1.0, 1.0, 0.0), smoothstep(0.5, 0.75, l));
    f = mix(f, vec3(1.0, 0.1, 0.0), smoothstep(0.75, 1.0, l));
  }
  else if (u_filter == F_HORROR) {
    f = mix(vec3(l), c, 0.25) * vec3(0.85, 1.0, 0.85);
    f = (f - 0.5) * 1.35 + 0.45;
    f *= (0.9 + 0.1 * hash(vec2(floor(u_time * 14.0), 1.0))) * vig(uv, 0.8);
  }
  else if (u_filter == F_VIGNETTE) f = c * vig(uv, 1.0);
  else if (u_filter == F_VHS) {
    f = mix(vec3(l), c, 0.75) * 0.9 + 0.05;
    f *= 0.9 + 0.1 * sin(uv.y * 3.14159265 * 300.0);
    f += (hash(uv * 517.0 + fract(u_time * 7.3)) - 0.5) * 0.09;
  }
  else if (u_filter == F_GRAIN) f = c + (hash(uv * u_texSize + fract(u_time * 24.0) * 97.0) - 0.5) * 0.2;
  else if (u_filter == F_OLDFILM) {
    float tf = floor(u_time * 18.0);
    f = mix(c, sepia(c), 0.85) * (0.88 + 0.12 * hash(vec2(tf, 5.0)));
    f += (hash(uv * u_texSize + tf * 13.0) - 0.5) * 0.14;
    float sx = hash(vec2(tf, 9.0));
    f *= 1.0 - (1.0 - smoothstep(0.0, 0.0012, abs(uv.x - sx))) * step(0.45, hash(vec2(tf, 11.0))) * 0.6;
    f *= vig(uv, 0.55);
  }
  return clamp(mix(c, f, u_amount), 0.0, 1.0);
}

void main() {
  vec4 c = u_filter >= 0 ? sampleFiltered(v_uv) : texture(u_tex, v_uv);
  if (c.a <= 0.0) { outColor = vec4(0.0); return; }
  vec3 rgb = c.rgb / c.a;
  rgb += u_brightness;
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  float l = dot(rgb, LUMA);
  rgb = mix(vec3(l), rgb, u_saturation);
  rgb += vec3(0.1, 0.0, -0.1) * u_temperature;
  rgb = clamp(rgb, 0.0, 1.0);
  if (u_filter >= 0) rgb = colorFilter(rgb, v_uv);
  float a = c.a * u_opacity;
  outColor = vec4(rgb * a, a);
}`;

export function filterIndex(type: FilterType): number {
  return FILTER_TYPES.indexOf(type);
}

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
    // La de xfade acerca A hasta un solo píxel (destello de un color); acá A se acerca hasta 3×,
    // B llega desde 1,5× y se funden en el medio.
    float q = 1.0 - P;
    vec2 rel = px / vec2(W, H) - 0.5;
    float za = 1.0 / (1.0 + 2.0 * smoothstep(0.0, 1.0, q));
    float zb = 1.0 / (1.0 + 0.5 * (1.0 - smoothstep(0.0, 1.0, q)));
    vec4 fa = A((za * rel + 0.5) * vec2(W, H));
    vec4 fb = B((zb * rel + 0.5) * vec2(W, H));
    c = xmix(fa, fb, smoothstep(0.3, 0.7, P));`,
  pixelize: `
    float d = min(P, 1.0 - P);
    float dist = ceil(d * 50.0) / 50.0;
    float sq = 2.0 * dist * min(W, H) / 20.0;
    vec2 q = dist > 0.0 ? min((floor(px / sq) + 0.5) * sq, vec2(W, H) - 1.0) : px;
    c = xmix(A(q), B(q), P);`,

  // ---- propias (q = 1 - P va de 0 a 1) ----
  fadewhite: `
    vec4 k = vec4(1.0);
    vec4 i1 = xmix(a, k, smoothstep(0.8, 1.0, P));
    vec4 i2 = xmix(k, b, smoothstep(0.2, 1.0, P));
    c = xmix(i1, i2, P);`,
  fadegrays: `
    float q = 1.0 - P;
    vec4 ga = vec4(vec3(dot(a.rgb, LUMA)), a.a), gb = vec4(vec3(dot(b.rgb, LUMA)), b.a);
    vec4 fa = mix(a, ga, smoothstep(0.0, 0.45, q));
    vec4 fb = mix(gb, b, smoothstep(0.55, 1.0, q));
    c = mix(fa, fb, smoothstep(0.3, 0.7, q));`,
  flash: `
    float q = 1.0 - P;
    vec4 m = xmix(a, b, smoothstep(0.45, 0.55, P));
    float z = (q - 0.5) * 7.0;
    c = mix(m, vec4(1.0), exp(-z * z));`,
  zoomout: `
    float q = 1.0 - P, e = smoothstep(0.0, 1.0, q);
    vec2 rel = px / vec2(W, H) - 0.5;
    vec2 ua = rel / (1.0 - 0.6 * e) + 0.5;
    vec4 fa = inside(ua) ? A(ua * vec2(W, H)) : vec4(0.0);
    fa *= 1.0 - smoothstep(0.45, 1.0, q);
    vec4 fb = B((rel / (1.0 + 0.3 * (1.0 - e)) + 0.5) * vec2(W, H));
    c = fa + fb * (1.0 - fa.a);`,
  blur: `
    float q = 1.0 - P;
    float r = sin(q * PI) * 0.025 * H;
    vec4 sa = vec4(0.0), sb = vec4(0.0);
    for (int i = -3; i <= 3; i++) {
      for (int j = -3; j <= 3; j++) {
        vec2 o = vec2(float(i), float(j)) / 3.0 * r;
        sa += A(px + o);
        sb += B(px + o);
      }
    }
    c = xmix(sa / 49.0, sb / 49.0, smoothstep(0.35, 0.65, P));`,
  spin: `
    float q = 1.0 - P, e = smoothstep(0.0, 1.0, q);
    vec2 ctr = vec2(W, H) * 0.5, rel = px - ctr;
    float aa = e * PI, ab = (e - 1.0) * PI, sa = max(1.0 - e, 1e-3), sb = max(e, 1e-3);
    vec2 pa = mat2(cos(aa), -sin(aa), sin(aa), cos(aa)) * rel / sa + ctr;
    vec2 pb = mat2(cos(ab), -sin(ab), sin(ab), cos(ab)) * rel / sb + ctr;
    vec4 fa = inside(pa / vec2(W, H)) ? A(pa) : vec4(0.0);
    vec4 fb = inside(pb / vec2(W, H)) ? B(pb) : vec4(0.0);
    c = q < 0.5 ? fa + fb * (1.0 - fa.a) : fb + fa * (1.0 - fb.a);`,
  swirl: `
    float q = 1.0 - P;
    vec2 ctr = vec2(W, H) * 0.5, d = px - ctr;
    float ang = sin(q * PI) * 6.0 * max(0.0, 1.0 - length(d) / H * 1.2);
    vec2 p2 = ctr + mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * d;
    c = xmix(A(p2), B(p2), smoothstep(0.35, 0.65, P));`,
  ripple: `
    float q = 1.0 - P;
    vec2 ctr = vec2(W, H) * 0.5, d = px - ctr;
    float r = length(d) / H;
    vec2 dir = r > 0.0 ? d / (r * H) : vec2(0.0);
    vec2 p2 = px + dir * sin(r * 40.0 - q * 25.0) * 0.02 * H * sin(q * PI);
    c = xmix(A(p2), B(p2), smoothstep(0.3, 0.7, P));`,
  glitch: `
    float q = 1.0 - P, k = sin(q * PI);
    float st = floor(q * 18.0), row = floor(y / H * 20.0);
    float n1 = frand(vec2(row, st)), n2 = frand(vec2(st, row + 7.0));
    vec2 p2 = vec2(x + (n1 - 0.5) * 0.25 * W * k * step(0.55, n2), y);
    float off = 0.015 * W * k;
    bool useB = q > 0.5 + (n2 - 0.5) * 0.5 * k;
    vec4 m = useB ? B(p2) : A(p2);
    vec4 mr = useB ? B(p2 + vec2(off, 0.0)) : A(p2 + vec2(off, 0.0));
    vec4 mb = useB ? B(p2 - vec2(off, 0.0)) : A(p2 - vec2(off, 0.0));
    c = vec4(mr.r, m.g, mb.b, m.a);`,
  heart: `
    float q = 1.0 - P;
    float s = max(q * 2.2, 1e-4) * H;
    vec2 h = vec2(x - W * 0.5, H * 0.5 - y + 0.15 * s) / s;
    float r2 = dot(h, h) - 1.0;
    float f = r2 * r2 * r2 - h.x * h.x * h.y * h.y * h.y;
    c = mix(b, a, smoothstep(-0.01, 0.01, f));`,
  circlecrop: `
    float q = 1.0 - P;
    float R = length(vec2(W, H)) * 0.5;
    float r = abs(1.0 - 2.0 * q) * R;
    vec4 s = q < 0.5 ? a : b;
    c = mix(s, vec4(0.0, 0.0, 0.0, 1.0), smoothstep(r - 1.5, r + 1.5, length(px - vec2(W, H) * 0.5)));`,
  rectopen: `
    float q = 1.0 - P;
    vec2 r = abs(px / vec2(W, H) - 0.5) * 2.0;
    float e = q * 1.05;
    c = mix(b, a, smoothstep(e - 0.004, e + 0.004, max(r.x, r.y)));`,
  horzopen: `
    float e = (1.0 - P) * 1.1;
    c = mix(b, a, smoothstep(e - 0.05, e, abs(y / H - 0.5) * 2.0));`,
  vertopen: `
    float e = (1.0 - P) * 1.1;
    c = mix(b, a, smoothstep(e - 0.05, e, abs(x / W - 0.5) * 2.0));`,
  diagtl: `
    float e = (1.0 - P) * 1.2 - 0.1;
    c = mix(b, a, smoothstep(e - 0.05, e + 0.05, (x / W + y / H) * 0.5));`,
  diagbr: `
    float e = (1.0 - P) * 1.2 - 0.1;
    c = mix(b, a, smoothstep(e - 0.05, e + 0.05, 1.0 - (x / W + y / H) * 0.5));`,
  blinds: 'c = fract(x / W * 10.0) < 1.0 - P ? b : a;',
  hblinds: 'c = fract(y / H * 8.0) < 1.0 - P ? b : a;',
  squares: `
    float q = 1.0 - P;
    vec2 cell = floor(px / vec2(W, H) * vec2(16.0, 9.0));
    float t0 = frand(cell + 3.7) * 0.8;
    c = q >= t0 + 0.1 ? b : (q > t0 ? xmix(b, a, (q - t0) / 0.1) : a);`,
  squeezeh: `
    float q = 1.0 - P;
    float rx = x / W - 0.5;
    if (q < 0.5) {
      float s = 1.0 - smoothstep(0.0, 1.0, q * 2.0);
      c = s > 1e-3 && abs(rx) < s * 0.5 ? A(vec2((rx / s + 0.5) * W, y)) : vec4(0.0);
    } else {
      float s = smoothstep(0.0, 1.0, q * 2.0 - 1.0);
      c = s > 1e-3 && abs(rx) < s * 0.5 ? B(vec2((rx / s + 0.5) * W, y)) : vec4(0.0);
    }`,
  doorway: `
    float q = 1.0 - P, e = smoothstep(0.0, 1.0, q);
    float off = e * W * 0.5;
    vec4 fa = x < W * 0.5 - off ? A(vec2(x + off, y)) : (x >= W * 0.5 + off ? A(vec2(x - off, y)) : vec4(0.0));
    vec2 ub = (px / vec2(W, H) - 0.5) / (0.7 + 0.3 * e) + 0.5;
    vec4 fb = inside(ub) ? B(ub * vec2(W, H)) : vec4(0.0);
    fb *= smoothstep(0.0, 0.4, q);
    c = fa + fb * (1.0 - fa.a);`,
  whipleft: `
    float q = 1.0 - P;
    float shift = smoothstep(0.0, 1.0, q) * W, r = sin(q * PI) * 0.08 * W;
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      float zx = x + shift + (float(i) / 11.0 - 0.5) * r;
      acc += zx < W ? A(vec2(zx, y)) : B(vec2(zx - W, y));
    }
    c = acc / 12.0;`,
  whipright: `
    float q = 1.0 - P;
    float shift = smoothstep(0.0, 1.0, q) * W, r = sin(q * PI) * 0.08 * W;
    vec4 acc = vec4(0.0);
    for (int i = 0; i < 12; i++) {
      float zx = x - shift + (float(i) / 11.0 - 0.5) * r;
      acc += zx >= 0.0 ? A(vec2(zx, y)) : B(vec2(zx + W, y));
    }
    c = acc / 12.0;`,
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
bool inside(vec2 uv) { return all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0))); }
const float PI = 3.14159265;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

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
