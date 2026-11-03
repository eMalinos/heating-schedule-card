import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeConfig, circuitName, parseSchedule, toPayload, effective, slotAt, groupByProgram, daysLabel, tempColor, fmtTemp, fmtTime,
  loadSchedules, saveSchedule, removeSchedule, nowState, DASH, isFallbackProgram, barSegments, slotsSummary,
  normalizeSlots, splitSlot, removeSlot, moveBoundary, setTemp, daysConflict, planCopy,
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
  assert.deepEqual({ ...r, schedule: undefined }, { temp: 21, start: 360, end: 1200, fromYesterday: false, schedule: undefined, isFallback: false, next: { start: 1200, temp: 19, tomorrow: false } });
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

// ---------- week view ----------

const C = 'c1';
const AUTO = sched(THREE); // 18 until 06:00, 21 until 20:00, 19 after; every day
const states = (o = {}) => ({
  [`sensor.heating_applying_${C}`]: { state: 'idle', attributes: { left: 0 } },
  [`input_select.heating_mode_${C}`]: { state: 'on' },
  [`binary_sensor.heating_active_${C}`]: { state: 'on' },
  [`sensor.heating_off_schedule_${C}`]: { state: '0', attributes: { window_open_climates: [] } },
  [`sensor.heating_valves_${C}`]: { state: '0', attributes: { phases: { [V]: ['normal', 'x', 21, false] }, forced: [], closed: [] } },
  [`sensor.heating_schedule_${C}`]: { state: 'auto', attributes: { targets: { [V]: 21 } } },
  [`sensor.heating_program_${C}`]: { state: 'auto', attributes: { program_names: { auto: 'Výchozí' } } },
  [V]: { state: 'heat', attributes: { temperature: 21 } },
  ...o,
});
const now = (st, d = at(2026, 11, 2, 14, 20), extra = {}) => nowState({ states: st, circuit: C, valve: V, schedules: [AUTO], program: 'auto', now: d, nValves: 5, ...extra });

test('nowState: normal', () => {
  const n = now(states());
  assert.equal(n.kind, 'normal');
  assert.equal(n.text, 'Teď 21 °C, od 20:00 19 °C');
  assert.equal(n.sub, 'Běží program Výchozí · Po–Ne');
  assert.deepEqual([n.temp, n.unit, n.tone, n.muted], ['21', '°C', 21, false]);
  assert.equal(now(states(), at(2026, 11, 2, 21)).text, 'Teď 19 °C, od zítra 00:00 18 °C');
});

test('nowState: order applying > off > not heating > window > held > manual > normal', () => {
  const all = states({
    [`sensor.heating_applying_${C}`]: { state: 'applying', attributes: { left: 3 } },
    [`input_select.heating_mode_${C}`]: { state: 'off' },
    [`binary_sensor.heating_active_${C}`]: { state: 'off' },
    [`sensor.heating_off_schedule_${C}`]: { state: '1', attributes: { window_open_climates: [V] } },
    [`sensor.heating_valves_${C}`]: { state: '1', attributes: { phases: { [V]: ['fast'] } } },
    [V]: { state: 'heat', attributes: { temperature: 23 } },
  });
  const a = now(all);
  assert.deepEqual([a.kind, a.text, a.sub], ['applying', 'Nastavuji hlavice podle rozvrhu', '2 z 5 hotovo · po uložení nebo změně programu']);
  const step = (st, id, patch) => ({ ...st, [id]: patch });
  const s1 = step(all, `sensor.heating_applying_${C}`, { state: 'idle' });
  assert.equal(now(s1).kind, 'off');
  assert.deepEqual([now(s1).text, now(s1).temp, now(s1).muted], ['Topení je vypnuté', '–', true]);
  assert.match(now(s1).sub, /teď by bylo 21 °C/);
  const s2 = step(s1, `input_select.heating_mode_${C}`, { state: 'by_weather' });
  assert.deepEqual([now(s2).kind, now(s2).text], ['noheat', 'Podle počasí se netopí']);
  const s3 = step(s2, `binary_sensor.heating_active_${C}`, { state: 'on' });
  const w = now(s3);
  assert.deepEqual([w.kind, w.text, w.temp, w.tone], ['window', 'Okno otevřené', '23', 'cold']);
  const s4 = step(s3, `sensor.heating_off_schedule_${C}`, { state: '0', attributes: { window_open_climates: [] } });
  const held = now(s4);
  assert.deepEqual([held.kind, held.text, held.sub, held.temp], ['held', 'Rychlý start', 'Hlavice naplno, pak 21 °C podle rozvrhu', '21']);
  const s5 = step(s4, `sensor.heating_valves_${C}`, { state: '0', attributes: { phases: { [V]: ['normal'] } } });
  const man = now(s5);
  assert.deepEqual([man.kind, man.text, man.btn, man.sub], ['manual', 'Ručně 23 °C', 'Podle rozvrhu', 'Rozvrh to v 20:00 vrátí na 19 °C']);
});

