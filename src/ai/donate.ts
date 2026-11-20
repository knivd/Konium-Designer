/**
 * The words of the now-and-then donation ask (src/platform/donate.ts): Konium Designer's own, or
 * the day's wording the Konium AI service writes from the same facts. The app and the service
 * share this file, so a note is held to the same rules on both sides: plain English sentences,
 * the app's name, no links, figures, markup or long dashes, nothing beyond the facts.
 */

/** The ask in Konium Designer's own words (also whenever there is no note for the day). */
export const DONATE_TEXT = 'Konium Designer is supported entirely by voluntary donations from the people who use it. If it has been useful to you and you would like to see it go further, a donation of any amount would be very much appreciated.';

/** What a note may say, and nothing more. */
export const DONATE_FACTS = [
  'Konium Designer is free: no adverts, no accounts, nothing locked away.',
  'It is supported entirely by voluntary donations from the people who use it.',
  'It is a side project, made to help others with their own projects.',
  'Donations help it go further.',
  'Any amount is welcome, and not giving is fine too.',
];

/** The note's request to the model: today's wording of the same ask. */
export function donateMessages(day: string): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        'You write one short, warm and modest note asking the user of a free design program for a voluntary donation.',
        'Use only these facts and claim nothing else (no numbers, no names of people, no promises, no comparisons):',
        ...DONATE_FACTS.map((f) => `- ${f}`),
        'Rules: British English; two or three sentences, 120 to 330 characters in all; name the program as "Konium Designer" at least once;',
        'no links, no figures or digits, no emoji, no markdown, no quotation marks, no dashes of any kind; at most one exclamation mark;',
        'no pressure, guilt or urgency. Answer with the note alone.',
      ].join('\n'),
    },
    { role: 'user', content: `Write the note for ${day}, in your own words, different from this one: ${DONATE_TEXT}` },
  ];
}

const BANNED = /\b(KD|AD|Altium|Protel|urgent|urgently|guilt|must|now or never|limited time)\b/i;

/** A note fit to show (whitespace tidied, wrapping quotes taken off), else null. */
export function fitNote(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length < 80 || s.length > 340) return null;
  if (!s.includes('Konium Designer')) return null;
  // Plain sentences only: letters, spaces and ordinary punctuation; no figures, links, markup or long dashes
  if (!/^[A-Za-z ,.;:'’?!()-]+$/.test(s)) return null;
  if (/https?|www\.|\.(app|com|org|net)\b/i.test(s) || BANNED.test(s)) return null;
  if ((s.match(/!/g) ?? []).length > 1) return null;
  if (!/[.!]$/.test(s)) return null;
  const sentences = s.split(/(?<=[.!?])\s+/).length;
  return sentences <= 4 ? s : null;
}
