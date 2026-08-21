// IPC calls that continue a recording are accepted only after a successful start. This
// is a lifecycle boundary, not a user-role boundary: Argus is a local single-user app.
export class RecordingGuard {
  #active = false;

  start(startRecording: () => void): void {
    if (this.#active) throw new Error('Zaten aktif bir kayıt var.');
    startRecording();
    this.#active = true;
  }

  requireActive(): void {
    if (!this.#active) throw new Error('Aktif kayıt yok.');
  }

  finish(): void {
    this.#active = false;
  }

  hasActiveRecording(): boolean {
    return this.#active;
  }
}