test('nowState: held phases, manual tolerance, fallback and no schedule', () => {
  const ph = (p) => states({ [`sensor.heating_valves_${C}`]: { state: '1', attributes: { phases: { [V]: [p] }, forced: [], closed: [] } } });
  assert.equal(now(ph('run')).text, 'Doběh');
  assert.equal(now(ph('overrun')).text, 'Doběh čerpadla');
  assert.deepEqual([now(ph('closed')).text, now(ph('closed')).sub], ['Zavřeno', 'Hlavice zavřená, pak 21 °C podle rozvrhu']);
  const forced = states({ [`sensor.heating_valves_${C}`]: { state: '1', attributes: { forced: [V], closed: [] } } });
  assert.equal(now(forced).text, 'Rychlý start');
  assert.equal(now(states({ [V]: { state: 'heat', attributes: { temperature: 21.04 } } })).kind, 'normal'); // within 0.05 °C
  assert.equal(now(states({ [V]: { state: 'heat', attributes: { temperature: 21.2 } } })).kind, 'manual');
  assert.equal(now(states(), at(2026, 11, 2, 14), { schedules: [] }).kind, 'none');
  const vac = now(states(), undefined, { program: 'vacation' });
  assert.equal(vac.text, 'Teď 21 °C, od 20:00 19 °C podle Výchozího');
  assert.equal(now(states({ [V]: { state: 'unavailable', attributes: {} } })).kind, 'normal'); // no temperature: never manual
});

test('isFallbackProgram, barSegments, slotsSummary', () => {
  const vac = sched([['00:00:00', '00:00:00', 16]], { tags: ['program:vacation'] });
  assert.equal(isFallbackProgram(groupByProgram([AUTO], V), 'vacation'), true);
  assert.equal(isFallbackProgram(groupByProgram([AUTO, vac], V), 'vacation'), false);
  assert.equal(isFallbackProgram(groupByProgram([AUTO, { ...vac, paused: true }], V), 'vacation'), false); // a paused own schedule is still own
  assert.equal(isFallbackProgram(groupByProgram([], V), 'auto'), false);
  assert.deepEqual(barSegments(AUTO).map((s) => [s.start, s.end]), [[0, 360], [360, 1200], [1200, 1440]]);
  const late = sched([['06:00:00', '20:00:00', 21], ['20:00:00', '00:00:00', 19]]);
  assert.deepEqual(barSegments(late).map((s) => [s.start, s.end, s.temp]), [[0, 360, 19], [360, 1200, 21], [1200, 1440, 19]]);
  assert.equal(slotsSummary(AUTO), '3 úseky · 18–21 °C');
  assert.equal(slotsSummary(vac), 'celý den 16 °C');
});

test('nowState: days label and "podle Výchozího" come from the schedule the slot belongs to', () => {
  // only a Friday schedule of the running program: at 00:30 on Saturday its evening slot still holds
  const fri = sched(THREE, { weekdays: ['fri'], tags: ['program:vacation'] });
  const n = nowState({ states: states(), circuit: C, valve: V, schedules: [fri], program: 'vacation', now: at(2026, 11, 7, 0, 30), nValves: 1 });
  assert.equal(n.text, 'Teď 19 °C');
  assert.equal(slotAt([fri], V, 'vacation', at(2026, 11, 7, 0, 30)).schedule, fri);
  assert.match(n.sub, /^Běží program vacation · Pá$/);
  assert.ok(!n.text.includes('podle Výchozího'));
  // the fallback flag follows the day: vacation has Friday only, Saturday runs on Výchozí
  const sat = nowState({ states: states(), circuit: C, valve: V, schedules: [fri, sched(THREE, { weekdays: ['sat'] })], program: 'vacation', now: at(2026, 11, 7, 12), nValves: 1 });
  assert.match(sat.text, /podle Výchozího$/);
  assert.match(sat.sub, /· So$/);
});

