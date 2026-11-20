"""Parse Altium Designer resource (.rcs) files: process launchers (PL), menu/toolbar/hotkey trees."""
import re, sys, os, json, copy

KEYWORDS = {'pl', 'tree', 'link', 'separator', 'treecopy', 'linkrepeat', 'plrepeat', 'insertion', 'deletion', 'change', 'end'}

def tokenize(text):
    toks = []
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if c in ' \t\r\n':
            i += 1; continue
        if text.startswith('//', i):
            j = text.find('\n', i); i = n if j < 0 else j; continue
        if c == '=':
            toks.append(('=', '=')); i += 1; continue
        if c == "'":
            j = i + 1; buf = []
            while j < n:
                if text[j] == "'":
                    if j + 1 < n and text[j + 1] == "'": buf.append("'"); j += 2; continue
                    break
                buf.append(text[j]); j += 1
            toks.append(('str', ''.join(buf))); i = j + 1; continue
        j = i
        while j < n and text[j] not in " \t\r\n='":
            j += 1
        toks.append(('word', text[i:j])); i = j
    return toks

class P:
    def __init__(self, toks): self.t = toks; self.i = 0
    def peek(self, k=0): return self.t[self.i + k] if self.i + k < len(self.t) else (None, None)
    def next(self): v = self.t[self.i]; self.i += 1; return v
    def attrs(self):
        a = {}
        while self.peek(1)[0] == '=':
            k = self.next()[1]; self.next(); v = self.next()[1]; a[k.lower()] = v
        return a
    def stmt(self):
        kind, word = self.next()
        kw = word.lower()
        if kw not in KEYWORDS: raise ValueError(f'unexpected token {word!r} at {self.i}')
        node = {'kind': kw}
        if self.peek()[0] == 'word' and self.peek(1)[0] != '=' and self.peek()[1].lower() not in KEYWORDS:
            node['id'] = self.next()[1]
        elif self.peek()[0] == 'word' and self.peek(1)[0] != '=':
            node['id'] = self.next()[1]
        elif self.peek()[0] == 'str' and self.peek(1)[0] != '=':   # a quoted id (CAMtastic's 'PLCAMTASTIC:…', 'MNCAMTASTIC_Menu')
            node['id'] = self.next()[1]
        node.update(self.attrs())
        if kw in ('tree', 'insertion'):
            node['children'] = []
            while True:
                k, w = self.peek()
                if k is None: break
                if w.lower() == 'end': self.next(); break
                if w.lower() not in KEYWORDS: self.next(); continue
                node['children'].append(self.stmt())
            return node
        # simple statements end with End (a few are missing it at EOF)
        while self.peek()[0] is not None and self.peek()[1].lower() != 'end':
            # stray tokens: absorb as attrs if possible
            if self.peek(1)[0] == '=': node.update(self.attrs()); continue
            if self.peek()[1].lower() in KEYWORDS: return node
            self.next()
        if self.peek()[0] is not None: self.next()
        return node
    def all(self):
        out = []
        while self.peek()[0] is not None:
            w = self.peek()[1].lower()
            if w == 'end' or w not in KEYWORDS: self.next(); continue
            out.append(self.stmt())
        return out

def load(paths):
    pls, trees, mods, copies = {}, {}, [], []
    def walk(n):
        if n['kind'] == 'tree' and 'id' in n: trees[n['id']] = n
        for c in n.get('children', []): walk(c)
    for p in paths:
        text = open(p, encoding='latin-1').read()
        try: nodes = P(tokenize(text)).all()
        except Exception as e: print('ERR', p, e, file=sys.stderr); continue
        for n in nodes:
            n['file'] = os.path.basename(p)
            if n['kind'] == 'pl' and 'id' in n: pls[n['id']] = n
            elif n['kind'] == 'tree': walk(n)
            elif n['kind'] in ('insertion', 'deletion', 'change'): mods.append(n)
            elif n['kind'] == 'treecopy': copies.append(n)
            elif n['kind'] == 'plrepeat' and 'id' in n: pls[n['id']] = n
    return pls, trees, mods, copies

if __name__ == '__main__':
    pls, trees, mods, copies = load(sys.argv[1:])
    print(len(pls), 'PLs', len(trees), 'trees', len(mods), 'mods', len(copies), 'copies')
    print([t for t in trees if t.startswith('MN')][:80])
