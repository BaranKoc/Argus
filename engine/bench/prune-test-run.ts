// Deletes output/test_run/<timestamp>/ folders that control-group/control-group.md does not
// reference — project policy explicitly leaves this cleanup to a human, since
// "delete this run" is a judgement call the same way "this run is the reference" is
// (see control-group.ts). Never runs automatically; always a deliberate `npm run` call.
//
// Default (no flags): read-only, just prints the candidate list — safe to run anytime.
// --delete: prints the same list, then asks for a literal 'y' before removing anything.

import fs from 'node:fs';
import path from 'node:path';

import { parseControlGroup } from './control-group.ts';
import { CONTROL_GROUP_DIR, OUTPUT_TEST_RUN_DIR } from './matrix.ts';
import { ask, closeAsk } from '../test/manual-utils.ts';

// A folder written to in the last 10 minutes might be an in-progress `test-run` from a
// concurrent session — it's legitimately unreferenced yet, so control-group.md alone
// can't tell "orphaned" apart from "brand new". Age it out instead of racing it.
const MIN_AGE_MS = 10 * 60 * 1000;

interface Candidate {
  dir: string;
  name: string;
  bytes: number;
  mtimeMs: number;
}

interface FileCandidate {
  path: string;
  folderName: string;
  bytes: number;
  mtimeMs: number;
}

interface ScanStats {
  totalFolders: number;
  keptFolders: number;
  mixedFolders: number;
}

function dirSizeAndNewestMtime(dir: string): { bytes: number; mtimeMs: number } {
  let bytes = 0;
  let mtimeMs = 0;
  for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, rel);
    const st = fs.statSync(full);
    if (!st.isFile()) continue;
    bytes += st.size;
    mtimeMs = Math.max(mtimeMs, st.mtimeMs);
  }
  return { bytes, mtimeMs };
}

function normalizeForCompare(filePath: string): string {
  const normalized = path.normalize(path.resolve(filePath));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isUnderTestRun(absPath: string): boolean {
  const rel = path.relative(OUTPUT_TEST_RUN_DIR, absPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const rel of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, rel);
    if (fs.statSync(full).isFile()) files.push(full);
  }
  return files;
}

