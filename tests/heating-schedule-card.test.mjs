import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeConfig, circuitName, parseSchedule, toPayload, effective, slotAt, groupByProgram, daysLabel, tempColor, fmtTemp, fmtTime,
  loadSchedules, saveSchedule, removeSchedule,
} from '../dist/heating-schedule-card.js';

process.env.TZ = 'Europe/Prague'; // the DST test needs a zone with a spring-forward day
// Real items copied from the dev HA ({type: 'scheduler'}).
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/schedules.json', import.meta.url)));
const V = 'climate.kitchen_valve';
const at = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi); // 2026-11-02 is a Monday

/** A scheduler item: slots = [[start, stop, temp], ...]. */
const item = (slots, extra = {}) => ({
  schedule_id: 'x1', entity_id: 'switch.schedule_x1', weekdays: ['daily'], repeat_type: 'repeat', tags: [], name: null,
  timeslots: slots.map(([start, stop, t]) => ({
    start, stop, conditions: [], actions: [{ service: 'climate.set_temperature', entity_id: V, service_data: { temperature: t } }],
  })),
  ...extra,
});
const THREE = [['00:00:00', '06:00:00', 18], ['06:00:00', '20:00:00', 21], ['20:00:00', '00:00:00', 19]];
const sched = (slots, extra) => parseSchedule(item(slots, extra));

test('normalizeConfig: required parts and errors', () => {
  const ok = { circuits: [{ id: 'c1', name: 'Přízemí', valves: [V, 'climate.b'] }, { id: 'c2', valves: ['climate.c'] }] };
  const n = normalizeConfig({ ...ok, valve: 'climate.c' });
  assert.deepEqual(n.valveCircuit, { [V]: 'c1', 'climate.b': 'c1', 'climate.c': 'c2' });
  assert.equal(n.valve, 'climate.c');
  assert.equal(n.timeStep, 15);
  assert.equal(normalizeConfig({ ...ok, time_step: 30 }).timeStep, 30);
  assert.equal(normalizeConfig(ok).valve, null);
  const bad = /^Error: heating-schedule-card: /;
  for (const c of [undefined, {}, { circuits: [] }, { circuits: [{ valves: [V] }] }, { circuits: [{ id: 'c', valves: [] }] },
    { circuits: [{ id: 'c', valves: ['sensor.x'] }] }, { ...ok, valve: 'climate.nope' }, { ...ok, time_step: 7 }]) {
    assert.throws(() => normalizeConfig(c), bad);
  }
});

test('circuitName: config, then heating_state title, then id', () => {
  const hass = { states: { 'binary_sensor.heating_state_c1': { attributes: { title: 'Dole' } } } };
  assert.equal(circuitName(hass, { id: 'c1', name: 'Přízemí' }), 'Přízemí');
  assert.equal(circuitName(hass, { id: 'c1', name: null }), 'Dole');
  assert.equal(circuitName(hass, { id: 'c2', name: null }), 'c2');
});

test('parseSchedule: real dev items are editable', () => {
  const all = FIXTURE.map(parseSchedule);
  assert.equal(all.length, 4);
  assert.ok(all.every((s) => s.editable), 'all editable');
  const [auto, vac] = all;
  assert.deepEqual({ ...auto, raw: null }, {
    id: '848813', switch: 'switch.schedule_bench_kitchen_valve_auto', valve: V, valves: [V], program: 'auto',
    days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], slots: [{ start: 0, end: 1440, temp: 21 }], paused: false, editable: true, raw: null,
  });
  assert.equal(vac.program, 'vacation');
});

