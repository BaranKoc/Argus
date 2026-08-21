const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  CANONICAL_IDENTITY,
  contentProblems,
  normalizePath,
  pathProblems,
} = require('./privacy-check.cjs');

const ROOT = path.resolve(__dirname, '..');
function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd ?? ROOT,
    encoding: options.encoding ?? 'utf8',
    env: options.env ?? process.env,
    input: options.input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function commandExists(command, args = ['--version']) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return !result.error && result.status === 0;
}

function assertSafeToRewrite() {
  if (!commandExists('git')) throw new Error('Git bulunamadı.');
  const inside = git(['rev-parse', '--is-inside-work-tree']).trim();
  if (inside !== 'true') throw new Error('Komut bir Git çalışma ağacında çalıştırılmalı.');
  if (git(['status', '--porcelain=v1', '-z']).length > 0) {
    throw new Error('History rewrite için çalışma ağacı ve index tamamen temiz olmalı.');
  }
  if (spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: ROOT, windowsHide: true }).status !== 0) {
    throw new Error('Detached HEAD desteklenmiyor; rewrite öncesinde bir branch checkout edin.');
  }
  if (git(['submodule', 'status']).trim()) {
    throw new Error('Submodule içeren depolar bu araç tarafından otomatik yeniden yazılmaz.');
  }

  const annotatedTags = git(['for-each-ref', '--format=%(refname) %(objecttype)', 'refs/tags'])
    .split(/\r?\n/)
    .filter((line) => line.endsWith(' tag'));
  if (annotatedTags.length > 0) {
    throw new Error('Annotated tag bulundu; imzaları sessizce bozmamak için rewrite durduruldu.');
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveBackupPath(value) {
  if (value) return path.resolve(value);
  return path.join(os.tmpdir(), `argus-history-backup-${timestamp()}.git`);
}

function createMirrorBackup(backupPath) {
  if (fs.existsSync(backupPath)) throw new Error(`Yedek hedefi zaten var: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  git(['clone', '--mirror', '--no-hardlinks', ROOT, backupPath], { stdio: 'inherit' });
  git(['fsck', '--full'], { cwd: backupPath, stdio: 'inherit' });
}

function parseIndexEntries(raw) {
  return raw.toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, oid, stage] = entry.slice(0, tab).split(' ');
    return { mode, oid, stage, file: normalizePath(entry.slice(tab + 1)) };
  });
}

function sanitizeCommitMessage(message) {
  const lines = message
    .split('\n')
    .filter((line) => !/^(?:Co-Authored-By|Claude-Session):/i.test(line));
  return lines.join('\n').replace(/\n{3,}$/g, '\n\n');
}

function rewriteBlob(entry, indexEnv) {
  if (pathProblems(entry.file).length > 0) {
    git(['update-index', '--force-remove', '--', entry.file], { env: indexEnv });
    return { removed: true, changed: true };
  }

  return { removed: false, changed: false };
}

function parseCommit(raw) {
  const separator = raw.indexOf('\n\n');
  const headers = raw.slice(0, separator).split('\n');
  const dates = {};
  for (const role of ['author', 'committer']) {
    const line = headers.find((value) => value.startsWith(`${role} `));
    const match = line?.match(/^[^ ]+ .* <[^>]*> (\d+ [+-]\d{4})$/);
    if (!match) throw new Error(`Commit ${role} tarihi çözümlenemedi.`);
    dates[role] = match[1];
  }
  return {
    message: sanitizeCommitMessage(raw.slice(separator + 2)),
    authorDate: dates.author,
    committerDate: dates.committer,
  };
}

function rewriteCommits(indexPath) {
  const commits = git(['rev-list', '--reverse', '--topo-order', '--all'])
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const mapping = new Map();
  const indexEnv = { ...process.env, GIT_INDEX_FILE: indexPath };
  let changedBlobs = 0;
  let removedPaths = 0;

  for (const oldCommit of commits) {
    if (fs.existsSync(indexPath)) fs.rmSync(indexPath);
    git(['read-tree', `${oldCommit}^{tree}`], { env: indexEnv });
    const entries = parseIndexEntries(git(['ls-files', '-s', '-z'], { env: indexEnv, encoding: 'buffer' }));
    for (const entry of entries) {
      if (entry.stage !== '0') throw new Error(`Beklenmeyen index stage: ${entry.file}`);
      const result = rewriteBlob(entry, indexEnv);
      if (result.changed) changedBlobs += 1;
      if (result.removed) removedPaths += 1;
    }

    const newTree = git(['write-tree'], { env: indexEnv }).trim();
    const parents = git(['show', '-s', '--format=%P', oldCommit]).trim().split(' ').filter(Boolean);
    const rawCommit = git(['cat-file', '-p', oldCommit]);
    const parsed = parseCommit(rawCommit);
    const commitArgs = ['commit-tree', newTree];
    for (const parent of parents) {
      const mapped = mapping.get(parent);
      if (!mapped) throw new Error(`Parent mapping bulunamadı: ${parent}`);
      commitArgs.push('-p', mapped);
    }
    const identityEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: CANONICAL_IDENTITY.name,
      GIT_AUTHOR_EMAIL: CANONICAL_IDENTITY.email,
      GIT_AUTHOR_DATE: parsed.authorDate,
      GIT_COMMITTER_NAME: CANONICAL_IDENTITY.name,
      GIT_COMMITTER_EMAIL: CANONICAL_IDENTITY.email,
      GIT_COMMITTER_DATE: parsed.committerDate,
    };
    const newCommit = git(commitArgs, { env: identityEnv, input: parsed.message }).trim();
    mapping.set(oldCommit, newCommit);
  }

  if (fs.existsSync(indexPath)) fs.rmSync(indexPath);
  return { mapping, commits: commits.length, changedBlobs, removedPaths };
}

function rewritableRefs() {
  return git([
    'for-each-ref',
    '--format=%(refname)%00%(objecttype)%00%(objectname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [ref, type, oid] = line.split('\0');
      return { ref, type, oid };
    })
    .filter(({ type }) => type === 'commit')
    .filter(({ ref }) => spawnSync('git', ['symbolic-ref', '-q', ref], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    }).status !== 0);
}

function updateRefs(mapping) {
  const updates = [];
  for (const { ref, oid } of rewritableRefs()) {
    const newOid = mapping.get(oid);
    if (!newOid) throw new Error(`Ref mapping bulunamadı: ${ref}`);
    if (newOid !== oid) updates.push({ ref, oldOid: oid, newOid });
  }
  for (const update of updates) {
    git(['update-ref', update.ref, update.newOid, update.oldOid]);
  }
  return updates;
}

function purgeOldObjects() {
  git(['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all']);
  git(['gc', '--prune=now']);
  git(['fsck', '--full'], { stdio: 'inherit' });
}

function synchronizeWorktree() {
  git(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
}

function verifyFinalState() {
  if (git(['status', '--porcelain=v1', '-z']).length > 0) {
    throw new Error('Rewrite sonrası çalışma ağacı HEAD ile aynı değil; mirror yedeğinden inceleyin.');
  }
  execFileSync(process.execPath, [path.join(ROOT, 'utility', 'privacy-check.cjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  execFileSync(process.execPath, [path.join(ROOT, 'utility', 'privacy-check.cjs'), '--history'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
  });
}

function preflightCurrentObjects() {
  const output = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)']);
  const blobs = output.split(/\r?\n/).filter((line) => line.endsWith(' blob'));
  const pathsByBlob = new Map();
  for (const line of git(['rev-list', '--objects', '--all']).split(/\r?\n/)) {
    const [oid, ...pathParts] = line.split(' ');
    if (pathParts.length > 0) pathsByBlob.set(oid, [normalizePath(pathParts.join(' '))]);
  }
  for (const line of blobs) {
    const oid = line.slice(0, 40);
    const buffer = git(['cat-file', 'blob', oid], { encoding: 'buffer' });
    const problems = contentProblems(buffer, pathsByBlob.get(oid) ?? []);
    if (problems.length > 0) {
      throw new Error(`Blob ${oid.slice(0, 12)} gizlilik adayı içeriyor; içerik otomatik değiştirilmez.`);
    }
  }
}

function parseOptions(argv) {
  const execute = argv.includes('--execute');
  const backupIndex = argv.indexOf('--backup-dir');
  if (backupIndex !== -1 && !argv[backupIndex + 1]) throw new Error('--backup-dir bir yol gerektirir.');
  return {
    execute,
    backupPath: resolveBackupPath(backupIndex === -1 ? null : argv[backupIndex + 1]),
  };
}

function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  assertSafeToRewrite();
  preflightCurrentObjects();

  if (!options.execute) {
    console.log('[history-rewrite] Hazır: çalışma ağacı temiz, ref/tag yapısı destekleniyor.');
    console.log(`[history-rewrite] Çalıştırmak için: npm run privacy-rewrite -- --execute --backup-dir "${options.backupPath}"`);
    return;
  }

  console.log(`[history-rewrite] Bağımsız mirror yedeği oluşturuluyor: ${options.backupPath}`);
  createMirrorBackup(options.backupPath);
  const indexPath = path.join(git(['rev-parse', '--git-dir']).trim(), 'privacy-rewrite-index');
  const result = rewriteCommits(path.resolve(ROOT, indexPath));
  const updates = updateRefs(result.mapping);
  synchronizeWorktree();
  purgeOldObjects();
  verifyFinalState();

  console.log(`[history-rewrite] Tamamlandı: ${result.commits} commit, ${updates.length} ref, ${result.changedBlobs} blob dönüşümü, ${result.removedPaths} özel yol kaldırma.`);
  console.log(`[history-rewrite] Yedek: ${options.backupPath}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[history-rewrite] DURDURULDU: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { main, sanitizeCommitMessage };