function parentDirIfEmpty(dir: string): void {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

// Every path referenced by control-group.md that resolves under output/test_run/, as
// absolute paths — a folder is a keeper if any of its files appear here. Registry paths now
// resolve under the tracked control-group/ folder (references are copied there on promote),
// so in normal operation this set is EMPTY and every test_run/ folder is a prune candidate —
// which is the point: once promoted, the run copy is redundant. The isUnderTestRun filter
// still guards a stray hand-edited row that points back into test_run/.
function referencedTestRunFiles(): Set<string> {
  const referenced = new Set<string>();
  for (const entry of parseControlGroup().values()) {
    for (const rel of [entry.transcribe, entry.analyze, entry.liveTranscribe, entry.liveAnalyze]) {
      if (!rel) continue;
      const abs = path.resolve(CONTROL_GROUP_DIR, rel);
      if (isUnderTestRun(abs)) {
        referenced.add(normalizeForCompare(abs));
      }
    }
  }
  return referenced;
}

function findOrphans(pruneFilesInMixedFolders: boolean): { folders: Candidate[]; files: FileCandidate[]; stats: ScanStats } {
  const referenced = referencedTestRunFiles();
  const names = fs.existsSync(OUTPUT_TEST_RUN_DIR) ? fs.readdirSync(OUTPUT_TEST_RUN_DIR) : [];
  const orphanFolders: Candidate[] = [];
  const mixedFolderFiles: FileCandidate[] = [];
  const stats: ScanStats = { totalFolders: 0, keptFolders: 0, mixedFolders: 0 };

  for (const name of names) {
    const dir = path.join(OUTPUT_TEST_RUN_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    stats.totalFolders += 1;

    // Run files land flat in the timestamped dir (base_transcribe.json, base_analyze.json,
    // etc. — no transcribe/analyze subfolders since the naming refactor), so scan recursively.
    const files: string[] = listFilesRecursive(dir);
    const referencedFiles = files.filter((f) => referenced.has(normalizeForCompare(f)));
    const unreferencedFiles = files.filter((f) => !referenced.has(normalizeForCompare(f)));

    if (referencedFiles.length > 0) {
      stats.keptFolders += 1;
      if (pruneFilesInMixedFolders && unreferencedFiles.length > 0) {
        stats.mixedFolders += 1;
        for (const filePath of unreferencedFiles) {
          const st = fs.statSync(filePath);
          if (Date.now() - st.mtimeMs < MIN_AGE_MS) continue; // possibly still being written
          mixedFolderFiles.push({
            path: filePath,
            folderName: name,
            bytes: st.size,
            mtimeMs: st.mtimeMs,
          });
        }
      }
      continue;
    }

    const { bytes, mtimeMs } = dirSizeAndNewestMtime(dir);
    if (Date.now() - mtimeMs < MIN_AGE_MS) continue; // possibly still being written

    orphanFolders.push({ dir, name, bytes, mtimeMs });
  }

  return {
    folders: orphanFolders.sort((a, b) => a.name.localeCompare(b.name)),
    files: mixedFolderFiles.sort((a, b) => a.path.localeCompare(b.path)),
    stats,
  };
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function main(): Promise<void> {
  const shouldDelete = process.argv.includes('--delete');
  const pruneFilesInMixedFolders = process.argv.includes('--prune-files');
  const { folders: orphans, files: fileCandidates, stats } = findOrphans(pruneFilesInMixedFolders);

  if (orphans.length === 0 && fileCandidates.length === 0) {
    console.log('control-group.md dışında kalan test_run klasörü yok.');
    console.log(`Taranan: ${stats.totalFolders} klasör, referans içerdiği için korunan: ${stats.keptFolders}`);
    if (pruneFilesInMixedFolders) {
      console.log('Kısmi klasörlerde silinecek referans dışı dosya yok.');
    }
    return;
  }

  const totalFolderBytes = orphans.reduce((sum, c) => sum + c.bytes, 0);
  const totalFileBytes = fileCandidates.reduce((sum, c) => sum + c.bytes, 0);
  console.log(`Taranan: ${stats.totalFolders} klasör, referans içerdiği için korunan: ${stats.keptFolders}`);

  if (orphans.length > 0) {
    console.log(`control-group.md tarafından referans verilmeyen ${orphans.length} klasör:\n`);
    for (const c of orphans) {
      console.log(`  ${c.name}  (${formatBytes(c.bytes)})`);
    }
    console.log(`\nKlasör toplamı: ${formatBytes(totalFolderBytes)}`);
  }

  if (pruneFilesInMixedFolders) {
    console.log(`\nKısmi korunan klasör sayısı: ${stats.mixedFolders}`);
    console.log(`Silinebilir referans dışı dosya sayısı: ${fileCandidates.length}`);
    for (const c of fileCandidates) {
      const rel = path.relative(OUTPUT_TEST_RUN_DIR, c.path);
      console.log(`  ${rel}  (${formatBytes(c.bytes)})`);
    }
    console.log(`\nDosya toplamı: ${formatBytes(totalFileBytes)}`);
  }

  console.log(`\nGenel toplam: ${formatBytes(totalFolderBytes + totalFileBytes)}`);

  if (!shouldDelete) {
    console.log('\nSilmek için: npm run prune-test-run -w engine -- --delete');
    if (!pruneFilesInMixedFolders) {
      console.log('Kısmi korunan klasörlerde referans dışı dosyaları da temizlemek için: npm run prune-test-run -w engine -- --prune-files');
    } else {
      console.log('Hem klasörleri hem kısmi klasörlerdeki referans dışı dosyaları silmek için: npm run prune-test-run -w engine -- --prune-files --delete');
    }
    return;
  }

  const answer = await ask(`\n${orphans.length} klasör ve ${fileCandidates.length} dosya silinsin mi? (y/N): `);
  closeAsk();
  if (answer.trim().toLowerCase() !== 'y') {
    console.log('İptal edildi, hiçbir şey silinmedi.');
    return;
  }

  for (const c of orphans) {
    fs.rmSync(c.dir, { recursive: true, force: true });
    console.log(`Silindi: ${c.name}`);
  }

  for (const c of fileCandidates) {
    fs.rmSync(c.path, { force: true });
    parentDirIfEmpty(path.dirname(c.path));
    parentDirIfEmpty(path.dirname(path.dirname(c.path)));
    console.log(`Dosya silindi: ${path.relative(OUTPUT_TEST_RUN_DIR, c.path)}`);
  }
}

main();
