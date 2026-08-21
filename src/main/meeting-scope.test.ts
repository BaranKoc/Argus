import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseMeetingScope } from './meeting-scope.ts';

describe('live:start meeting scope', () => {
  it('accepts the two scopes the engine knows', () => {
    assert.equal(parseMeetingScope({ meetingScope: 'group' }), 'group');
    assert.equal(parseMeetingScope({ meetingScope: 'two-party' }), 'two-party');
  });

  // Unlike the language, a missing scope is legitimate: it is what every recording made
  // before this option existed sent, and 'group' is exactly what those meetings were.
  it('falls back to group when the caller says nothing', () => {
    assert.equal(parseMeetingScope({}), 'group');
    assert.equal(parseMeetingScope({ meetingScope: undefined }), 'group');
    assert.equal(parseMeetingScope(null), 'group');
    assert.equal(parseMeetingScope({ meetingLanguage: 'turkish' }), 'group');
  });

  // An unrecognised value is a contract disagreement, not a default. Analysing a group
  // meeting as two-party would merge everyone on the far end into one "Uzak Konuşmacı",
  // and nothing in the finished meeting would say why.
  it('refuses a value it does not know', () => {
    for (const bad of ['two', 'ikili', 'TWO-PARTY', '', 2, true, {}]) {
      assert.throws(
        () => parseMeetingScope({ meetingScope: bad }),
        /Geçersiz toplantı türü/,
        String(bad),
      );
    }
  });
});
