/**
 * Text in the Symbol font, as Windows draws it: the desktop software stores a schematic's Ω as "W"
 * in the Symbol font (µ as "m", ± as byte 0xB1 …) and Windows draws the font's Greek and math
 * glyphs for those codes; a browser draws the letters themselves. Such text is turned into the
 * characters it shows (Adobe's Symbol encoding) and drawn in an ordinary serif font, which has them.
 */
const LOW = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼';
const HIGH = ' ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪ 〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭ ';
// Windows-1252 0x80–0x9F as the text decoded them, back to their byte
const CP1252: Record<string, number> = { '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f };

/** Whether a CSS font family list names the Symbol font first. */
export const isSymbolFamily = (family: string | undefined): boolean => !!family && /^\s*["']?symbol["']?\s*(,|$)/i.test(family);

/** Symbol-font text → the characters Windows shows for it. */
export function fromSymbol(text: string): string {
  let out = '';
  for (const ch of text) {
    const u = ch.codePointAt(0)!;
    const b = u <= 0xff ? u : CP1252[ch] ?? -1;
    if (b >= 0x20 && b <= 0x7e) out += LOW[b - 0x20];
    else if (b >= 0xa0 && b <= 0xff && HIGH[b - 0xa0] !== ' ') out += HIGH[b - 0xa0];
    else out += ch;
  }
  return out;
}
