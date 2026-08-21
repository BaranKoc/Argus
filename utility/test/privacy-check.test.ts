import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const {
  CANONICAL_IDENTITY,
  contentProblems,
  pathProblems,
} = require('../privacy-check.cjs');
const { sanitizeCommitMessage } = require('../rewrite-git-history.cjs');

function privateEmail(): string {
  return ['owner', 'example'].join('@') + ['.', 'com'].join('');
}

describe('privacy path policy', () => {
  it('blocks private roots and history-only private artifacts', () => {
    assert.ok(pathProblems('meeting_recordings/call.dat').length > 0);
    assert.ok(pathProblems('control-group/transcribe/reference.json').length > 0);
    assert.ok(pathProblems('nested/.env').length > 0);
    assert.ok(pathProblems('docs/review.local.md').length > 0);
    assert.ok(pathProblems('fixtures/call.wav').length > 0);
  });

  it('allows public fixtures and environment templates', () => {
    assert.deepEqual(pathProblems('control-group/synthetic/S9.txt'), []);
    assert.deepEqual(pathProblems('engine/.env.example'), []);
  });
});

describe('privacy content policy', () => {
  it('detects email, home path, private link, secret and phone candidates', () => {
    const home = ['C:', 'Users', 'someone', 'project'].join('\\');
    const privateLink = 'https://' + ['drive', 'google', 'com'].join('.') + '/private';
    const secret = ['ghp', 'A'.repeat(24)].join('_');
    const phone = ['+90', '555', '111', '22', '33'].join(' ');
    const content = Buffer.from([
      privateEmail(),
      home,
      privateLink,
      secret,
      phone,
    ].join('\n'));
    const problems = contentProblems(content, ['README.md']);
    assert.equal(problems.length, 5);
  });

  it('allows canonical identity and public upstream dependency metadata', () => {
    assert.deepEqual(
      contentProblems(Buffer.from(CANONICAL_IDENTITY.email), ['README.md']),
      [],
    );
    assert.deepEqual(
      contentProblems(Buffer.from(privateEmail()), ['vendor/electron-native-share/package.json']),
      [],
    );
  });
});

describe('history sanitizers', () => {
  it('drops private agent-session and co-author trailers from commit messages', () => {
    const coAuthor = ['Co-Authored-By: Example', `<${privateEmail()}>`].join(' ');
    const session = 'Claude-Session: https://' + ['claude', 'ai'].join('.') + '/code/' + 'session_' + 'fixture';
    assert.equal(sanitizeCommitMessage(`Subject\n\nBody\n\n${coAuthor}\n${session}\n`), 'Subject\n\nBody\n\n');
  });

  it('keeps ordinary commit message content unchanged', () => {
    assert.equal(sanitizeCommitMessage('Subject\n\nBody\n'), 'Subject\n\nBody\n');
  });
});
