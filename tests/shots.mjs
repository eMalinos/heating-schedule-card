// Screenshot pages for tests/dom.html?shot=week|fallback|states|editor|picker|copy-valve|copy-one|week3|editor3|programs|settings (&dark=1, &w=<px>): the canvas data (Main2.dc.html) in a
// fake hass with a fixed clock (Monday 14:20), to compare the card with the artboards by eye.
const q = new URLSearchParams(location.search);
const shot = q.get('shot'), dark = q.has('dark'), width = Number(q.get('w')) || 580;

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(2026, 10, 2, 14, 20); } // Mon 2026-11-02 14:20
  static now() { return new RealDate(2026, 10, 2, 14, 20).getTime(); }
};
await import('../dist/heating-schedule-card.js');

const V = 'climate.living_valve', C = 'heating_circuit_1';
const t = (h) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}:00`;
const item = (id, weekdays, program, slots, valve = V, tags = []) => ({
  schedule_id: id, entity_id: `switch.schedule_${id}`, weekdays, repeat_type: 'repeat', tags: [`program:${program}`, ...tags], name: null,
  timeslots: slots.map(([a, b, temp]) => ({ start: t(a), stop: b === 24 ? '23:59:00' : t(b), conditions: [], actions: [{ service: 'climate.set_temperature', entity_id: valve, service_data: { temperature: temp } }] })),
});
const ITEMS = [
  item('a1', ['mon', 'tue', 'wed', 'thu', 'fri'], 'auto', [[0, 6, 18], [6, 8, 21.5], [8, 16, 19], [16, 22, 21.5], [22, 24, 18]]),
  item('a2', ['sat', 'sun'], 'auto', [[0, 7.5, 18], [7.5, 23, 21], [23, 24, 18]]),
  item('e1', ['mon', 'tue', 'wed', 'thu', 'fri'], 'even', [[0, 5.5, 18], [5.5, 7.5, 22], [7.5, 15, 19], [15, 22.5, 22], [22.5, 24, 18.5]]),
  item('e2', ['sat', 'sun'], 'even', [[0, 8, 18.5], [8, 23, 21.5], [23, 24, 18.5]]),
  item('v1', ['daily'], 'vacation', [[0, 24, 16]]),
];
let items = ITEMS; // the copy shots add schedules of the other valves
const PROGRAMS = { programs: ['auto', 'odd', 'even', 'vacation'], program_names: { auto: 'Výchozí', odd: 'Lichý týden', even: 'Sudý týden', vacation: 'Dovolená' } };

const states = (patch = {}) => ({
  [V]: { state: 'heat', attributes: { friendly_name: 'Obývák', temperature: 19 } },
  [`binary_sensor.heating_state_${C}`]: { state: 'on', attributes: { title: 'Přízemí' } },
  [`sensor.heating_program_${C}`]: { state: 'auto', attributes: PROGRAMS },
  [`sensor.heating_schedule_${C}`]: { state: 'auto', attributes: { targets: { [V]: 19 } } },
  [`binary_sensor.heating_active_${C}`]: { state: 'on', attributes: {} },
  [`input_select.heating_mode_${C}`]: { state: 'on', attributes: {} },
  [`sensor.heating_off_schedule_${C}`]: { state: '0', attributes: { window_open_climates: [] } },
  [`sensor.heating_valves_${C}`]: { state: '0', attributes: { phases: { [V]: ['normal'] }, forced: [], closed: [] } },
  [`sensor.heating_applying_${C}`]: { state: 'idle', attributes: { left: 0 } },
  ...patch,
});
const s = (id, state, attributes = {}) => ({ [id]: { state, attributes } });
const STATES = {
  'normální': {},
  'vypnuto': s(`input_select.heating_mode_${C}`, 'off'),
  'počasí netopí': s(`binary_sensor.heating_active_${C}`, 'off'),
  'okno otevřené': { ...s(`sensor.heating_off_schedule_${C}`, '1', { window_open_climates: [V] }), [V]: { state: 'heat', attributes: { friendly_name: 'Obývák', temperature: 5 } } },
  'ručně': { [V]: { state: 'heat', attributes: { friendly_name: 'Obývák', temperature: 23 } } },
  'rychlý start': s(`sensor.heating_valves_${C}`, '1', { phases: { [V]: ['fast'] }, forced: [V], closed: [] }),
  'nastavuji': s(`sensor.heating_applying_${C}`, 'applying', { left: 3 }),
};

const mk = async (label, patch, pick, cfg = { valve: V }) => {
  const wrap = document.createElement('div');
  wrap.style.cssText = `width:${width}px;margin:0 0 16px;border-radius:28px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,.15)`;
  document.body.append(wrap);
  if (label) wrap.insertAdjacentHTML('beforebegin', `<div style="font:600 12px sans-serif;margin:8px 0 4px">${label}</div>`);
  const hass = {
    themes: { darkMode: dark }, states: states(patch),
    callWS: async () => items, callApi: async () => {}, callService: async () => {},
    connection: { subscribeMessage: async () => () => {} },
  };
  const card = document.createElement('heating-schedule-card');
  card.setConfig({ circuits: [{ id: C, name: 'Přízemí', valves: [V, 'climate.kitchen_valve'] }], ...cfg });
  card.hass = hass;
  wrap.append(card);
  await new Promise((r) => setTimeout(r, 150));
  if (pick) card.shadowRoot.querySelector(`.chip[data-id="${pick}"]`).click();
  return card;
};

document.body.style.cssText = `margin:0;padding:24px;background:${dark ? '#101318' : '#e8ebef'};font-family:Roboto,system-ui,sans-serif;`
  + (dark ? '--ha-card-background:#181c22;--secondary-background-color:#21262e;--divider-color:#262c35;--primary-color:#86a9d1;--primary-text-color:#e9edf2;--secondary-text-color:#949ca8' : '--ha-card-background:#fff;--secondary-background-color:#f0f2f5;--divider-color:#dfe3e8;--primary-color:#4f6b8c;--primary-text-color:#1c2128;--secondary-text-color:#666e79');
if (shot === 'week') await mk('', {});
else if (shot === 'fallback') await mk('', {}, 'odd');
else if (shot === 'editor') { // Editor1: Výchozí, Po–Pá, the 16:00–22:00 slot selected
  const c = await mk('', {});
  c.shadowRoot.querySelector('.row [data-a="open"]').click();
  c.shadowRoot.querySelector('[data-a="sel"][data-k="3"]').click();
} else if (shot === 'picker') { // Picker1: general card (no `valve`), Obývák + Kuchyň picked
  const c = await mk('', {}, null, {});
  c._valve = V;
  c.shadowRoot.querySelector('[data-a="add"]').click();
  c.shadowRoot.querySelector('[data-a="pv"][data-k="climate.kitchen_valve"]').click();
} else if (shot === 'states') for (const [k, p] of Object.entries(STATES)) await mk(k, p);
// Copy1 / Copy2 (canvas CopyValve2 / CopyOne2): Obývák -> Kuchyň + Ložnice, two circuits
const C2 = 'heating_circuit_2';
const OTHERS = { kitchen: ['climate.kitchen_valve', 'Kuchyň'], workroom: ['climate.workroom_valve', 'Pracovna'], hall: ['climate.hall_valve', 'Chodba'],
  kids: ['climate.kids_valve', 'Dětský pokoj'], bedroom: ['climate.bedroom_valve', 'Ložnice'], bath: ['climate.bath_valve', 'Koupelna'] };
const copyShot = async (pre) => {
  const WK = ['mon', 'tue', 'wed', 'thu', 'fri'], WE = ['sat', 'sun'], ALL = [...WK, ...WE];
  const two = (id, v, prog) => [item(`${id}1`, WK, prog, [[0, 6, 18], [6, 22, 21], [22, 24, 18]], v), item(`${id}2`, WE, prog, [[0, 24, 20]], v)];
  items = [...ITEMS, ...two('k', OTHERS.kitchen[0], 'auto'), item('h1', ALL, 'auto', [[0, 24, 19]], OTHERS.hall[0]),
    ...two('d', OTHERS.kids[0], 'auto'), item('d3', ALL, 'vacation', [[0, 24, 16]], OTHERS.kids[0]),
    ...two('b', OTHERS.bedroom[0], 'auto'), ...two('w', OTHERS.bath[0], 'auto'), item('w3', WK, 'even', [[0, 24, 21]], OTHERS.bath[0])];
  const names = Object.fromEntries(Object.values(OTHERS).map(([id, n]) => [id, { state: 'heat', attributes: { friendly_name: n, temperature: 20 } }]));
  const patch = { ...names, [`binary_sensor.heating_state_${C2}`]: { state: 'on', attributes: { title: 'Patro' } }, [`sensor.heating_program_${C2}`]: { state: 'auto', attributes: PROGRAMS } };
  const cfg = { valve: V, circuits: [{ id: C, name: 'Přízemí', valves: [V, OTHERS.kitchen[0], OTHERS.workroom[0], OTHERS.hall[0]] }, { id: C2, name: 'Patro', valves: [OTHERS.kids[0], OTHERS.bedroom[0], OTHERS.bath[0]] }] };
  const c = await mk('', patch, null, cfg);
  const q = (sel) => c.shadowRoot.querySelector(sel);
  q('[data-a="copyOpen"]').click();
  q(`[data-a="cp-tgt"][data-k="${OTHERS.kitchen[0]}"]`).click();
  q(`[data-a="cp-tgt"][data-k="${OTHERS.bedroom[0]}"]`).click();
  pre(q);
};
if (shot === 'copy-valve') await copyShot((q) => { q('[data-a="cp-pt"][data-k="vacation"]').click(); });
else if (shot === 'copy-one') await copyShot((q) => { q('[data-a="cp-mode"][data-k="one"]').click(); q('[data-a="cp-row"][data-k="a1"]').click(); });
// v3 (Main3.dc.html): Výchozí has odd / even Po–Pá schedules (the alternation is on, Monday 2026-11-02 is an odd week), programs Dovolená + Chata
const WKD = ['mon', 'tue', 'wed', 'thu', 'fri'];
const V3 = [
  item('o1', WKD, 'auto', [[0, 6, 18], [6, 8, 21.5], [8, 16, 19], [16, 22, 21.5], [22, 24, 18]], V, ['week:odd']),
  item('e1', WKD, 'auto', [[0, 5.5, 18], [5.5, 7.5, 21.5], [7.5, 15, 19.5], [15, 22.5, 21.5], [22.5, 24, 18]], V, ['week:even']),
  item('a2', ['sat', 'sun'], 'auto', [[0, 7.5, 18], [7.5, 23, 21], [23, 24, 18]]),
  item('v1', ['daily'], 'vacation', [[0, 24, 16]]),
];
const V3STATES = (hol = 'cz') => ({
  [`sensor.heating_program_${C}`]: { state: 'auto', attributes: { programs: ['auto', 'vacation', 'chata'], program_names: { auto: 'Výchozí', vacation: 'Dovolená', chata: 'Chata' } } },
  [`sensor.heating_programs_${C}`]: { state: '2', attributes: { programs: [{ id: 'vacation', name: 'Dovolená' }, { id: 'chata', name: 'Chata' }], holiday_dates: [], holiday_error: null } },
  [`input_boolean.heating_week_alternation_${C}`]: { state: 'on', attributes: {} },
  [`input_select.heating_holidays_${C}`]: { state: hol, attributes: {} },
  [`input_text.heating_holiday_calendar_${C}`]: { state: '', attributes: {} },
  [`sensor.heating_schedule_${C}`]: { state: 'auto', attributes: { targets: { [V]: 19 }, week: 'odd', week_number: 45, holiday_today: false,
    holidays_next: [['2026-11-17', 'Den boje za svobodu a demokracii'], ['2026-12-24', 'Štědrý den'], ['2026-12-25', '1. svátek vánoční'], ['2026-12-26', '2. svátek vánoční']].map(([date, name]) => ({ date, name })) } },
});
if (shot === 'week3') { items = V3; await mk('', V3STATES()); }
else if (shot === 'editor3') { // Editor3: Po–Pá lichý, the 16:00–22:00 slot selected
  items = V3;
  const c = await mk('', V3STATES());
  c.shadowRoot.querySelector('.row [data-a="open"]').click();
  c.shadowRoot.querySelector('[data-a="sel"][data-k="3"]').click();
} else if (shot === 'programs') { // Programs3
  items = [...V3, item('c1', WKD, 'vacation', [[0, 24, 16]], 'climate.kitchen_valve'), item('c2', ['sat', 'sun'], 'vacation', [[0, 24, 16]], 'climate.kitchen_valve')];
  const c = await mk('', V3STATES());
  c.shadowRoot.querySelector('.chip.add').click();
} else if (shot === 'settings') { // Settings3 (&cal=1: SettingsCal3)
  items = V3;
  const cal = q.has('cal');
  const c = await mk('', { ...V3STATES(cal ? 'calendar' : 'cz'), ...(cal ? { 'calendar.slovakia': { state: 'off', attributes: {} }, [`input_text.heating_holiday_calendar_${C}`]: { state: 'calendar.slovakia', attributes: {} } } : {}) });
  c.shadowRoot.querySelector('[data-a="cog"]').click();
}
document.title = `shot ${shot}`;