test('fmtTemp(null) is the same dash the tile uses for "no temperature"', () => {
  assert.equal(fmtTemp(null), DASH);
  const t = nowState({ states: states({ [`input_select.heating_mode_${C}`]: { state: 'off' } }), circuit: C, valve: V, schedules: [], program: 'auto', now: at(2026, 11, 2, 12), nValves: 1 });
  assert.deepEqual([t.temp, t.unit], [DASH, '']);
});

// ---------- editor: pure logic ----------
const S3 = [{ start: 0, end: 360, temp: 18 }, { start: 360, end: 1200, temp: 21 }, { start: 1200, end: 1440, temp: 19 }];
const cover = (s) => s[0].start === 0 && s.at(-1).end === 1440 && s.every((x, i) => x.start < x.end && (i === 0 || x.start === s[i - 1].end));
const se = (s) => s.map((x) => [x.start, x.end]);

test('normalizeSlots keeps a late first start; removing / moving the first slot respects it', () => {
  const late = [{ start: 360, end: 1200, temp: 21 }, { start: 1200, end: 1440, temp: 19 }];
  assert.deepEqual(normalizeSlots(late), late);
  assert.notEqual(normalizeSlots(late)[0], late[0]);
  assert.deepEqual(removeSlot(late, 0), [{ start: 360, end: 1440, temp: 19 }]);
  assert.deepEqual(se(moveBoundary(late, 0, -15)), [[345, 1200], [1200, 1440]]);
  assert.deepEqual(se(moveBoundary(late, 0, -5000)), [[0, 1200], [1200, 1440]]);
  assert.deepEqual(se(moveBoundary(late, 0, 5000)), [[1185, 1200], [1200, 1440]]);
  assert.equal(moveBoundary(S3, 0, 15), S3); // starting at 00:00: fixed
  // an untouched 06:00-first schedule writes its starts back
  const ex = sched([['06:00:00', '20:00:00', 21], ['20:00:00', '00:00:00', 19]]);
  const body = toPayload({ id: 'x1', valve: V, program: 'auto', days: ['mon', 'tue'], slots: normalizeSlots(ex.slots), paused: false }, ex);
  assert.deepEqual(body.timeslots.map((t) => [t.start, t.stop]), [['06:00:00', '20:00:00'], ['20:00:00', '23:59:00']]);
});

test('splitSlot: halves at the nearest step, too short stays', () => {
  const r = splitSlot(S3, 1, 15); // 06:00-20:00 -> mid 13:00
  assert.deepEqual(r.slice(1, 3), [{ start: 360, end: 780, temp: 21 }, { start: 780, end: 1200, temp: 21 }]);
  assert.ok(cover(r));
  assert.deepEqual(se(splitSlot([{ start: 0, end: 1440, temp: 20 }], 0, 15)), [[0, 720], [720, 1440]]);
  assert.deepEqual(se(splitSlot([{ start: 0, end: 50, temp: 20 }, { start: 50, end: 1440, temp: 20 }], 0, 15)).slice(0, 2), [[0, 30], [30, 50]]);
  const tiny = [{ start: 0, end: 20, temp: 20 }, { start: 20, end: 1440, temp: 20 }];
  assert.equal(splitSlot(tiny, 0, 15), tiny);
});

test('removeSlot: merges into the previous, the first into the next, the only one stays', () => {
  assert.deepEqual(removeSlot(S3, 1), [{ start: 0, end: 1200, temp: 18 }, S3[2]]);
  assert.deepEqual(removeSlot(S3, 0), [{ start: 0, end: 1200, temp: 21 }, S3[2]]);
  assert.deepEqual(removeSlot(S3, 2), [S3[0], { start: 360, end: 1440, temp: 21 }]);
  const one = [{ start: 0, end: 1440, temp: 20 }];
  assert.equal(removeSlot(one, 0), one);
  for (let i = 0; i < 3; i++) assert.ok(cover(removeSlot(S3, i)));
});

