/**
 * The address a per-user limit counts by (the Workers' daily allowances and rate limits): an IPv4
 * address as it is; an IPv6 one by its /64, the network a subscriber is given. Every address in
 * that network is the subscriber's to choose, so counting each one apart would let one person
 * pass for as many users as they liked.
 */
export function limitKey(ip: string): string {
  const s = ip.trim().toLowerCase().split('%')[0]!;
  if (!s.includes(':')) return s;
  // An IPv4 address written as IPv6 (::ffff:192.0.2.1)
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return mapped[1]!;
  const [head = '', tail] = s.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}
