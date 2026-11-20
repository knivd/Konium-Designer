/**
 * A bug report as an email (RFC 5322 / MIME): the text, then each attached file. Built by hand
 * so the Worker needs no packages. Header words outside ASCII are encoded (RFC 2047), bodies
 * are base64 in lines of 76.
 */

export interface MailFile { name: string; type: string; bytes: Uint8Array }
export interface Mail {
  from: string;
  fromName: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  files: MailFile[];
  /** For Message-ID and the boundary. */
  id: string;
  date: Date;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const wrap = (s: string): string => s.replace(/.{1,76}/g, '$&\r\n');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
/** Line breaks and control characters out of a header value. */
export const oneLine = (s: string): string => s.replace(/[\r\n\t\0-\x1f\x7f]+/g, ' ').trim();
/** A header word, encoded when it isn't plain ASCII. */
export const headerWord = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(utf8(s))}?=`);
/** A display name with its address: "Name" <a@b>. */
const mailbox = (name: string, address: string): string => {
  const n = oneLine(name);
  if (!n) return `<${address}>`;
  return /^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/["\\]/g, '')}" <${address}>` : `${headerWord(n)} <${address}>`;
};
/** A file name in Content-Disposition: plain, or RFC 2231 for anything else. */
const fileParam = (name: string): string => {
  const n = oneLine(name).replace(/["\\]/g, '_') || 'file';
  return /^[\x20-\x7e]*$/.test(n) ? `filename="${n}"` : `filename*=UTF-8''${encodeURIComponent(n)}`;
};

export function buildMail(m: Mail): string {
  const domain = m.from.split('@')[1] ?? 'localhost';
  const boundary = `=_konium_${m.id.replace(/[^A-Za-z0-9]/g, '')}`;
  const head = [
    `From: ${mailbox(m.fromName, m.from)}`,
    `To: <${m.to}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    `Subject: ${headerWord(oneLine(m.subject))}`,
    `Date: ${m.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${m.id}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    [`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', wrap(b64(utf8(m.text)))].join('\r\n'),
    ...m.files.map((f) => [
      `--${boundary}`,
      `Content-Type: ${/^[\w.+-]+\/[\w.+-]+$/.test(f.type) ? f.type : 'application/octet-stream'}`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${fileParam(f.name)}`,
      '', wrap(b64(f.bytes)),
    ].join('\r\n')),
  ];
  return `${head.join('\r\n')}\r\n\r\n${parts.join('')}--${boundary}--\r\n`;
}

/** An address as typed: kept only when it looks like one (no spaces, one @, a dot after it). */
export const validEmail = (s: string): string | undefined => {
  const t = s.trim();
  return /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[^\s@<>"(),;:]+$/.test(t) && t.length <= 254 ? t : undefined;
};