test('moveBoundary: clamped, min length = step, coverage kept', () => {
  assert.deepEqual(se(moveBoundary(S3, 1, 15)).slice(0, 2), [[0, 375], [375, 1200]]);
  assert.deepEqual(se(moveBoundary(S3, 1, -15)).slice(0, 2), [[0, 345], [345, 1200]]);
  assert.deepEqual(se(moveBoundary(S3, 1, 5000, 15)), [[0, 1185], [1185, 1200], [1200, 1440]]);
  assert.deepEqual(se(moveBoundary(S3, 1, -5000, 15)), [[0, 15], [15, 1200], [1200, 1440]]);
  assert.equal(moveBoundary(S3, 0, 15), S3); // 00:00 is fixed
  assert.equal(moveBoundary(S3, 3, 15), S3); // 24:00 is fixed
  const at = [{ start: 0, end: 15, temp: 1 }, { start: 15, end: 1440, temp: 2 }];
  assert.deepEqual(se(moveBoundary(at, 1, -15)), [[0, 15], [15, 1440]]); // already min length
  for (const d of [-60, -15, 15, 60, 900]) assert.ok(cover(moveBoundary(S3, 2, d)));
});

test('setTemp: 5-30 °C in 0.5 steps, immutable', () => {
  assert.equal(setTemp(S3, 1, 21.6)[1].temp, 21.5);
  assert.equal(setTemp(S3, 1, 99)[1].temp, 30);
  assert.equal(setTemp(S3, 1, -3)[1].temp, 5);
  assert.equal(S3[1].temp, 21);
  assert.equal(setTemp(S3, 9, 20), S3);
});

test('daysConflict: weekdays another schedule of the same valve and program uses', () => {
  const list = [sched(THREE, { schedule_id: 'a', weekdays: ['mon', 'tue'] }), sched(THREE, { schedule_id: 'b', weekdays: ['sat'], tags: ['program:odd'] }),
    sched(THREE, { schedule_id: 'c', weekdays: ['wed'], tags: ['paused'] })];
  assert.deepEqual(daysConflict(list, V, 'auto', ['tue', 'wed', 'thu']), ['tue', 'wed']); // paused counts too
  assert.deepEqual(daysConflict(list, V, 'auto', ['mon', 'tue'], 'a'), []); // the edited one is excluded
  assert.deepEqual(daysConflict(list, V, 'odd', ['sat', 'sun']), ['sat']);
  assert.deepEqual(daysConflict(list, 'climate.other', 'auto', ['mon']), []);
});

test('toPayload after editing: starts only, last stop 23:59, name and dates kept', () => {
  const ex = parseSchedule(item(THREE, { schedule_id: 'k', name: 'mine', start_date: '2026-01-01', tags: ['kitchen_valve', 'program:auto'] }));
  const body = toPayload({ id: 'k', valve: V, program: 'auto', days: ['sun', 'mon'], slots: splitSlot(ex.slots, 1), paused: false }, ex);
  assert.deepEqual(body.timeslots.map((t) => [t.start, t.stop]), [['00:00:00', '06:00:00'], ['06:00:00', '13:00:00'], ['13:00:00', '20:00:00'], ['20:00:00', '23:59:00']]);
  assert.deepEqual(body.weekdays, ['mon', 'sun']);
  assert.equal(body.name, 'mine');
  assert.equal(body.start_date, '2026-01-01');
  assert.deepEqual(body.tags, ['kitchen_valve', 'program:auto']);
  assert.equal(body.schedule_id, 'k');
});

// ---------- planCopy ----------

