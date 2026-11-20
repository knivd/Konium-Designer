import { describe, expect, it } from 'vitest';
import { layoutRich, parseHtml, sanitise, type RunStyle } from '../src/app/diagram/richtext';
import { cells, change, readDrawio, setLabelRaw, writeDrawio, labelSource } from '../src/formats/drawio';
import viewSrc from '../src/app/DiagramView.tsx?raw';
import menuSrc from '../src/app/MenuBar.tsx?raw';

const base: RunStyle = { bold: false, italic: false, underline: false, strike: false, size: 12, colour: '#000000', family: 'Helvetica', shift: 0 };
const texts = (html: string) => parseHtml(html, base).map((b) => b.runs.map((r) => r.text).join(''));

describe('Diagrams D4: formatted labels', () => {
  it('blocks: a heading and a paragraph (their sizes and margins), divs and line breaks, entities', () => {
    const b = parseHtml('<h1 style="margin-top: 0px;">Heading</h1><p>Some text</p>', base);
    expect(b.map((x) => x.runs[0]!.text)).toEqual(['Heading', 'Some text']);
    expect([b[0]!.runs[0]!.st.size, b[0]!.runs[0]!.st.bold, b[0]!.before]).toEqual([24, true, 0]);
    expect(b[1]!.before).toBeCloseTo(24 * 0.67);
    expect(texts('one<br>two<div>three</div>&lt;4&gt;&amp;&nbsp;5')).toEqual(['one', 'two', 'three', '<4>& 5']);
  });

  it('runs: bold, italic, underline, strikethrough, colour, size, font, superscript; styles and <font>', () => {
    const r = parseHtml('<b>B</b><i>I</i><u>U</u><s>S</s><font color="#ff0000" face="Courier New">F</font><span style="font-size: 20px; color: rgb(0, 0, 255); font-weight: bold">P</span>x<sup>2</sup>', base)[0]!.runs;
    expect(r.map((x) => x.text).join('')).toBe('BIUSFPx2');
    expect([r[0]!.st.bold, r[1]!.st.italic, r[2]!.st.underline, r[3]!.st.strike]).toEqual([true, true, true, true]);
    expect([r[4]!.st.colour, r[4]!.st.family]).toEqual(['#ff0000', 'Courier New']);
    expect([r[5]!.st.size, r[5]!.st.colour, r[5]!.st.bold]).toEqual([20, 'rgb(0, 0, 255)', true]);
    expect([r[7]!.st.shift, r[7]!.st.size]).toEqual([1, 9]);
  });

  it('lists with bullets and numbers, indented; alignment from the block', () => {
    const b = parseHtml('<ul><li>a</li><li>b</li></ul><ol><li>c</li></ol><div style="text-align: right;">r</div>', base);
    expect(b.map((x) => [x.bullet, x.indent, x.runs[0]!.text])).toEqual([['•', 40, 'a'], ['•', 40, 'b'], ['1.', 40, 'c'], [undefined, 0, 'r']]);
    expect(b[3]!.align).toBe('right');
  });

  it('laid out: words wrapped to the width, lines as tall as their biggest font', () => {
    const m = (t: string, st: RunStyle) => t.length * st.size * 0.5;
    const lay = layoutRich(parseHtml('aaa bbb ccc <b style="font-size: 24px">ddd</b>', base), 50, 'left', m);
    expect(lay.lines.map((l) => l.segs.map((s) => s.text).join(''))).toEqual(['aaa bbb', 'ccc', 'ddd']);
    expect(lay.lines[2]!.h).toBeCloseTo(28.8);
    expect(layoutRich(parseHtml('aaa bbb ccc', base), Infinity, 'left', m).lines).toHaveLength(1);
  });

  it('what the editor keeps: formatting only (no scripts, handlers or script links)', () => {
    const out = sanitise('<b onclick="x()">B</b><script>alert(1)</script><a href="javascript:x">j</a><a href="https://gydel.games">g</a><span style="color: red; position: fixed; background: url(x)">s</span><img src=x onerror=y>');
    expect(out).toBe('<b>B</b><a>j</a><a href="https://gydel.games">g</a><span style="color: red;">s</span>');
  });

  it('a formatted label written as given and read back; the editor\'s formatting bar', () => {
    const d = readDrawio(new TextEncoder().encode('<mxfile><diagram id="p" name="P"><mxGraphModel><root><mxCell id="0" /><mxCell id="1" parent="0" /><mxCell id="a" value="" style="html=1;" vertex="1" parent="1"><mxGeometry width="80" height="40" as="geometry" /></mxCell></root></mxGraphModel></diagram></mxfile>'), 'R.DgmDoc');
    change(d, 'Label', () => setLabelRaw(d.pages[0]!, 'a', '<b>Bold</b> &amp; plain'), d.pages[0]);
    const back = readDrawio(writeDrawio(d), 'R.DgmDoc');
    expect(labelSource(cells(back.pages[0]!).find((c) => c.id === 'a')!)).toBe('<b>Bold</b> &amp; plain');
    expect(viewSrc).toContain('<RichBar ');
    expect(viewSrc).toMatch(/sanitise\(richEl\.current\?\.innerHTML/);
  });
});

describe('The top bar: Gydel', () => {
  it('a link to gydel.games in a new tab, next to Support Konium', () => {
    expect(menuSrc).toMatch(/<a class="menubar-icon gydel" href="https:\/\/gydel\.games" target="_blank" rel="noopener" title="Gydel: for your spare moments \(gydel\.games\)"/);
    expect(menuSrc.indexOf('menubar-icon gydel')).toBeLessThan(menuSrc.indexOf('menubar-icon support'));
  });
});
