import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXTERNAL_LINKS, resolveExternalLink } from './external-links.ts';

describe('external links', () => {
  it('resolves every known id to an https URL', () => {
    for (const [id, url] of Object.entries(EXTERNAL_LINKS)) {
      assert.equal(resolveExternalLink(id), url, id);
      assert.match(url, /^https:\/\//, id);
    }
  });

  // The renderer sends an id, so anything that is not one must not reach shell.openExternal.
  // Object.hasOwn, not `in`: 'toString' and 'constructor' are on the prototype and would
  // otherwise resolve to a non-URL and be handed to the OS.
  it('refuses anything that is not a listed id', () => {
    for (const bad of ['https://example.com', 'toString', 'constructor', '', 42, null, undefined]) {
      assert.throws(() => resolveExternalLink(bad), /Bilinmeyen bağlantı/, String(bad));
    }
  });

  // The add-on ships its own CUDA runtime; the toolkit is a multi-GB download that fixes
  // nothing for an end user. If this ever points there, the guide card is lying.
  it('points at the driver download, not the CUDA Toolkit', () => {
    assert.match(EXTERNAL_LINKS['nvidia-driver'], /nvidia\.com/);
    assert.doesNotMatch(EXTERNAL_LINKS['nvidia-driver'], /toolkit/i);
  });
});