test('parseSchedule: legacy without program tag is auto; paused tag; weekday aliases', () => {
  const s = sched(THREE, { tags: ['kitchen_valve', 'paused'], weekdays: ['workday'] });
  assert.equal(s.program, 'auto');
  assert.equal(s.paused, true);
  assert.deepEqual(s.days, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(s.slots, [{ start: 0, end: 360, temp: 18 }, { start: 360, end: 1200, temp: 21 }, { start: 1200, end: 1440, temp: 19 }]);
  assert.deepEqual(sched(THREE, { weekdays: ['sun', 'mon', 'sun'] }).days, ['mon', 'sun']);
});

test('parseSchedule: not editable', () => {
  const bad = (s) => assert.equal(s.editable, false);
  bad(sched(THREE, { repeat_type: 'single' }));
  bad(sched([['00:00:00', 'sunset+00:30', 18], ['sunset+00:30', '00:00:00', 21]])); // sun-relative
  bad(sched(THREE, { weekdays: ['workday'] })); // never rewritten as explicit days
  bad(sched(THREE, { weekdays: ['weekend'] }));
  bad(sched([['00:00:00', '12:00:00', 18], ['06:00:00', '00:00:00', 21]])); // overlap
  bad(sched([['06:00:00', '12:00:00', 18], ['06:00:00', '00:00:00', 21]])); // duplicate start
  const noTemp = item(THREE);
  noTemp.timeslots[1].actions[0].service_data = { target_temp_low: 19 };
  bad(parseSchedule(noTemp));
  const none = item(THREE);
  none.timeslots[1].actions = [];
  bad(parseSchedule(none));
  const cond = item(THREE);
  cond.timeslots[1].conditions = [{ entity_id: 'sensor.x', value: 1, match_type: 'is' }];
  bad(parseSchedule(cond));
  const other = item(THREE);
  other.timeslots[1].actions[0].service = 'switch.turn_on';
  bad(parseSchedule(other));
  const two = item(THREE);
  two.timeslots[1].actions[0].entity_id = 'climate.other';
  bad(parseSchedule(two)); // more than one valve
  bad(sched(THREE, { weekdays: [] }));
});

test('parseSchedule: `data` instead of `service_data`, stop 23:59 ends the day', () => {
  const i = item([['00:00', '23:59', 20]]);
  i.timeslots[0].actions[0] = { service: 'climate.set_temperature', entity_id: V, data: { temperature: 20 } };
  const s = parseSchedule(i);
  assert.equal(s.editable, true);
  assert.deepEqual(s.slots, [{ start: 0, end: 1440, temp: 20 }]);
});

test('toPayload: add shape matches scheduler-component ADD_SCHEDULE_SCHEMA', () => {
  const m = { valve: V, program: 'vacation', days: ['sat', 'mon'], paused: false, slots: [{ start: 0, end: 480, temp: 17 }, { start: 480, end: 1440, temp: 21.5 }] };
  assert.deepEqual(toPayload(m), {
    weekdays: ['mon', 'sat'],
    timeslots: [
      { start: '00:00:00', stop: '08:00:00', actions: [{ service: 'climate.set_temperature', entity_id: V, service_data: { temperature: 17 } }] },
      { start: '08:00:00', stop: '23:59:00', actions: [{ service: 'climate.set_temperature', entity_id: V, service_data: { temperature: 21.5 } }] },
    ],
    repeat_type: 'repeat', tags: ['program:vacation'], name: null,
  });
  const all = toPayload({ ...m, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], paused: true });
  assert.deepEqual(all.weekdays, ['daily']);
  assert.deepEqual(all.tags, ['program:vacation', 'paused']);
});

test('toPayload: round trip and tags', () => {
  const strip = ({ raw, ...m }) => m;
  for (const base of [sched(THREE, { tags: ['kitchen_valve', 'program:vacation'], weekdays: ['mon', 'wed'] }), parseSchedule(FIXTURE[0])]) {
    const p = toPayload(base, base);
    assert.equal(p.schedule_id, base.id);
    const back = parseSchedule({ ...p, entity_id: base.switch });
    assert.deepEqual(strip(back), strip(base));
  }
  // foreign tags kept; program:* and paused replaced
  const ex = sched(THREE, { tags: ['kitchen_valve', 'program:vacation', 'paused', 'mine'] });
  const p = toPayload({ ...ex, program: 'auto', paused: false }, ex);
  assert.deepEqual(p.tags, ['kitchen_valve', 'mine', 'program:auto']);
  assert.equal(toPayload({ valve: V, program: 'auto', days: ['mon'], slots: ex.slots }).schedule_id, undefined);
});

test('effective: program day, fallback, paused', () => {
  const auto = sched([['00:00:00', '00:00:00', 21]], { schedule_id: 'a', tags: ['program:auto'] });
  const vacMon = sched([['00:00:00', '00:00:00', 16]], { schedule_id: 'v', tags: ['program:vacation'], weekdays: ['mon'] });
  const all = [auto, vacMon];
  assert.deepEqual(effective(all, V, 'vacation', 'mon'), { schedules: [vacMon], isFallback: false });
  assert.deepEqual(effective(all, V, 'vacation', 'tue'), { schedules: [auto], isFallback: true });
  assert.deepEqual(effective(all, V, 'auto', 'mon'), { schedules: [auto], isFallback: false });
  assert.deepEqual(effective(all, V, 'odd_week', 'mon'), { schedules: [auto], isFallback: true });
  const paused = { ...vacMon, paused: true };
  assert.deepEqual(effective([auto, paused], V, 'vacation', 'mon'), { schedules: [auto], isFallback: true });
  assert.deepEqual(effective(all, 'climate.other', 'auto', 'mon'), { schedules: [], isFallback: false });
});