const SRC = 'climate.src', A = 'climate.a', B = 'climate.b';
const WORK = ['mon', 'tue', 'wed', 'thu', 'fri'], ALL = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
let seq = 0;
/** A parsed schedule of `valve`: slots = [[startMin, temp]...] (each ends where the next starts). */
const mk = (valve, program, days, slots = [[0, 20]], extra = {}) => {
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
  const id = `p${++seq}`;
  return parseSchedule({
    schedule_id: id, entity_id: `switch.${id}`, weekdays: days, repeat_type: 'repeat', tags: [`program:${program}`, ...(extra.tags ?? [])], name: null,
    timeslots: slots.map(([start, t], i) => ({ start: hm(start), stop: i === slots.length - 1 ? '23:59:00' : hm(slots[i + 1][0]), conditions: [],
      actions: [{ service: 'climate.set_temperature', entity_id: valve, service_data: { temperature: t } }] })),
    ...(extra.item ?? {}),
  });
};
const names = { auto: 'Výchozí', even: 'Sudý', vac: 'Dovolená' };
const all = { [SRC]: ['auto', 'even', 'vac'], [A]: ['auto', 'even', 'vac'], [B]: ['auto', 'even'] };
const plan = (schedules, o) => planCopy({ schedules, source: SRC, programsByValve: all, names, ...o });
const shape = (p) => ({ add: p.add.map((m) => [m.valve, m.program, m.days.join(), m.slots.map((x) => x.start + '/' + x.temp).join()]), edit: p.edit.map((m) => [m.id, m.days.join()]), remove: p.remove });

test('planCopy whole valve + replace: target programs are replaced, others stay, source and duplicates dropped', () => {
  const s1 = mk(SRC, 'auto', WORK, [[0, 18], [360, 21]]), s2 = mk(SRC, 'auto', ['sat', 'sun'], [[420, 22]]), s3 = mk(SRC, 'even', ALL);
  const a1 = mk(A, 'auto', ALL), a2 = mk(A, 'vac', ALL);
  const p = plan([s1, s2, s3, a1, a2], { mode: 'valve', programs: ['auto', 'even'], targets: [A, B, A, SRC], conflict: 'replace' });
  assert.deepEqual(shape(p), {
    add: [[A, 'auto', WORK.join(), '0/18,360/21'], [A, 'auto', 'sat,sun', '420/22'], [A, 'even', ALL.join(), '0/20'],
      [B, 'auto', WORK.join(), '0/18,360/21'], [B, 'auto', 'sat,sun', '420/22'], [B, 'even', ALL.join(), '0/20']], edit: [], remove: [a1.id],
  });
  assert.equal(p.add[1].slots[0].start, 420, 'a first start after 00:00 is kept, no 00:00 slot invented');
  assert.deepEqual(Object.keys(p.notes), [A, B]);
  assert.equal(p.notes[A], 'nahradí Výchozí (1 rozvrh); ostatní programy doplní.');
  assert.equal(p.notes[B], 'dostane 3 rozvrhy, nic se nepřepíše.');
  const miss = plan([s3, mk(SRC, 'vac', ALL)], { mode: 'valve', programs: ['even', 'vac'], targets: [B] });
  assert.equal(miss.notes[B], 'přeskočeno, program Dovolená v jeho okruhu není.');
  assert.deepEqual(shape(miss), { add: [], edit: [], remove: [] });
});

test('planCopy whole valve + fill: a program the target has is kept', () => {
  const s1 = mk(SRC, 'auto', ALL), s2 = mk(SRC, 'vac', ALL);
  const a1 = mk(A, 'auto', ['mon']);
  const p = plan([s1, s2, a1], { mode: 'valve', programs: ['auto', 'vac'], targets: [A], conflict: 'fill' });
  assert.deepEqual(shape(p), { add: [[A, 'vac', ALL.join(), '0/20']], edit: [], remove: [] });
  assert.equal(p.notes[A], 'Výchozí nechá být, doplní jen Dovolená.');
  const none = plan([s1, a1], { mode: 'valve', programs: ['auto'], targets: [A], conflict: 'fill' });
  assert.deepEqual(shape(none), { add: [], edit: [], remove: [] });
  assert.equal(none.notes[A], 'Výchozí nechá být, doplní jen nic.');
});

test('planCopy selected + replace: copied weekdays leave the target schedules, a schedule without days is removed', () => {
  const s1 = mk(SRC, 'auto', WORK, [[0, 18], [360, 21]]);
  const full = mk(A, 'auto', ALL), exact = mk(B, 'auto', WORK, [[0, 5]]);
  const p = plan([s1, full, exact], { mode: 'one', scheduleIds: [s1.id], targets: [A, B], conflict: 'replace' });
  assert.deepEqual(shape(p), { add: [[A, 'auto', WORK.join(), '0/18,360/21'], [B, 'auto', WORK.join(), '0/18,360/21']], edit: [[full.id, 'sat,sun']], remove: [exact.id] });
  assert.deepEqual(p.edit[0].slots, full.slots);
  assert.equal(p.notes[A], 'v Výchozí přepíše stejné dny, ostatní dny zůstanou.');
  const clean = plan([s1], { mode: 'one', scheduleIds: [s1.id], targets: [A], conflict: 'replace' });
  assert.equal(clean.notes[A], 'dostane 1 rozvrh, nic se nepřepíše.');
});

