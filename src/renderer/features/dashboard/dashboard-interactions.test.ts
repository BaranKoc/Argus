import assert from 'node:assert/strict';
import test from 'node:test';
import {
  meetingButtonAction,
  meetingRowIntent,
  orderMeetings,
  RenameInteractionState,
  SingleFlightInteractionState,
  type MeetingRowTarget,
  type RenamePhase,
} from './dashboard-interactions.ts';

test('row and name clicks have distinct intents while idle', () => {
  assert.equal(meetingRowIntent('row', 'idle'), 'open');
  assert.equal(meetingRowIntent('name', 'idle'), 'rename');
});

test('buttons and the rename input never trigger a row open', () => {
  for (const target of ['button', 'input'] satisfies MeetingRowTarget[]) {
    for (const phase of ['idle', 'editing', 'saving'] satisfies RenamePhase[]) {
      assert.equal(meetingRowIntent(target, phase), 'ignore');
    }
  }
});

test('repeated clicks cannot start another action during rename or save', () => {
  for (const target of ['row', 'name', 'input', 'button'] satisfies MeetingRowTarget[]) {
    assert.equal(meetingRowIntent(target, 'editing'), 'ignore');
    assert.equal(meetingRowIntent(target, 'saving'), 'ignore');
  }
});

test('rename can be opened and abandoned repeatedly without getting stuck', () => {
  const state = new RenameInteractionState();
  for (let attempt = 0; attempt < 25; attempt += 1) {
    assert.equal(state.begin(), true);
    assert.equal(state.begin(), false);
    assert.equal(state.phase, 'editing');
    state.reset();
    assert.equal(state.phase, 'idle');
  }
});

test('rename remains single-flight until an async save finishes', () => {
  const state = new RenameInteractionState();
  assert.equal(state.begin(), true);
  assert.equal(state.beginSave(), true);
  assert.equal(state.begin(), false);
  assert.equal(state.beginSave(), false);
  assert.equal(state.phase, 'saving');
  state.reset();
  assert.equal(state.begin(), true);
});

test('the click immediately following an editor blur cannot open the row', () => {
  assert.equal(meetingRowIntent('row', 'idle', true), 'ignore');
  assert.equal(meetingRowIntent('name', 'idle', true), 'ignore');
});

test('only known action buttons are dispatched', () => {
  assert.equal(meetingButtonAction('open'), 'open');
  assert.equal(meetingButtonAction('export'), 'export');
  assert.equal(meetingButtonAction('delete'), 'delete');
  assert.equal(meetingButtonAction('rename'), null);
  assert.equal(meetingButtonAction(undefined), null);
});

test('an action button ignores repeated clicks until its work finishes', () => {
  const state = new SingleFlightInteractionState();
  assert.equal(state.begin(), true);
  for (let click = 0; click < 10; click += 1) assert.equal(state.begin(), false);
  state.finish();
  assert.equal(state.begin(), true);
});

test('orderMeetings honors the saved drag order', () => {
  const meetings = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];
  assert.deepEqual(
    orderMeetings(meetings, ['a', 'b', 'c']).map((m) => m.id),
    ['a', 'b', 'c'],
  );
});

test('orderMeetings surfaces new (unsaved) meetings first, newest-first', () => {
  // main returns newest-first: e, d are new; a, b, c are already in the saved order.
  const meetings = [{ id: 'e' }, { id: 'd' }, { id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(
    orderMeetings(meetings, ['b', 'a', 'c']).map((m) => m.id),
    ['e', 'd', 'b', 'a', 'c'],
  );
});

test('orderMeetings drops saved ids whose meeting was deleted', () => {
  const meetings = [{ id: 'a' }, { id: 'c' }];
  assert.deepEqual(
    orderMeetings(meetings, ['a', 'b', 'c']).map((m) => m.id),
    ['a', 'c'],
  );
});

test('orderMeetings with no saved order keeps the incoming order', () => {
  const meetings = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(
    orderMeetings(meetings, []).map((m) => m.id),
    ['a', 'b'],
  );
});
