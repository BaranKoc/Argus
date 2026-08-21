// Shared resumable downloader for the developer provisioning tools in this folder.
// It lives apart from any one tool because the office connection is the constraint
// they all share: whether the payload is a 2.4 GB ONNX weight or a Python runtime
// tarball, a dropped socket must resume rather than restart.

import fs from 'node:fs';
import path from 'node:path';

export const MB = 1024 * 1024;

// Render a simple inline progress bar, e.g. "encoder.onnx: [####------] 12.3 / 37.8 MB".
export function renderProgress(label: string, received: number, total: number): void {
  const receivedMb = (received / MB).toFixed(1);
  if (total > 0) {
    const ratio = received / total;
    const filled = Math.round(ratio * 20);
    const bar = '#'.repeat(filled) + '-'.repeat(20 - filled);
    const totalMb = (total / MB).toFixed(1);
    process.stdout.write(`\r  ${label}: [${bar}] ${receivedMb} / ${totalMb} MB (${Math.round(ratio * 100)}%)`);
  } else {
    // No Content-Length: show bytes received so it's clearly still moving.
    process.stdout.write(`\r  ${label}: ${receivedMb} MB indirildi…`);
  }
}

// Retryable = the connection died, not the server refusing us. HTTP 4xx (e.g. 404
// wrong file name) is fatal and must NOT be retried; dropped sockets / timeouts /
// 5xx are exactly what the slow office line does, so those we resume.
export function isRetryable(message: string): boolean {
  return /terminated|UND_ERR|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|HTTP 5\d\d|HTTP 429/i.test(message);
}

// Stream a URL to disk with HTTP-Range resume + retry/backoff. On a mid-transfer
// drop we KEEP the `.part` file and, on the next attempt, ask the server for the
// remaining bytes (Range: bytes=<have>-) so a 2.4 GB file never restarts from 0 on
// the unstable office line. Writes to `.part` then renames on success, so a partial
// file can't masquerade as complete.
export async function downloadWithResume(
  url: string,
  dest: string,
  label: string,
  maxRetries = 8,
): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;

  for (let attempt = 1; ; attempt++) {
    let startByte = 0;
    try {
      startByte = fs.statSync(tmp).size;
    } catch {
      startByte = 0;
    }

    try {
      const headers: Record<string, string> = {};
      if (startByte > 0) headers.Range = `bytes=${startByte}-`;
      const res = await fetch(url, { redirect: 'follow', headers });

      // 416 = we already hold every byte (stale/complete .part): finalize it.
      if (res.status === 416 && startByte > 0) {
        fs.renameSync(tmp, dest);
        process.stdout.write(`\r  ${label}: ${(startByte / MB).toFixed(1)} MB (tamam)\n`);
        return;
      }
      // Server ignored Range (200 with a non-zero start): it will resend from 0, so
      // discard the partial and write fresh.
      const resuming = res.status === 206;
      if (startByte > 0 && !resuming) {
        fs.rmSync(tmp, { force: true });
        startByte = 0;
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      // For 206 content-length is the REMAINING bytes; add what we already have.
      const remaining = Number(res.headers.get('content-length')) || 0;
      const total = remaining > 0 ? startByte + remaining : 0;
      const out = fs.createWriteStream(tmp, { flags: resuming ? 'a' : 'w' });

      let received = startByte;
      let lastTick = 0;
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          out.write(chunk);
          received += chunk.length;
          const now = Date.now();
          if (now - lastTick > 150) {
            renderProgress(label, received, total);
            lastTick = now;
          }
        }
        renderProgress(label, received, total);
        process.stdout.write('\n');
      } finally {
        // Flush + close before rename; keep .part on a stream error so we can resume.
        await new Promise<void>((resolve, reject) => {
          out.end((err?: Error | null) => (err ? reject(err) : resolve()));
        });
      }

      fs.renameSync(tmp, dest);
      return;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const haveMb = (() => {
        try {
          return (fs.statSync(tmp).size / MB).toFixed(1);
        } catch {
          return '0.0';
        }
      })();
      // Fatal error or out of retries: keep .part (so a later run can resume) and surface it.
      if (attempt >= maxRetries || !isRetryable(message)) {
        throw new Error(`${message} — ${haveMb} MB indirilmiş, "${path.basename(tmp)}" korundu`);
      }
      const backoffMs = Math.min(30000, 1000 * 2 ** (attempt - 1));
      process.stdout.write(
        `\n  ⚠ ${label}: ${message} — deneme ${attempt}/${maxRetries}, ${Math.round(backoffMs / 1000)}s sonra ${haveMb} MB'dan devam…\n`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}
