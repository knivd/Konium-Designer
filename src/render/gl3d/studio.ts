/**
 * Studio shading for parts that are made, not boards: each part's colour (filament) taking light
 * as its surface does (matte, satin, gloss, silk, metal, clear, fuzzy skin), worked in linear light
 * and tone-mapped. The light: a key light from a direction (round the box and up), a fill and a rim
 * that turn with it, and the room's ambient light; the room (the environment) has a colour that
 * tints the ambient light and what shiny surfaces mirror, and is the picture's background. And what
 * a picture needs besides: the soft shadow the parts cast on the floor under them (drawn from above,
 * blurred, laid on the floor).
 */
import type { V3 } from './ModelView';

/** How a surface takes the light: highlight strength, how tight it is, how metallic, how rough (fuzzy skin). */
export interface Material { spec: number; shine: number; metal: number; fuzz: number }

/** A finish's material (and how see-through it is), by its name in the enclosure's looks. */
export function finishMaterial(finish: string): { material: Material; alpha: number } {
  const m = (spec: number, shine: number, metal = 0, fuzz = 0): Material => ({ spec, shine, metal, fuzz });
  switch (finish) {
    case 'matte': return { material: m(0.04, 6), alpha: 1 };
    case 'gloss': return { material: m(0.6, 90), alpha: 1 };
    case 'silk': return { material: m(0.5, 30, 0.4), alpha: 1 };
    case 'metal': return { material: m(0.9, 60, 1), alpha: 1 };
    case 'clear': return { material: m(0.6, 90), alpha: 0.45 };
    case 'fuzzy': return { material: m(0.05, 8, 0, 0.55), alpha: 1 };
    default: return { material: m(0.22, 24), alpha: 1 };
  }
}
export const SATIN: Material = finishMaterial('satin').material;

export const STUDIO_VS = `#version 300 es
in vec3 aPos; in vec3 aNrm;
uniform mat4 uMvp;
out vec3 vN; out vec3 vP;
void main() { vN = aNrm; vP = aPos; gl_Position = uMvp * vec4(aPos, 1.0); }`;

/**
 * The light on the parts: the room's colour (sRGB 0 … 1), where the key light comes from (degrees
 * round the box from the front, + to the right; and up from level), and how strong the key light
 * and the ambient light are (1: as set up).
 */
export interface Lighting { env: V3; azimuth: number; elevation: number; key: number; ambient: number }
export const DEFAULT_LIGHTING: Lighting = { env: [0.91, 0.92, 0.935], azimuth: -33, elevation: 45, key: 1, ambient: 1 };
/** The room's colour top and bottom for a background: a little lighter above, a little darker below (flat: the colour). */
export function envGradient(env: V3, flat: boolean): [V3, V3] {
  if (flat) return [env, env];
  return [env.map((c) => c + (1 - c) * 0.1) as V3, env.map((c) => c * 0.86) as V3];
}
const lin = (c: number) => Math.pow(c, 2.2);
const dirOf = (az: number, el: number): V3 => { const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180; return [Math.sin(a) * Math.cos(e), -Math.cos(a) * Math.cos(e), Math.sin(e)]; };
/** The shader's light: the key, fill and rim directions (the fill and rim turn with the key), their strength, the ambient's, the room above and below (linear), and its hue. */
export function lightUniforms(l: Lighting): { key: V3; fill: V3; rim: V3; strength: number; ambient: number; top: V3; bottom: V3; hue: V3 } {
  const [t, b] = envGradient(l.env, false);
  const top = t.map(lin) as V3, bottom = b.map(lin) as V3;
  const e = l.env.map(lin) as V3, luma = Math.max(0.02, 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2]);
  const hue = e.map((c) => Math.min(2.5, c / luma)) as V3;
  return { key: dirOf(l.azimuth, l.elevation), fill: dirOf(l.azimuth + 115, 20), rim: dirOf(l.azimuth + 175, 30), strength: l.key, ambient: l.ambient, top, bottom, hue };
}

