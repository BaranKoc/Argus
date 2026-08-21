import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrintCancellation, isPrinterUnavailable } from './print-result.ts';

test('recognizes Electron print cancellation reasons', () => {
  assert.equal(isPrintCancellation('Print job canceled'), true);
  assert.equal(isPrintCancellation('cancelled'), true);
  assert.equal(isPrintCancellation('CANCELED'), true);
});

test('does not hide genuine print failures', () => {
  assert.equal(isPrintCancellation('Printer is unavailable'), false);
  assert.equal(isPrintCancellation('Failed to start print job'), false);
  assert.equal(isPrintCancellation(), false);
});

test('recognizes the absence of an enumerated printer', () => {
  assert.equal(isPrinterUnavailable('Failed to enumerate printers'), true);
  assert.equal(isPrinterUnavailable('No printers are available'), true);
  assert.equal(isPrinterUnavailable('No printer installed'), true);
});

test('does not hide failures from a configured printer', () => {
  assert.equal(isPrinterUnavailable('Printer is unavailable'), false);
  assert.equal(isPrinterUnavailable('Failed to start print job'), false);
  assert.equal(isPrinterUnavailable(), false);
});
