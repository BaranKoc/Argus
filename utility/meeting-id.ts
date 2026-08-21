// Kept outside src/main so storage utilities can validate ids without depending on Electron.

export function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const ID_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function idToDate(id: string): Date | null {
  const m = ID_SHAPE.exec(id);
  if (!m) return null;
  const iso = id.replace(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    '$1T$2:$3:$4.$5Z',
  );
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}