test('slotAt: slot, next, carry-over, fallback, paused', () => {
  const s = sched(THREE);
  const r = slotAt([s], V, 'auto', at(2026, 11, 2, 7, 0));
  assert.deepEqual(r, { temp: 21, start: 360, end: 1200, fromYesterday: false, next: { start: 1200, temp: 19, tomorrow: false } });
  // last slot: next is tomorrow's first
  assert.deepEqual(slotAt([s], V, 'auto', at(2026, 11, 2, 22, 0)).next, { start: 0, temp: 18, tomorrow: true });
  // exactly at a start counts as that slot
  assert.equal(slotAt([s], V, 'auto', at(2026, 11, 2, 6, 0)).temp, 21);
  // carry-over: Monday 00:00 Sunday's only schedule has a 00:00 slot -> own slot; use a gap-free-less schedule instead
  const evening = parseSchedule({ ...item([['00:00:00', '20:00:00', 18], ['20:00:00', '00:00:00', 17]]), weekdays: ['sun'] });
  const monday = parseSchedule({ ...item([['06:00:00', '00:00:00', 21]]), weekdays: ['mon'] });
  const c = slotAt([evening, monday], V, 'auto', at(2026, 11, 2, 5, 0)); // Mon 05:00, before Monday's first slot
  assert.equal(c.temp, 17);
  assert.equal(c.fromYesterday, true);
  assert.deepEqual(c.next, { start: 360, temp: 21, tomorrow: false });
  // fallback to auto on a day the program has nothing
  const auto = sched([['00:00:00', '00:00:00', 21]], { tags: ['program:auto'] });
  const vacMon = sched([['00:00:00', '00:00:00', 16]], { tags: ['program:vacation'], weekdays: ['mon'] });
  assert.equal(slotAt([auto, vacMon], V, 'vacation', at(2026, 11, 2, 7)).temp, 16);
  assert.equal(slotAt([auto, vacMon], V, 'vacation', at(2026, 11, 3, 7)).temp, 21);
  // paused counts for nothing, no schedule -> null
  assert.equal(slotAt([{ ...s, paused: true }], V, 'auto', at(2026, 11, 2, 7)), null);
  assert.equal(slotAt([], V, 'auto', at(2026, 11, 2, 7)), null);
});

test('groupByProgram: auto first, only the valve', () => {
  const a = sched(THREE, { tags: ['program:vacation'] });
  const b = sched(THREE, { tags: ['program:auto'] });
  const other = parseSchedule({ ...item(THREE), timeslots: item(THREE).timeslots.map((t) => ({ ...t, actions: [{ ...t.actions[0], entity_id: 'climate.o' }] })) });
  assert.deepEqual([...groupByProgram([a, other, b], V)].map(([p, l]) => [p, l.length]), [['auto', 1], ['vacation', 1]]);
  assert.deepEqual([...groupByProgram([], V)], [['auto', []]]);
});

test('daysLabel', () => {
  assert.equal(daysLabel(['mon', 'tue', 'wed', 'thu', 'fri']), 'Po–Pá');
  assert.equal(daysLabel(['sun', 'sat']), 'So–Ne');
  assert.equal(daysLabel(['fri', 'mon', 'wed']), 'Po, St, Pá');
  assert.equal(daysLabel(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), 'Po–Ne');
  assert.equal(daysLabel(['mon', 'tue', 'sun']), 'Po–Út, Ne');
  assert.equal(daysLabel([]), '');
});

test('tempColor, fmtTemp, fmtTime', () => {
  assert.equal(tempColor(15), '#3D7FD9');
  assert.equal(tempColor(25), '#DA4A2C');
  assert.equal(tempColor(10), '#3D7FD9'); // clamped
  assert.equal(tempColor(30), '#DA4A2C');
  assert.equal(tempColor(20), '#F0C27A'); // the middle stop
  assert.equal(tempColor(15, true), '#5AA0FF');
  assert.equal(tempColor(25, true), '#FF6A45');
  assert.equal(fmtTemp(21.5), '21,5');
  assert.equal(fmtTemp(21), '21');
  assert.equal(fmtTime(485), '08:05');
  assert.equal(fmtTime(1440), '24:00');
});