test('planCopy selected + fill: only the weekdays the target has free; nothing free = no copy', () => {
  const s1 = mk(SRC, 'auto', WORK);
  const a1 = mk(A, 'auto', ['mon', 'tue', 'wed']), b1 = mk(B, 'auto', ALL);
  const p = plan([s1, a1, b1], { mode: 'one', scheduleIds: [s1.id], targets: [A, B], conflict: 'fill' });
  assert.deepEqual(shape(p), { add: [[A, 'auto', 'thu,fri', '0/20']], edit: [], remove: [] });
  assert.equal(p.notes[A], 'doplní jen dny, které v Výchozí ještě nemá.');
  assert.equal(p.notes[B], 'nic nedoplní, dny už v Výchozí má.');
});

test('planCopy selected: target program, program missing in the circuit, two copies never share a weekday', () => {
  const s1 = mk(SRC, 'auto', WORK), s2 = mk(SRC, 'even', ['fri', 'sat']);
  const p = plan([s1, s2], { mode: 'one', scheduleIds: [s1.id, s2.id], targetProgram: 'vac', targets: [A, B], conflict: 'replace' });
  assert.deepEqual(shape(p), { add: [[A, 'vac', WORK.join(), '0/20'], [A, 'vac', 'sat', '0/20']], edit: [], remove: [] });
  assert.equal(p.notes[B], 'přeskočeno, program Dovolená v jeho okruhu není.');
});

test('planCopy: read-only and paused schedules are never copied; a read-only target schedule is never touched', () => {
  const ro = mk(SRC, 'auto', WORK, [[0, 20]], { item: { repeat_type: 'single' } });
  const paused = mk(SRC, 'auto', ['sat'], [[0, 20]], { tags: ['paused'] });
  const ok = mk(SRC, 'even', ALL);
  const aRo = mk(A, 'even', ['mon'], [[0, 20]], { item: { repeat_type: 'single' } });
  const aRo2 = mk(A, 'auto', ['mon'], [[0, 20]], { item: { repeat_type: 'single' } });
  assert.equal(aRo.editable, false);
  const none = plan([ro, paused], { mode: 'valve', programs: ['auto'], targets: [A] });
  assert.deepEqual(shape(none), { add: [], edit: [], remove: [] });
  assert.equal(none.notes[A], 'není co kopírovat.');
  const w = plan([ok, aRo], { mode: 'valve', programs: ['even'], targets: [A], conflict: 'replace' });
  assert.deepEqual(shape(w), { add: [], edit: [], remove: [] }, 'whole program skipped: it holds a read-only schedule');
  assert.match(w.notes[A], /jen ke čtení/);
  const o = plan([ok, aRo, aRo2], { mode: 'one', scheduleIds: [ok.id], targets: [A], conflict: 'replace' });
  assert.deepEqual(shape(o), { add: [[A, 'even', 'tue,wed,thu,fri,sat,sun', '0/20']], edit: [], remove: [] }, 'the read-only Monday stays taken');
});

test('planCopy: an edited target schedule keeps its slots, toPayload keeps its name and dates', () => {
  const s1 = mk(SRC, 'auto', ['mon']);
  const a1 = mk(A, 'auto', ['mon', 'tue'], [[0, 17], [480, 22]], { item: { name: 'Můj', start_date: '2026-01-01' } });
  const p = plan([s1, a1], { mode: 'one', scheduleIds: [s1.id], targets: [A], conflict: 'replace' });
  const body = toPayload(p.edit[0], a1);
  assert.deepEqual([body.schedule_id, body.name, body.start_date, body.weekdays], [a1.id, 'Můj', '2026-01-01', ['tue']]);
  assert.deepEqual(body.timeslots.map((t) => t.start), ['00:00:00', '08:00:00']);
});
