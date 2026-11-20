/**
 * The help in a tab of its own (Help › User Guide, Help › Scripting Reference): one chapter at a
 * time, the book's chapters on the left with the open one's sections, a search across the book,
 * links between sections of any book, pictures (full size on a click), and scripts to copy or try.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { helpOpen, notify, openHelp } from './state';
import { showPanel } from './dock/store';
import { showDialog } from './dialogs';
import { NewsPicture } from './Home';
import { BOOKS, findSection, plain, searchBook, sectionWords } from '../help/books';
import type { Block, Section } from '../help/types';
import { pictureUrl } from '../help/pictures';
import { freeName, saveScript } from '../scripting/store';
import { showScript } from './scripts';

/** Text with `code`, **bold** and [links](#section). */
export function Inline({ text, go }: { text: string; go: (id: string) => void }) {
  const out: ComponentChildren[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(#([^)]+)\)/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) out.push(<code key={k++}>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong key={k++}>{m[2]}</strong>);
    else { const id = m[4]!; out.push(<a key={k++} href={`#${id}`} onClick={(e) => { e.preventDefault(); go(id); }}>{m[3]}</a>); }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const KEYWORDS = new Set(['const', 'let', 'var', 'for', 'of', 'in', 'if', 'else', 'return', 'throw', 'new', 'continue', 'break', 'while', 'function', 'async', 'await', 'true', 'false', 'null', 'undefined', 'typeof']);
/** A script lightly coloured: comments, strings, numbers, keywords. */
function Code({ code }: { code: string }) {
  const out: ComponentChildren[] = [];
  const re = /(\/\/[^\n]*)|('(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*")|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    if (m[1]) out.push(<span key={k++} class="hc-c">{m[1]}</span>);
    else if (m[2]) out.push(<span key={k++} class="hc-s">{m[2]}</span>);
    else if (m[3]) out.push(<span key={k++} class="hc-n">{m[3]}</span>);
    else if (KEYWORDS.has(m[4]!)) out.push(<span key={k++} class="hc-k">{m[4]}</span>);
    else out.push(m[4]);
    last = re.lastIndex;
  }
  if (last < code.length) out.push(code.slice(last));
  return <code>{out}</code>;
}

/** A picture, read when it comes into view; full size on a click. */
function Picture({ id, alt, caption }: { id: string; alt: string; caption?: string }) {
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  useEffect(() => { let live = true; void pictureUrl(id).then((u) => { if (live) setSrc(u); }); return () => { live = false; }; }, [id]);
  return (
    <figure class="help-fig">
      {src
        ? <button class="help-shot" title="Show full size" onClick={() => showDialog(NewsPicture, { src, alt, title: caption ?? 'Picture' })}><img src={src} alt={alt} /></button>
        : <div class="help-shot-missing" role="img" aria-label={alt}>{src === null ? alt : ''}</div>}
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Keys, as keys. */
const Keys = ({ k }: { k: string }) => <>{k.split(/(?<=[^+])\+(?=.)/).map((p, i) => <span key={i}>{i > 0 && '+'}<kbd>{p}</kbd></span>)}</>;

/** A name for a script tried from the reference: its first comment, else the section's title. */
const nameOf = (code: string, section: string) => (/^\/\/\s*(.+)/.exec(code)?.[1]?.replace(/[.:]$/, '').slice(0, 60) ?? section);

function BlockView({ b, s, go }: { b: Block; s: Section; go: (id: string) => void }) {
  if ('p' in b) return <p><Inline text={b.p} go={go} /></p>;
  if ('note' in b) return <p class="help-note"><Inline text={b.note} go={go} /></p>;
  if ('list' in b) return <ul>{b.list.map((t, i) => <li key={i}><Inline text={t} go={go} /></li>)}</ul>;
  if ('steps' in b) return <ol>{b.steps.map((t, i) => <li key={i}><Inline text={t} go={go} /></li>)}</ol>;
  if ('img' in b) return <Picture id={b.img} alt={b.alt} caption={b.caption} />;
  if ('keys' in b) {
    return (
      <table class="help-table help-keys">
        <tbody>{b.keys.map(([k, what], i) => <tr key={i}><td><Keys k={k} /></td><td><Inline text={what} go={go} /></td></tr>)}</tbody>
      </table>
    );
  }
  if ('code' in b) {
    const copy = () => { void navigator.clipboard?.writeText(b.code).then(() => notify('Copied'), () => notify('The browser didn’t allow copying', 'error')); };
    const tryIt = () => {
      const id = saveScript({ name: freeName(nameOf(b.code, s.title)), code: `${b.code}\n` });
      showScript(id);
      showPanel('scripts');
      notify('Added to your scripts: run it from the Scripts panel');
    };
    return (
      <div class="help-code">
        <pre><Code code={b.code} /></pre>
        <div class="help-code-acts">
          <button class="link small" onClick={copy}>Copy</button>
          <button class="link small" title="Add it to your scripts and show it in the Scripts panel" onClick={tryIt}>Try it</button>
        </div>
      </div>
    );
  }
  if ('table' in b) {
    return (
      <table class="help-table">
        <thead><tr>{b.head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{b.table.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{j === 0 && b.codeCol ? <code>{c}</code> : <Inline text={c} go={go} />}</td>)}</tr>)}</tbody>
      </table>
    );
  }
  return (
    <table class="help-table api">
      <thead><tr><th>Name</th><th>Type</th><th>What it is</th></tr></thead>
      <tbody>{b.rows.map(([n, t, d]) => <tr key={n}><td><code>{n}</code></td><td>{t}</td><td><Inline text={d} go={go} /></td></tr>)}</tbody>
    </table>
  );
}

/** A line of a section's text around the first word searched for. */
function snippet(s: Section, q: string): string {
  const text = plain(sectionWords(s)).replace(/\s+/g, ' ');
  const w = q.toLowerCase().split(/\s+/).filter(Boolean)[0] ?? '';
  const i = Math.max(0, text.toLowerCase().indexOf(w, s.title.length));
  const from = Math.max(0, i - 50);
  return `${from > 0 ? '…' : ''}${text.slice(from, from + 150)}…`;
}

/**
 * Where the reader was in the help (26.192): its chapter, how far down, and what was being
 * searched for. The help's tab can be left for a document's and come back to, which draws the page
 * anew; it then opens where it was read last, not at its start. A new request for help (a menu
 * command, F1, a link from elsewhere) goes where it asks, as before.
 */
let place: { n: number; topic: string; chapter: string; top: number; q: string } | null = null;

export function HelpPage() {
  const h = helpOpen.value;
  const book = BOOKS[h?.topic ?? 'guide'];
  const was = place && h && place.n === h.n && place.topic === h.topic && book.chapters.some((c) => c.id === place!.chapter) ? place : null;
  const [chapterId, setChapter] = useState(was?.chapter ?? book.chapters[0]?.id ?? '');
  const [q, setQ] = useState(was?.q ?? '');
  const body = useRef<HTMLDivElement>(null);
  /** The request this page has answered (so coming back to its tab does not answer it again). */
  const answered = useRef<number | null>(was ? was.n : null);
  const chapter = book.chapters.find((c) => c.id === chapterId) ?? book.chapters[0];
  /** Show a section (in this book or another), or a chapter's start. */
  const go = (id: string) => {
    const f = findSection(id);
    if (!f) { const c = book.chapters.find((x) => x.id === id); if (c) { setChapter(c.id); setQ(''); requestAnimationFrame(() => body.current?.scrollTo({ top: 0 })); } return; }
    if (f.book.id !== book.id) { openHelp(f.book.id, id); return; }
    setQ('');
    setChapter(f.chapter.id);
    requestAnimationFrame(() => requestAnimationFrame(() => body.current?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' })));
  };
  useEffect(() => {
    if (h && answered.current === h.n && was) {
      // Back on the help's tab: down to where it was (again once its pictures have their heights)
      const down = () => { if (body.current) body.current.scrollTop = was.top; };
      down(); requestAnimationFrame(down); const t = setTimeout(down, 200);
      return () => clearTimeout(t);
    }
    answered.current = h?.n ?? null;
    if (h?.at) go(h.at);
    else { setChapter(book.chapters[0]?.id ?? ''); body.current?.scrollTo({ top: 0 }); }
    return undefined;
  }, [h?.n, h?.topic]);
  // What to come back to
  const remember = (top = body.current?.scrollTop ?? 0) => { if (h) place = { n: h.n, topic: h.topic, chapter: chapterId, top, q }; };
  useEffect(() => { remember(); }, [chapterId, q, h?.n, h?.topic]);
  const hits = useMemo(() => searchBook(book, q), [q, book]);
  const at = book.chapters.indexOf(chapter!);
  if (!chapter) return <div class="help-page"><div class="help-body"><h1>{book.title}</h1><p class="muted">Nothing here yet.</p></div></div>;
  return (
    <div class="help-page" aria-label={book.title}>
      <nav class="help-nav" aria-label="Contents">
        <input type="search" class="help-search" placeholder={`Search the ${book.title}`} aria-label={`Search the ${book.title}`} value={q}
          onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => e.stopPropagation()} />
        <ul class="help-chapters">
          {book.chapters.map((c) => (
            <li key={c.id} class={c.id === chapter.id ? 'on' : ''}>
              {book.chapters.length > 1 && <a href={`#${c.id}`} class="help-chapter" onClick={(e) => { e.preventDefault(); go(c.id); }}>{c.title}</a>}
              {c.id === chapter.id && (
                <ul>{c.sections.map((s) => <li key={s.id}><a href={`#${s.id}`} onClick={(e) => { e.preventDefault(); go(s.id); }}>{s.title}</a></li>)}</ul>
              )}
            </li>
          ))}
        </ul>
      </nav>
      <div class="help-body" ref={body} onScroll={(e) => remember((e.currentTarget as HTMLDivElement).scrollTop)}>
        {q.trim() ? (
          <>
            <h1>Search: {q}</h1>
            {!hits.length && <p class="muted">No section mentions “{q}”.</p>}
            <ul class="help-hits">
              {hits.map((f) => (
                <li key={f.section.id}>
                  <a href={`#${f.section.id}`} onClick={(e) => { e.preventDefault(); go(f.section.id); }}>{book.chapters.length > 1 ? `${f.chapter.title} › ` : ''}{f.section.title}</a>
                  <div class="small muted">{snippet(f.section, q)}</div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p class="help-book small muted">{book.title}</p>
            <h1>{chapter.title}</h1>
            {chapter.sections.map((s) => (
              <section key={s.id} id={s.id} class="help-section">
                <h2>{s.title}</h2>
                {s.blocks.map((b, i) => <BlockView key={i} b={b} s={s} go={go} />)}
              </section>
            ))}
            {book.chapters.length > 1 && (
              <div class="help-pager">
                {at > 0 && <a href={`#${book.chapters[at - 1]!.id}`} onClick={(e) => { e.preventDefault(); go(book.chapters[at - 1]!.id); }}>‹ {book.chapters[at - 1]!.title}</a>}
                <span class="spacer" />
                {at < book.chapters.length - 1 && <a href={`#${book.chapters[at + 1]!.id}`} onClick={(e) => { e.preventDefault(); go(book.chapters[at + 1]!.id); }}>{book.chapters[at + 1]!.title} ›</a>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