test('data access: WS list, add / edit / remove endpoints', async () => {
  const calls = [];
  const hass = { callWS: async (m) => { calls.push(['ws', m]); return FIXTURE; }, callApi: async (...a) => calls.push(['api', ...a]) };
  assert.equal((await loadSchedules(hass)).length, 4);
  const m = parseSchedule(FIXTURE[0]);
  await saveSchedule(hass, { ...m, id: undefined }); // add
  await saveSchedule(hass, m, m); // edit
  await removeSchedule(hass, 'abc');
  assert.deepEqual(calls[0], ['ws', { type: 'scheduler' }]);
  assert.deepEqual(calls.slice(1).map((c) => [c[1], c[2]]), [['POST', 'scheduler/add'], ['POST', 'scheduler/edit'], ['POST', 'scheduler/remove']]);
  assert.equal(calls[2][3].schedule_id, '848813');
  assert.deepEqual(calls[3][3], { schedule_id: 'abc' });
});

test('parseSchedule: only starts count (old scheduler-card schedules are editable)', () => {
  const one = sched([['06:00:00', '23:00:00', 21]]);
  assert.equal(one.editable, true);
  assert.deepEqual(one.slots, [{ start: 360, end: 1440, temp: 21 }]);
  const un = sched([['18:00:00', '22:00:00', 20], ['06:00:00', '08:00:00', 21]]);
  assert.equal(un.editable, true);
  assert.deepEqual(un.slots, [{ start: 360, end: 1080, temp: 21 }, { start: 1080, end: 1440, temp: 20 }]);
});

test('null temperature: slot keeps null, read-only, nothing throws', () => {
  const i = item(THREE);
  i.timeslots[1].actions[0].service_data = { target_temp_low: 19, target_temp_high: 23 };
  const s = parseSchedule(i);
  assert.equal(s.slots[1].temp, null);
  assert.equal(s.editable, false);
  assert.equal(tempColor(null), '#9AA0A6');
  assert.equal(fmtTemp(null), '–');
  assert.equal(slotAt([s], V, 'auto', at(2026, 11, 2, 7)).temp, null);
});

test('slotAt: calendar days across the spring-forward date', () => {
  // 2026-03-29 is 23 h long in Europe/Prague; Monday 03-30 00:30 must still see Sunday's evening slot
  const sun = parseSchedule({ ...item([['00:00:00', '20:00:00', 18], ['20:00:00', '00:00:00', 17]]), weekdays: ['sun'] });
  const mon = parseSchedule({ ...item([['06:00:00', '00:00:00', 21]]), weekdays: ['mon'] });
  const r = slotAt([sun, mon], V, 'auto', at(2026, 3, 30, 0, 30));
  assert.equal(r.temp, 17);
  assert.equal(r.fromYesterday, true);
  assert.deepEqual(slotAt([sun, mon], V, 'auto', at(2026, 3, 29, 22, 0)).next, { start: 360, temp: 21, tomorrow: true });
});

test('multi-valve schedule: read-only, counts for each of its valves', () => {
  const i = item([['00:00:00', '00:00:00', 20]]);
  i.timeslots[0].actions[0].entity_id = [V, 'climate.b'];
  const s = parseSchedule(i);
  assert.deepEqual(s.valves, [V, 'climate.b']);
  assert.equal(s.valve, null);
  assert.equal(s.editable, false);
  for (const v of [V, 'climate.b']) {
    assert.equal(effective([s], v, 'auto', 'mon').schedules.length, 1);
    assert.equal(slotAt([s], v, 'auto', at(2026, 11, 2, 7)).temp, 20);
    assert.equal(groupByProgram([s], v).get('auto').length, 1);
  }
  assert.equal(effective([s], 'climate.c', 'auto', 'mon').schedules.length, 0);
});

test('toPayload: keeps name and start / end date, only owned fields change', () => {
  const ex = sched(THREE, { name: 'Moje', start_date: '2026-11-01', end_date: '2027-03-01', tags: ['program:auto'] });
  const p = toPayload({ ...ex, days: ['mon'] }, ex);
  assert.equal(p.name, 'Moje');
  assert.equal(p.start_date, '2026-11-01');
  assert.equal(p.end_date, '2027-03-01');
  assert.deepEqual(p.weekdays, ['mon']);
  assert.deepEqual(Object.keys(p).sort(), ['end_date', 'name', 'repeat_type', 'schedule_id', 'start_date', 'tags', 'timeslots', 'weekdays']);
});

test('toPayload: last stop 23:59, others = next start', () => {
  const m = { valve: V, program: 'auto', days: ['mon'], slots: [{ start: 360, end: 1080, temp: 21 }, { start: 1080, end: 1440, temp: 20 }] };
  assert.deepEqual(toPayload(m).timeslots.map((t) => [t.start, t.stop]), [['06:00:00', '18:00:00'], ['18:00:00', '23:59:00']]);
});
