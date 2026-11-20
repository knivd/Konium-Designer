/**
 * The now-and-then donation ask (src/platform/donate.ts): a small card in the corner that waits
 * to be answered and stands in the way of nothing. Chip in... opens Konium Designer's page on the
 * payment service, as the tip jar does, and closes the card; whether a donation follows nobody can
 * see, so only "I've chipped in" (the user's word for it) rests the ask for half a year.
 */
import { ColourIcon } from './icons';
import { openSupportPage, SUPPORT } from './dialogs/Support';
import { online } from '../platform/distribution';
import { closeDonateAsk, donateAsk, gaveFromAsk } from '../platform/donate';
import { notify } from './state';

export function DonateAsk() {
  const ask = donateAsk.value;
  if (!ask) return null;
  const can = !!SUPPORT.url && online.value;
  return (
    <aside class="donate-ask" role="complementary" aria-label="Support Konium Designer">
      <ColourIcon name="tipJar" size={32} />
      <div class="donate-body">
        <p>{ask.text}</p>
        <div class="donate-acts">
          <button class="btn default" disabled={!can} title={can ? `Opens Konium Designer's page on ${SUPPORT.service}` : 'Needs an internet connection'}
            onClick={() => { openSupportPage(); closeDonateAsk(); }}>Chip in...</button>
          <button class="btn" onClick={closeDonateAsk}>Not now</button>
          <button class="btn link" title="Thank you! No more asking for half a year" onClick={() => { gaveFromAsk(); notify('Thank you for chipping in!'); }}>I've chipped in</button>
        </div>
      </div>
      <button class="donate-x" aria-label="Close" title="Close" onClick={closeDonateAsk}>×</button>
    </aside>
  );
}
