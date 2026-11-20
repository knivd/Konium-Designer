/**
 * One instanced SDF shader draws every stroked/filled primitive: round-capped segments
 * (tracks, wires, circles), arcs, rounded/rotated rectangles (pads, fills, sheets) and plain
 * triangles (polygon fills of documents drawn strictly in record order, as schematics are).
 * Edges are anti-aliased analytically, so geometry stays crisp at any zoom with no tessellation;
 * with smoothing off (System › View) they are hard, a pixel in or out, as old CAD drew them.
 */

export const PRIM_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec4 a_p;      // x0 y0 x1 y1
layout(location=1) in vec4 a_q;      // hw a b c
layout(location=2) in float a_kind;
layout(location=3) in vec4 a_color;

uniform vec2 u_center;   // camera centre, scene-relative world units
uniform float u_scale;   // device px per world unit
uniform vec2 u_view;     // device px
uniform float u_flip;    // 1 or -1

out vec2 v_local;
flat out float v_kind;
flat out vec4 v_params;  // capsule: halfLen, r ; arc: R, r, start, sweep ; rect: hx-cr, hy-cr, cr
flat out vec4 v_color;

void main() {
  int corner = gl_VertexID;
  vec2 c = vec2(float(corner & 1), float((corner >> 1) & 1)) * 2.0 - 1.0;
  float aa = 1.5 / u_scale;
  vec2 world;
  int kind = int(a_kind + 0.5);
  if (kind == 0) {
    vec2 d = a_p.zw - a_p.xy;
    float l = length(d);
    vec2 u = l > 0.0 ? d / l : vec2(1.0, 0.0);
    vec2 v = vec2(-u.y, u.x);
    float r = max(a_q.x, a_q.w / u_scale);
    vec2 ext = vec2(l * 0.5 + r + aa, r + aa);
    v_local = c * ext;
    world = (a_p.xy + a_p.zw) * 0.5 + u * v_local.x + v * v_local.y;
    v_params = vec4(l * 0.5, r, 0.0, 0.0);
  } else if (kind == 1) {
    float r = max(a_q.x, a_q.w / u_scale);
    float R = a_p.z;
    float ext = R + r + aa;
    v_local = c * ext;
    world = a_p.xy + v_local;
    v_params = vec4(R, r, a_q.y, a_q.z);
  } else if (kind == 3) {
    // Triangle: x0 y0 | x1 y1 | hw a carry the corners; the strip's fourth vertex repeats the third
    world = corner == 0 ? a_p.xy : corner == 1 ? a_p.zw : a_q.xy;
    v_local = vec2(0.0);
    v_params = vec4(0.0);
  } else {
    float rot = a_q.y;
    vec2 u = vec2(cos(rot), sin(rot));
    vec2 v = vec2(-u.y, u.x);
    vec2 ext = a_p.zw + aa;
    v_local = c * ext;
    world = a_p.xy + u * v_local.x + v * v_local.y;
    float cr = a_q.w;
    v_params = vec4(a_p.z - cr, a_p.w - cr, cr, 0.0);
  }
  v_kind = float(kind);
  v_color = a_color;
  vec2 s = (world - u_center) * u_scale;
  s.x *= u_flip;
  gl_Position = vec4(s / (u_view * 0.5), 0.0, 1.0);
}`;

export const PRIM_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_local;
flat in float v_kind;
flat in vec4 v_params;
flat in vec4 v_color;
uniform float u_scale;
uniform float u_alpha;
uniform vec4 u_tint;     // rgb, amount — selection/highlight overlay
uniform float u_min;     // 1: darkening run (MIN blending), so fade towards white instead of alpha
uniform float u_aa;      // 1: edges smoothed over a pixel; 0: hard, on whole pixels
uniform vec2 u_center;
uniform vec2 u_view;
uniform float u_flip;
out vec4 o;

// A pattern the group is drawn through (Scene's Pattern): id near, cell world units, id once cells are under 3 px, on
uniform vec4 u_pat;
float patMask() {
  if (u_pat.w < 0.5) return 1.0;
  vec2 s = gl_FragCoord.xy - u_view * 0.5;
  s.x *= u_flip;
  vec2 w = u_center + s / u_scale;
  float cell = u_pat.y, id = u_pat.x, px = u_pat.y * u_scale;
  if (px < 3.0) { id = u_pat.z; cell *= exp2(ceil(log2(3.0 / max(px, 1e-6)))); }
  int k = int(id + 0.5);
  if (k == 0) return 0.0;
  if (k == 99) return 1.0;
  vec2 q = w / cell;
  if (k == 1) { vec2 g = floor(q); return mod(g.x + g.y, 2.0); }
  if (k == 2) return step(0.5, fract((q.x + q.y) * 0.5));
  if (k == 3) { vec2 g = floor(q * 0.5); return mod(g.x + g.y, 2.0); }
  if (k == 4) return step(fract((q.x - q.y) * 0.5), 0.3);
  if (k == 5) { float a = fract((q.x + q.y) * 0.5), b = fract((q.x - q.y) * 0.5); return (a < 0.22 || b < 0.22) ? 1.0 : 0.0; }
  if (k == 6) return step(fract((q.x + q.y) / 3.0), 0.14);
  return 1.0;
}

const float TAU = 6.28318530718;

void main() {
  float d;
  int kind = int(v_kind + 0.5);
  float pm = patMask();
  if (pm <= 0.0) discard;
  if (kind == 3) {
    vec3 c3 = mix(v_color.rgb, u_tint.rgb, u_tint.a);
    o = u_min > 0.5 ? vec4(mix(vec3(1.0), c3, v_color.a * u_alpha), 1.0) : vec4(c3, v_color.a * u_alpha);
    return;
  }
  if (kind == 0) {
    vec2 q = vec2(max(abs(v_local.x) - v_params.x, 0.0), v_local.y);
    d = length(q) - v_params.y;
  } else if (kind == 1) {
    float R = v_params.x, r = v_params.y, a0 = v_params.z, sw = v_params.w;
    float ang = atan(v_local.y, v_local.x);
    float t = mod(ang - a0, TAU);
    if (sw >= TAU - 1e-4 || t <= sw) {
      d = abs(length(v_local) - R) - r;
    } else {
      vec2 e0 = R * vec2(cos(a0), sin(a0));
      vec2 e1 = R * vec2(cos(a0 + sw), sin(a0 + sw));
      d = min(length(v_local - e0), length(v_local - e1)) - r;
    }
  } else {
    vec2 q = abs(v_local) - v_params.xy;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - v_params.z;
  }
  float cov = u_aa > 0.5 ? clamp(0.5 - d * u_scale, 0.0, 1.0) : (d * u_scale <= 0.0 ? 1.0 : 0.0);
  if (cov <= 0.0) discard;
  vec3 rgb = mix(v_color.rgb, u_tint.rgb, u_tint.a);
  float a = v_color.a * cov * u_alpha;
  o = u_min > 0.5 ? vec4(mix(vec3(1.0), rgb, a), 1.0) : vec4(rgb, a);
}`;

