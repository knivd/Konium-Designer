import { describe, expect, it } from 'vitest';
import { versionNumber, withoutSiteAnalytics } from '../src/platform/distribution';
import page from '../index.html?raw';

describe('versions', () => {
  it('release numbers compare as year, then build', () => {
    expect(versionNumber('26.033')).toBeGreaterThan(versionNumber('26.032'));
    expect(versionNumber('27.001')).toBeGreaterThan(versionNumber('26.999'));
    expect(versionNumber('26.100')).toBeGreaterThan(versionNumber('26.099'));
    expect(versionNumber('26.033')).toBe(versionNumber('26.033'));
  });
});

describe('the website and a downloaded copy', () => {
  it('the page carries no visit-counting script: the app adds it at konium.app only (26.098)', () => {
    expect(page).not.toMatch(/cloud\.umami\.is/);
  });
  it('an older page\'s visit counting is still left out of a download', () => {
    const old = page.replace('  <!-- The icon inline', '  <!-- Visit counts for the konium.app website. -->\n  <script defer src="https://cloud.umami.is/script.js" data-website-id="x" data-domains="konium.app"></script>\n  <!-- The icon inline');
    expect(old).toMatch(/cloud\.umami\.is/);
    const copy = withoutSiteAnalytics(old);
    expect(copy).toBe(page);
  });
});
