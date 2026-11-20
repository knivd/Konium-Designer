// Tells the search engines that take IndexNow (Bing and others; not Google) which pages of
// konium.app are new or changed. Run it after the site has been uploaded:
//   node website/indexnow.mjs            every page in the live sitemap
//   node website/indexnow.mjs guides/    only the pages whose address has "guides/" in it
// The key is public by design: the engines check it against https://konium.app/<key>.txt, which
// public/ carries. Nothing is sent but the pages' addresses.
const HOST = 'konium.app';
const KEY = '6ae98d54c5fa31736b9038b88de0bb36';
const ORIGIN = `https://${HOST}/`;

const only = process.argv[2];
const text = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return r.text();
};

try {
  if ((await text(`${ORIGIN}${KEY}.txt`)).trim() !== KEY) throw new Error(`${ORIGIN}${KEY}.txt does not hold the key`);
  const urls = [...(await text(`${ORIGIN}sitemap.xml`)).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => !only || u.includes(only));
  if (!urls.length) throw new Error('no pages to send');
  const r = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `${ORIGIN}${KEY}.txt`, urlList: urls }),
  });
  // 200: taken. 202: taken, the key still to be checked. Anything else: not taken.
  console.log(`${urls.length} pages sent to IndexNow: ${r.status}${r.status === 200 || r.status === 202 ? ' (accepted)' : ` ${await r.text()}`}`);
  if (!r.ok) process.exitCode = 1;
} catch (e) {
  console.error(`IndexNow: ${e.message}. Is the site uploaded, with its key file?`);
  process.exitCode = 1;
}
