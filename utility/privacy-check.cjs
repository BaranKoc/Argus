const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL_IDENTITY = Object.freeze({
  name: 'Baran Koc',
  email: 'barankoc269@gmail.com',
});
const PRIVATE_ROOTS = ['meeting_recordings/', 'output/', 'temp/', 'test_media/'];
const PRIVATE_SUFFIXES = ['.local.md'];
const MEDIA_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mkv', '.mov', '.mp3', '.mp4', '.ogg', '.opus', '.wav', '.webm', '.wma',
]);
const PRIVATE_LINK_HOSTS = [
  ['drive', 'google', 'com'].join('.'),
  ['docs', 'google', 'com'].join('.'),
];
const PRIVATE_URL_FRAGMENTS = [
  ['claude', 'ai'].join('.') + '/' + ['code', 'session_'].join('/'),
];
const DEPENDENCY_EMAIL_PATHS = new Set([
  'package-lock.json',
  'engine/package-lock.json',
  'vendor/electron-native-share/package.json',
]);
const SECRET_PATTERNS = [
  new RegExp(['sk', 'ant', '[A-Za-z0-9_-]{16,}'].join('-'), 'i'),
  new RegExp(['ghp', '[A-Za-z0-9]{20,}'].join('_'), 'i'),
  new RegExp(['hf', '[A-Za-z0-9]{20,}'].join('_'), 'i'),
  /AIza[0-9A-Za-z_-]{20,}/i,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  new RegExp(['BEGIN ', '(?:RSA |OPENSSH |EC )?', 'PRIVATE KEY'].join(''), 'i'),
];
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gi;
const WINDOWS_HOME_PATTERN = /[A-Za-z]:\\Users\\[^\\\s]+/i;
const UNIX_HOME_PATTERN = /\/home\/[^/\s]+/i;
const TURKISH_PHONE_PATTERN = /(?:\+?90[ .()-]?)?(?:0?5\d{2})[ .()-]?\d{3}[ .()-]?\d{2}[ .()-]?\d{2}/;

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: options.cwd ?? ROOT,
    encoding: options.encoding ?? 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.stdio,
  });
}

function normalizePath(file) {
  return file.replaceAll('\\', '/');
}

function pathProblems(file) {
  const normalized = normalizePath(file);
  const lower = normalized.toLowerCase();
  const problems = [];

  if (PRIVATE_ROOTS.some((root) => lower.startsWith(root))) {
    problems.push('özel çalışma klasörü Git tarafından izleniyor');
  }
  if (lower.startsWith('control-group/') && lower.endsWith('.json')) {
    problems.push('gerçek control-group çıktısı Git tarafından izleniyor');
  }
  if (path.posix.basename(lower) === '.env' || PRIVATE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    problems.push('yerel/özel dosya Git tarafından izleniyor');
  }
  if (MEDIA_EXTENSIONS.has(path.posix.extname(lower))) {
    problems.push('ses veya video dosyası Git tarafından izleniyor');
  }

  return problems;
}

function isProbablyBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function searchableRepresentations(buffer) {
  const representations = [buffer.toString('utf8'), buffer.toString('latin1')];
  if (buffer.length >= 4) representations.push(buffer.toString('utf16le'));
  return representations;
}

function contentProblems(buffer, candidatePaths = []) {
  const problems = new Set();
  const representations = searchableRepresentations(buffer);
  const dependencyOnly = candidatePaths.length > 0
    && candidatePaths.every((file) => DEPENDENCY_EMAIL_PATHS.has(normalizePath(file)));

  for (const content of representations) {
    const lower = content.toLowerCase();
    if (PRIVATE_LINK_HOSTS.some((host) => lower.includes(host))) {
      problems.add('özel Google Drive/Docs bağlantısı içeriyor');
    }
    if (PRIVATE_URL_FRAGMENTS.some((fragment) => lower.includes(fragment))) {
      problems.add('özel agent oturumu bağlantısı içeriyor');
    }
    if (WINDOWS_HOME_PATTERN.test(content) || UNIX_HOME_PATTERN.test(content)) {
      problems.add('kişisel kullanıcı dizinine ait mutlak yol içeriyor');
    }
    if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) {
      problems.add('yüksek güvenli gizli anahtar/token deseni içeriyor');
    }
    if (TURKISH_PHONE_PATTERN.test(content)) {
      problems.add('olası kişisel telefon numarası içeriyor');
    }

    const emails = content.match(EMAIL_PATTERN) ?? [];
    if (!dependencyOnly && emails.some((email) => email.toLowerCase() !== CANONICAL_IDENTITY.email)) {
      problems.add('kişisel e-posta adresi içeriyor');
    }
  }

  return [...problems];
}

function trackedFiles() {
  return git(['ls-files', '-z'])
    .split('\0')
    .filter(Boolean)
    .map(normalizePath);
}

