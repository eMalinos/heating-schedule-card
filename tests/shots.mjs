// Screenshot pages for tests/dom.html?shot=week|fallback|states|editor|picker (&dark=1, &w=<px>): the canvas data (Main2.dc.html) in a
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
const item = (id, weekdays, program, slots) => ({
  schedule_id: id, entity_id: `switch.schedule_${id}`, weekdays, repeat_type: 'repeat', tags: [`program:${program}`], name: null,
  timeslots: slots.map(([a, b, temp]) => ({ start: t(a), stop: b === 24 ? '23:59:00' : t(b), conditions: [], actions: [{ service: 'climate.set_temperature', entity_id: V, service_data: { temperature: temp } }] })),
});
const ITEMS = [
  item('a1', ['mon', 'tue', 'wed', 'thu', 'fri'], 'auto', [[0, 6, 18], [6, 8, 21.5], [8, 16, 19], [16, 22, 21.5], [22, 24, 18]]),
  item('a2', ['sat', 'sun'], 'auto', [[0, 7.5, 18], [7.5, 23, 21], [23, 24, 18]]),
  item('e1', ['mon', 'tue', 'wed', 'thu', 'fri'], 'even', [[0, 5.5, 18], [5.5, 7.5, 22], [7.5, 15, 19], [15, 22.5, 22], [22.5, 24, 18.5]]),
  item('e2', ['sat', 'sun'], 'even', [[0, 8, 18.5], [8, 23, 21.5], [23, 24, 18.5]]),
  item('v1', ['daily'], 'vacation', [[0, 24, 16]]),
];
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
    callWS: async () => ITEMS, callApi: async () => {}, callService: async () => {},
    connection: { subscribeMessage: async () => () => {} },
  };
  const card = document.createElement('heating-schedule-card');
  card.setConfig({ ...cfg, circuits: [{ id: C, name: 'Přízemí', valves: [V, 'climate.kitchen_valve'] }] });
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
document.title = `shot ${shot}`;