export const STUDIO_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP;
uniform vec4 uColour; uniform vec3 uEye; uniform vec4 uMat;
uniform vec3 uKey; uniform vec3 uFill; uniform vec3 uRim; uniform float uKeyI; uniform float uAmb;
uniform vec3 uEnvTop; uniform vec3 uEnvBottom; uniform vec3 uHue;
out vec4 o;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec3 v = normalize(uEye - vP);
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;
  // Fuzzy skin: the surface jittered at about a nozzle's width
  if (uMat.w > 0.0) {
    vec3 q = vP * 2.8; float e = 0.35;
    vec3 g = vec3(noise(q + vec3(e, 0, 0)) - noise(q - vec3(e, 0, 0)), noise(q + vec3(0, e, 0)) - noise(q - vec3(0, e, 0)), noise(q + vec3(0, 0, e)) - noise(q - vec3(0, 0, e)));
    n = normalize(n + uMat.w * 2.0 * g);
    if (dot(n, v) < 0.05) n = normalize(n + v * 0.6);
  }
  vec3 base = pow(uColour.rgb, vec3(2.2));
  float spec = uMat.x, shine = uMat.y, metal = uMat.z;
  // The key light, a fill and a rim turning with it; the room's light from all round, brighter from above, in its hue
  vec3 l1 = normalize(uKey), l2 = normalize(uFill), l3 = normalize(uRim);
  float d1 = max(dot(n, l1), 0.0), d2 = max(dot(n, l2), 0.0), d3 = max(dot(n, l3), 0.0);
  vec3 sky = mix(vec3(1.0), uHue, 0.45) * mix(0.16, 0.42, n.z * 0.5 + 0.5) * uAmb;
  vec3 diffuse = base * (sky + uKeyI * (0.95 * d1 + 0.32 * d2 + 0.22 * d3));
  vec3 sc = mix(vec3(1.0), base, metal);
  float k = (shine + 8.0) / 32.0;
  float hl = pow(max(dot(n, normalize(l1 + v)), 0.0), shine) * d1 + 0.4 * pow(max(dot(n, normalize(l2 + v)), 0.0), shine) * d2 + 0.6 * pow(max(dot(n, normalize(l3 + v)), 0.0), shine) * d3;
  vec3 highlight = sc * spec * k * hl * uKeyI;
  // What the surface mirrors: the room, its ceiling bright and its floor dark, more at grazing angles (all of it on metal)
  vec3 r = reflect(-v, n);
  vec3 room = mix(uEnvBottom * 0.12, uEnvTop * 1.1, smoothstep(-0.25, 0.85, r.z)) * (0.35 + 0.65 * uAmb);
  float fres = mix(0.04, 1.0, pow(1.0 - max(dot(n, v), 0.0), 5.0));
  vec3 mirror = sc * room * mix(spec * fres * 0.5, 0.85, metal);
  vec3 c = diffuse * (1.0 - 0.85 * metal) + highlight + mirror;
  o = vec4(pow(aces(c * 1.05), vec3(1.0 / 2.2)), uColour.a);
}`;

/** The parts seen from above, each point as dark as it is near the floor (the darkest kept). */
export const SHADOW_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMvp;
out float vZ;
void main() { vZ = aPos.z; gl_Position = uMvp * vec4(aPos, 1.0); }`;
export const SHADOW_FS = `#version 300 es
precision highp float;
in float vZ; uniform float uZ0; uniform float uH;
out vec4 o;
void main() { o = vec4(0.0, 0.0, 0.0, mix(1.0, 0.2, clamp((vZ - uZ0) / uH, 0.0, 1.0))); }`;

/** A picture filling its target (a triangle over the whole of it). */
export const FULL_VS = `#version 300 es
out vec2 vUv;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;
/** A Gaussian blur along one direction. */
export const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uSrc; uniform vec2 uStep;
out vec4 o;
void main() {
  vec4 s = vec4(0.0); float w = 0.0;
  for (int i = -12; i <= 12; i++) { float g = exp(-float(i * i) / 72.0); s += texture(uSrc, vUv + uStep * float(i)) * g; w += g; }
  o = s / w;
}`;

/** The floor under the parts: the blurred shadow laid on it. */
export const GROUND_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uMvp; uniform vec4 uBox;
out vec2 vUv;
void main() { vUv = (aPos.xy - uBox.xy) / (uBox.zw - uBox.xy); gl_Position = uMvp * vec4(aPos, 1.0); }`;
export const GROUND_FS = `#version 300 es
precision highp float;
in vec2 vUv; uniform sampler2D uShadow; uniform float uStrength;
out vec4 o;
void main() {
  vec2 e = min(vUv, 1.0 - vUv);
  float fade = smoothstep(0.0, 0.08, min(e.x, e.y));
  o = vec4(0.0, 0.0, 0.0, texture(uShadow, vUv).a * uStrength * fade);
}`;

/** A picture's background: the room's colour shaded top to bottom, the colour flat, or none (see-through). */
export type PictureBackground = 'gradient' | 'flat' | 'none';
