/**
 * R20 public (26.195): the Layout Planner, the Smart Router, Plan, Place and Route and the
 * free-flowing routing style are on in the release; they have their sections in the User Guide,
 * their place on the website and in What's New; undo steps made one.
 */
import { describe, expect, it } from 'vitest';
import { FEATURES, FEATURE_COMMANDS, STAGE, featureOn } from '../src/core/release';
import { CONTEXT } from '../src/help/context';
import { BOOKS } from '../src/help/books';
import { PANELS } from '../src/app/dock/panels';
// @ts-expect-error: the website's generator is plain JavaScript (website/site.mjs)
import { FAQ } from '../website/site.mjs';
import { JOBS, ROUTING } from '../src/ai/jobs';

const RAW = import.meta.glob(['../public/whats-new.json', '../public/llms.txt', '../website/site.mjs'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const readFileSync = (f: string, _enc: 'utf8') => RAW[`../${f}`]!;
const FILES = Object.keys(import.meta.glob(['../src/help/pictures/*.webp', '../public/whats-new/*.webp']));
const existsSync = (f: string) => FILES.includes(`../${f}`);
const guide = BOOKS.guide;
const sections = guide.chapters.flatMap((c) => c.sections);
const textOf = (id: string) => JSON.stringify(sections.find((s) => s.id === id)?.blocks ?? []);

describe('R20 public (26.195)', () => {
  it('the stage is 20: the planner, the router, the run and the style are on, their commands with them', () => {
    expect(STAGE).toBeGreaterThanOrEqual(20);
    expect(featureOn('aiLayout')).toBe(true);
    for (const c of ['ai.layoutPlanner', 'ai.layoutExample', 'ai.smartRouter', 'ai.routeExample', 'ai.boardRun', 'route.makeFlowing']) expect(FEATURE_COMMANDS[c], c).toBe('aiLayout');
    expect(FEATURES.aiLayout.name).toBe('AI layout planner, Smart Router and free-flowing routing');
    expect(JOBS.routing).toBe(ROUTING);
  });

  it('three panels in the PCB editor, each with its section of the User Guide for F1', () => {
    for (const [id, title, section] of [['layoutPlanner', 'Layout Planner', 'pcb-layout-planner'], ['smartRouter', 'Smart Router', 'pcb-smart-router'], ['boardRun', 'Plan, Place and Route', 'pcb-board-run']] as const) {
      const p = PANELS.find((x) => x.id === id)!;
      expect(p.title('pcb')).toBe(title);
      expect(p.category('pcb')).toBe('PCB');
      expect(p.category('sch')).toBeNull();
      expect(CONTEXT[`panel:${id}`]).toBe(section);
      expect(sections.some((s) => s.id === section), section).toBe(true);
    }
    // Their accelerators differ from the other PCB panels'
    const keys = PANELS.filter((p) => p.category('pcb') === 'PCB').map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the User Guide says what the tools do, with their pictures, and what the free-flowing style is for', () => {
    const planner = textOf('pcb-layout-planner'), router = textOf('pcb-smart-router'), flow = textOf('pcb-free-flowing'), run = textOf('pcb-board-run');
    expect(planner).toContain('Place by the Plan');
    expect(planner).toContain('never asked for coordinates');
    expect(router).toContain('Make the Rules');
    expect(router).toContain('Route by the Plan');
    expect(router).toContain('draws no tracks and gives no coordinates');
    expect(flow).toContain('Routing Style');
    expect(flow).toContain('Make Free-Flowing');
    expect(flow).toContain('For ordinary digital signals 45° corners do no harm');
    expect(run).toContain('Stop after each stage for my go-ahead');
    for (const img of ['pcb-layout-planner', 'pcb-smart-router', 'pcb-free-flowing']) {
      expect(JSON.stringify(sections)).toContain(`"img":"${img}"`);
      expect(existsSync(`src/help/pictures/${img}.webp`), img).toBe(true);
    }
    // The tools at a glance lists them
    const glance = textOf('kd-overview');
    for (const s of ['#pcb-layout-planner', '#pcb-smart-router', '#pcb-board-run', '#pcb-free-flowing']) expect(glance).toContain(s);
  });

  it('What\'s New, the website and llms.txt carry the release', () => {
    const wn = JSON.parse(readFileSync('public/whats-new.json', 'utf8')) as { releases: { version: string; title: string; items: { text: string; image?: string; alt?: string }[] }[] };
    // (the newest entry when it was released; later releases come before it)
    const first = wn.releases.find((r) => r.version === '26.195')!;
    expect(first.version).toBe('26.195');
    expect(first.items).toHaveLength(7);
    const pictures = first.items.filter((i) => i.image);
    expect(pictures.map((i) => i.image)).toEqual(['whats-new/26.195-layout-planner.webp', 'whats-new/26.195-smart-router.webp', 'whats-new/26.195-free-flowing.webp']);
    for (const i of pictures) { expect(existsSync(`public/${i.image}`), i.image).toBe(true); expect((i.alt ?? '').length).toBeGreaterThan(40); }
    const all = first.items.map((i) => i.text).join(' ');
    expect(all).toContain('never asked for coordinates');
    expect(all).toContain('How good a plan is depends on the model you choose');
    expect(all).not.toMatch(/[–—]/);
    expect(all).not.toMatch(/\bAD\b|Altium|Protel/);
    expect(FAQ.some((f: { id: string }) => f.id === 'ai-layout')).toBe(true);
    const site = readFileSync('website/site.mjs', 'utf8'), llms = readFileSync('public/llms.txt', 'utf8');
    expect(site).toContain("id: 'layout', h: 'AI layout planning and routing', img: 'whats-new/26.195-smart-router.webp'");
    expect(llms).toContain('- AI layout planner, Smart Router and free-flowing routing: ');
    expect(llms).toContain('The model is never asked for coordinates.');
  });
});
