import { describe, expect, it } from 'vitest';
import { CODE_TEMPLATES, caseEdit, changeCase, indentEdit, indentOf, lineSpan, matches, readVsSettings, replaceAll, wordAt } from '../src/core/textOps';

const apply = (t: string, e: { from: number; to: number; text: string } | null) => (e ? t.slice(0, e.from) + e.text + t.slice(e.to) : t);

describe('the text editor\'s edits', () => {
  it('Change Case: the selection, or the word at the caret (upper, lower, capitalised)', () => {
    expect(changeCase('r1 in OUT 1k', 'upper')).toBe('R1 IN OUT 1K');
    expect(changeCase('R1 IN OUT', 'lower')).toBe('r1 in out');
    expect(changeCase('the quick BROWN fox', 'capitalise')).toBe('The Quick Brown Fox');
    const t = '.tran 1u 1m\nV1 in 0';
    expect(apply(t, caseEdit(t, 2, 2, 'word', 'upper'))).toBe('.TRAN 1u 1m\nV1 in 0');
    expect(apply(t, caseEdit(t, 15, 17, 'selection', 'upper'))).toBe('.tran 1u 1m\nV1 IN 0');
    expect(wordAt('a bc d', 4)).toEqual([2, 4]); // just after a word
    expect(caseEdit('   ', 1, 1, 'word', 'upper')).toBeNull();
  });

  it('Indent and Unindent: every line the selection touches (a selection ending at a line\'s start leaves it out)', () => {
    const t = 'R1 a b 1k\nC1 b 0 1n\nL1 b c 1u';
    expect(lineSpan(t, 3, 12)).toEqual([0, 19]);
    expect(lineSpan(t, 0, 10)).toEqual([0, 9]);
    const e = indentEdit(t, 3, 12, false, 4, true)!;
    expect(apply(t, e)).toBe('\tR1 a b 1k\n\tC1 b 0 1n\nL1 b c 1u');
    const back = apply(t, e);
    expect(apply(back, indentEdit(back, 0, 22, true, 4, true))).toBe(t);
    // Spaces: a tab width of them; out takes up to that many
    const sp = indentEdit('x\ny', 0, 3, false, 2, false)!;
    expect(apply('x\ny', sp)).toBe('  x\n  y');
    expect(apply('   x', indentEdit('   x', 4, 4, true, 2, false))).toBe(' x');
    expect(indentOf('  .tran 1u\n', 9)).toBe('  ');
  });

  it('Replace All and the browser marks: every match, ignoring case', () => {
    expect(matches('V(out) OUT vout', 'out')).toEqual([2, 7, 12]);
    expect(replaceAll('R1 out 0 1k\nC1 OUT 0 1n', 'out', 'n2')).toEqual({ text: 'R1 n2 0 1k\nC1 n2 0 1n', count: 2 });
    expect(replaceAll('abc', 'x', 'y').count).toBe(0);
  });

  it('Code templates: SPICE cards and sources, a subcircuit\'s two lines', () => {
    expect(CODE_TEMPLATES.length).toBeGreaterThan(20);
    expect(CODE_TEMPLATES.find(([n]) => n.startsWith('.SUBCKT'))![1]).toContain('\n.ENDS');
  });

  it('Import Editor Settings from › Visual Studio: the Text Editor font and colours (BGR)', () => {
    const xml = `<UserSettings><ApplicationIdentity version="16.0"/><Category name="Environment_Group"><Category name="Environment_FontsAndColors">
      <FontsAndColors Version="2.0"><Categories>
        <Category GUID="{58E96763-1D3B-4E05-B6BA-FF7115FD0B7B}" FontName="Arial" FontSize="9"><Items><Item Name="Plain Text" Foreground="0x00FF0000"/></Items></Category>
        <Category GUID="{A27B4E24-A735-4D1D-B8E7-9716E1E3D8E0}" FontName="Consolas" FontSize="12" CharSet="0" FontIsDefault="No"><Items>
          <Item Name="Plain Text" Foreground="0x00DCDCDC" Background="0x001E1E1E" BoldFont="No"/>
          <Item Name="Comment" Foreground="0x004AA657" Background="0x02000000"/>
          <Item Name="Keyword" Foreground="0x00D69C56"/>
          <Item Name="Identifier" Foreground="0x01000001"/>
        </Items></Category>
      </Categories></FontsAndColors></Category></Category></UserSettings>`;
    expect(readVsSettings(xml)).toEqual({ font: 'Consolas', size: 16, plain: '#dcdcdc', back: '#1e1e1e', comment: '#57a64a', card: '#569cd6', device: undefined });
    expect(() => readVsSettings('<foo/>')).toThrow('not a Visual Studio settings file');
  });
});
