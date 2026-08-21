export interface PrintOutcome {
  printed: boolean;
  reason?: 'cancelled' | 'unavailable';
}

export function isPrintCancellation(failureReason?: string): boolean {
  return failureReason !== undefined && /\bcancell?ed\b/i.test(failureReason);
}

export function isPrinterUnavailable(failureReason?: string): boolean {
  return (
    failureReason !== undefined &&
    /failed to enumerate printers|no printers?(?: are)? (?:available|installed|configured)/i.test(
      failureReason,
    )
  );
}