function auditWorkingTree() {
  const failures = [];
  for (const file of trackedFiles()) {
    for (const problem of pathProblems(file)) failures.push(`${file}: ${problem}`);
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const buffer = fs.readFileSync(absolute);
    for (const problem of contentProblems(buffer, [file])) failures.push(`${file}: ${problem}`);
  }
  return failures;
}

function allGitObjects() {
  const output = git([
    'cat-file',
    '--batch-all-objects',
    '--batch-check=%(objectname) %(objecttype)',
  ]);
  const objects = { blobs: [], commits: [] };
  for (const line of output.trim().split(/\r?\n/)) {
    if (!line) continue;
    const [oid, type] = line.split(' ');
    if (type === 'blob') objects.blobs.push(oid);
    if (type === 'commit') objects.commits.push(oid);
  }
  return objects;
}

function parseTree(commit) {
  const raw = git(['ls-tree', '-rz', '--full-tree', commit], { encoding: 'buffer' });
  const entries = raw.toString('utf8').split('\0').filter(Boolean);
  return entries.map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, type, oid] = entry.slice(0, tab).split(' ');
    return { mode, type, oid, file: normalizePath(entry.slice(tab + 1)) };
  });
}

function parseCommit(raw) {
  const separator = raw.indexOf('\n\n');
  const headers = (separator === -1 ? raw : raw.slice(0, separator)).split('\n');
  const message = separator === -1 ? '' : raw.slice(separator + 2);
  const author = headers.find((line) => line.startsWith('author ')) ?? '';
  const committer = headers.find((line) => line.startsWith('committer ')) ?? '';
  return { author, committer, message };
}

function identityProblem(line, role) {
  const match = line.match(/^[^ ]+ (.*) <([^>]*)> \d+ [+-]\d{4}$/);
  if (!match) return `${role} metadata biçimi okunamadı`;
  const [, name, email] = match;
  if (name !== CANONICAL_IDENTITY.name || email !== CANONICAL_IDENTITY.email) {
    return `${role} kişisel veya canonical olmayan kimlik içeriyor`;
  }
  return null;
}

function shortObject(oid) {
  return oid.slice(0, 12);
}

function auditHistory() {
  const failures = [];
  const { blobs, commits } = allGitObjects();
  const pathsByBlob = new Map();

  for (const commit of commits) {
    const parsed = parseCommit(git(['cat-file', '-p', commit]));
    const authorProblem = identityProblem(parsed.author, 'author');
    const committerProblem = identityProblem(parsed.committer, 'committer');
    if (authorProblem) failures.push(`commit ${shortObject(commit)}: ${authorProblem}`);
    if (committerProblem) failures.push(`commit ${shortObject(commit)}: ${committerProblem}`);
    for (const problem of contentProblems(Buffer.from(parsed.message), [])) {
      failures.push(`commit ${shortObject(commit)} mesajı: ${problem}`);
    }

    for (const entry of parseTree(commit)) {
      if (entry.type !== 'blob') continue;
      if (!pathsByBlob.has(entry.oid)) pathsByBlob.set(entry.oid, new Set());
      pathsByBlob.get(entry.oid).add(entry.file);
      for (const problem of pathProblems(entry.file)) {
        failures.push(`commit ${shortObject(commit)} ${entry.file}: ${problem}`);
      }
    }
  }

  for (const oid of blobs) {
    const candidatePaths = [...(pathsByBlob.get(oid) ?? [])];
    const buffer = git(['cat-file', 'blob', oid], { encoding: 'buffer' });
    for (const problem of contentProblems(buffer, candidatePaths)) {
      const location = candidatePaths.length > 0
        ? candidatePaths.slice(0, 3).join(', ')
        : 'yolu bulunamayan/dangling blob';
      failures.push(`blob ${shortObject(oid)} (${location}): ${problem}`);
    }
  }

  return [...new Set(failures)];
}

function printFailures(failures, scope) {
  if (failures.length === 0) {
    console.log(`[gizlilik] Başarılı: ${scope} içinde özel yol, proje kimliği, kişisel bağlantı veya gizli anahtar bulunmadı.`);
    return;
  }

  console.error(`[gizlilik] ${scope} kontrolü başarısız (${failures.length} bulgu):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
}

function main(argv = process.argv.slice(2)) {
  const history = argv.includes('--history');
  const failures = history ? auditHistory() : auditWorkingTree();
  printFailures(failures, history ? 'tüm Git object database' : 'izlenen çalışma ağacı');
}

if (require.main === module) main();

module.exports = {
  CANONICAL_IDENTITY,
  auditHistory,
  auditWorkingTree,
  contentProblems,
  isProbablyBinary,
  main,
  normalizePath,
  pathProblems,
};