export const TRI_VS = /* glsl */ `#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
layout(location=1) in vec4 a_color;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_view;
uniform float u_flip;
flat out vec4 v_color;
void main() {
  vec2 s = (a_pos - u_center) * u_scale;
  s.x *= u_flip;
  gl_Position = vec4(s / (u_view * 0.5), 0.0, 1.0);
  v_color = a_color;
}`;

export const TRI_FS = /* glsl */ `#version 300 es
precision highp float;
flat in vec4 v_color;
uniform float u_alpha;
uniform vec4 u_tint;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_view;
uniform float u_flip;
out vec4 o;

// A pattern the group is drawn through (Scene's Pattern): id near, cell world units, id once cells are under 3 px, on
uniform vec4 u_pat;
float patMask() {
  if (u_pat.w < 0.5) return 1.0;
  vec2 s = gl_FragCoord.xy - u_view * 0.5;
  s.x *= u_flip;
  vec2 w = u_center + s / u_scale;
  float cell = u_pat.y, id = u_pat.x, px = u_pat.y * u_scale;
  if (px < 3.0) { id = u_pat.z; cell *= exp2(ceil(log2(3.0 / max(px, 1e-6)))); }
  int k = int(id + 0.5);
  if (k == 0) return 0.0;
  if (k == 99) return 1.0;
  vec2 q = w / cell;
  if (k == 1) { vec2 g = floor(q); return mod(g.x + g.y, 2.0); }
  if (k == 2) return step(0.5, fract((q.x + q.y) * 0.5));
  if (k == 3) { vec2 g = floor(q * 0.5); return mod(g.x + g.y, 2.0); }
  if (k == 4) return step(fract((q.x - q.y) * 0.5), 0.3);
  if (k == 5) { float a = fract((q.x + q.y) * 0.5), b = fract((q.x - q.y) * 0.5); return (a < 0.22 || b < 0.22) ? 1.0 : 0.0; }
  if (k == 6) return step(fract((q.x + q.y) / 3.0), 0.14);
  return 1.0;
}
void main() { if (patMask() <= 0.0) discard; o = vec4(mix(v_color.rgb, u_tint.rgb, u_tint.a), v_color.a * u_alpha); }`;

/** Full-screen grid: lines (schematic) or dots (PCB), fading out when too dense. */
export const GRID_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

export const GRID_FS = /* glsl */ `#version 300 es
precision highp float;
uniform vec2 u_center;
uniform float u_scale;
uniform vec2 u_view;
uniform float u_flip;
uniform float u_grid;     // world units
uniform float u_dots;     // 1 = dots, 0 = lines
uniform vec4 u_color;
uniform vec4 u_major;     // major colour; every 10th line
out vec4 o;

float lineMask(vec2 w, float g) {
  vec2 f = abs(fract(w / g + 0.5) - 0.5) * g * u_scale;   // device px to nearest line
  float m = min(f.x, f.y);
  return 1.0 - smoothstep(0.0, 1.0, m);
}
float dotMask(vec2 w, float g) {
  vec2 f = abs(fract(w / g + 0.5) - 0.5) * g * u_scale;
  return 1.0 - smoothstep(0.6, 1.6, length(f));
}

void main() {
  vec2 s = gl_FragCoord.xy - u_view * 0.5;
  s.x *= u_flip;
  vec2 w = u_center + s / u_scale;
  float px = u_grid * u_scale;
  if (px < 5.0) discard;
  float fade = smoothstep(5.0, 14.0, px);
  float m = (u_dots > 0.5 ? dotMask(w, u_grid) : lineMask(w, u_grid)) * fade * u_color.a;
  float M = (u_dots > 0.5 ? dotMask(w, u_grid * 10.0) : lineMask(w, u_grid * 10.0)) * u_major.a;
  float a = max(m, M);
  if (a <= 0.003) discard;
  o = vec4(M >= m ? u_major.rgb : u_color.rgb, a);
}`;
