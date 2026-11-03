// heating-schedule-card: weekly heating schedules of climate valves, stored by scheduler-component.
// One plain ES module: no build step, no dependencies. Pure functions are exported for `node --test`.
const VERSION = '0.1.0';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Po', tue: 'Út', wed: 'St', thu: 'Čt', fri: 'Pá', sat: 'So', sun: 'Ne' };
const DAY_ALIASES = { daily: DAYS, workday: DAYS.slice(0, 5), weekend: DAYS.slice(5) };
const DAY_END = 1440;
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- formatting ----------

export const fmtTemp = (t) => String(Math.round(t * 10) / 10).replace('.', ',');
export const fmtTime = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;

/** Days as a short Czech label: `Po–Pá`, `So–Ne`, `Po, St, Pá`, `Po–Ne`. Runs of 2+ consecutive days are ranges. */
export function daysLabel(days) {
  const idx = DAYS.map((d, i) => (days.includes(d) ? i : -1)).filter((i) => i >= 0);
  const parts = [];
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
    const a = DAY_LABELS[DAYS[idx[i]]], b = DAY_LABELS[DAYS[idx[j]]];
    parts.push(j > i ? `${a}–${b}` : a);
    i = j + 1;
  }
  return parts.join(', ');
}

const STOPS = ['#3D7FD9', '#7FAEE6', '#F0C27A', '#EE8A45', '#DA4A2C'];
const STOPS_DARK = ['#5AA0FF', '#9CC3F0', '#F0D3A8', '#F59A5B', '#FF6A45'];
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Temperature colour: 15–25 °C over the Bento dial stops (clamped). */
export function tempColor(t, dark = false) {
  const stops = dark ? STOPS_DARK : STOPS;
  const x = Math.min(1, Math.max(0, (t - 15) / 10)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const a = rgb(stops[i]), b = rgb(stops[i + 1]), f = x - i;
  return '#' + a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).toUpperCase().padStart(2, '0')).join('');
}

// ---------- config ----------

export function normalizeConfig(config) {
  const fail = (m) => { throw new Error(`heating-schedule-card: ${m}`); };
  if (!config || typeof config !== 'object') fail('config is required');
  const { circuits, valve = null } = config;
  if (!Array.isArray(circuits) || !circuits.length) fail('`circuits` must be a non-empty list');
  const valveCircuit = {};
  const out = circuits.map((c, i) => {
    if (!c || typeof c.id !== 'string' || !c.id) fail(`circuits[${i}].id is required`);
    if (!Array.isArray(c.valves) || !c.valves.length) fail(`circuits[${i}].valves must be a non-empty list`);
    for (const v of c.valves) {
      if (typeof v !== 'string' || !v.startsWith('climate.')) fail(`circuits[${i}].valves: "${v}" is not a climate entity`);
      valveCircuit[v] = c.id;
    }
    return { id: c.id, name: c.name || null, valves: [...c.valves] };
  });
  if (valve != null && !valveCircuit[valve]) fail(`valve "${valve}" is not in any circuit`);
  const timeStep = config.time_step ?? 15;
  if (!(timeStep > 0) || 1440 % timeStep) fail('`time_step` must be a positive divisor of 1440');
  return { valve, circuits: out, timeStep, valveCircuit };
}

/** Circuit title: configured name, else the `title` of binary_sensor.heating_state_<id>, else the id. */
export const circuitName = (hass, c) => c.name || hass?.states?.[`binary_sensor.heating_state_${c.id}`]?.attributes?.title || c.id;

// ---------- schedules: scheduler-component item <-> model ----------

const SUN = /^sun(rise|set)/i;
const toMin = (t) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };
const hms = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}:00`;

/**
 * One element of the WS `{type: 'scheduler'}` list (scheduler-component's async_get_entity_state) -> the card's model:
 * {id, switch, valve, program, days, slots: [{start, end, temp}], paused, editable, raw}.
 * Not editable (shown read-only, never written): repeat_type != repeat, conditions, other actions, several valves,
 * sun-relative times, or slots not covering 00:00–24:00 without gaps.
 */
export function parseSchedule(item) {
  const tags = item.tags || [];
  const days = [...new Set((item.weekdays || []).flatMap((d) => DAY_ALIASES[d] || [d]))].filter((d) => DAYS.includes(d));
  days.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  let editable = item.repeat_type === 'repeat' && days.length > 0;
  const valves = new Set();
  const slots = [];
  for (const ts of item.timeslots || []) {
    const actions = ts.actions || [];
    if ((ts.conditions || []).length) editable = false;
    if (actions.length !== 1 || actions[0].service !== 'climate.set_temperature') { editable = false; continue; }
    const a = actions[0];
    [].concat(a.entity_id ?? []).forEach((e) => valves.add(e));
    const temp = Number((a.service_data ?? a.data ?? {}).temperature);
    if (!Number.isFinite(temp)) editable = false;
    if (SUN.test(ts.start) || SUN.test(ts.stop ?? '')) { editable = false; continue; }
    slots.push({ start: toMin(ts.start), end: ts.stop == null ? NaN : toMin(ts.stop), temp });
  }
  // The last slot's stop is 00:00 or 23:59 (the whole-day slot of older schedules) = end of the day.
  const last = slots[slots.length - 1];
  if (last && (last.end === 0 || last.end === DAY_END - 1)) last.end = DAY_END;
  const covers = slots.length > 0 && slots[0].start === 0 && last.end === DAY_END
    && slots.every((s, i) => s.end > s.start && (i === 0 || s.start === slots[i - 1].end));
  if (!covers || valves.size !== 1) editable = false;
  const program = tags.find((t) => t.startsWith('program:'))?.slice(8) || 'auto';
  return {
    id: item.schedule_id, switch: item.entity_id, valve: valves.size === 1 ? [...valves][0] : null,
    program, days, slots, paused: tags.includes('paused'), editable, raw: item,
  };
}

/** Model -> body for `scheduler/add` (no id) or `scheduler/edit` (`schedule_id`). `existing` = the parsed schedule being edited. */
export function toPayload(model, existing = null) {
  const kept = (existing?.raw?.tags ?? []).filter((t) => t !== 'paused' && !t.startsWith('program:'));
  const days = DAYS.filter((d) => model.days.includes(d));
  const body = {
    weekdays: days.length === 7 ? ['daily'] : days,
    timeslots: model.slots.map((s, i) => ({
      start: hms(s.start),
      stop: i === model.slots.length - 1 && s.end >= DAY_END ? '00:00:00' : hms(s.end),
      actions: [{ service: 'climate.set_temperature', entity_id: model.valve, service_data: { temperature: s.temp } }],
    })),
    repeat_type: 'repeat',
    tags: [...kept, `program:${model.program}`, ...(model.paused ? ['paused'] : [])],
    name: null,
  };
  const id = model.id ?? existing?.id;
  if (id) body.schedule_id = id;
  return body;
}

// ---------- what a valve does ----------

/**
 * Schedules a valve uses on `day`: the running program's non-paused schedules that include the day, else `auto`'s
 * (fallback per day, `isFallback` true then). Same rules as heating's `heating_slot_temp`.
 */
export function effective(schedules, valve, program, day) {
  const on = schedules.filter((s) => s.valve === valve && !s.paused && s.days.includes(day));
  const own = on.filter((s) => s.program === program);
  if (own.length || program === 'auto') return { schedules: own, isFallback: false };
  return { schedules: on.filter((s) => s.program === 'auto'), isFallback: true };
}

const slotsOf = (list) => list.flatMap((s) => s.slots).sort((a, b) => a.start - b.start);

/**
 * The slot a valve follows at `date` -> {temp, start, end, fromYesterday, next: {start, temp, tomorrow} | null}.
 * Latest start <= now today, else the last slot of yesterday's schedules (the evening slot holds past midnight),
 * else today's own last slot (as heating does). `start` / `end` are minutes of the day the slot belongs to.
 */
export function slotAt(schedules, valve, program, date) {
  const dow = (d) => DAYS[(d.getDay() + 6) % 7];
  const day = (offset) => slotsOf(effective(schedules, valve, program, dow(new Date(+date + offset * 864e5))).schedules);
  const now = date.getHours() * 60 + date.getMinutes();
  const today = day(0), yesterday = day(-1);
  const cur = today.filter((s) => s.start <= now).pop();
  const pick = cur || yesterday[yesterday.length - 1] || today[today.length - 1];
  if (!pick) return null;
  const nextToday = today.find((s) => s.start > now);
  const nxt = nextToday || day(1)[0];
  return {
    temp: pick.temp, start: pick.start, end: pick.end, fromYesterday: !cur && yesterday.includes(pick),
    next: nxt ? { start: nxt.start, temp: nxt.temp, tomorrow: !nextToday } : null,
  };
}

/** Schedules of one valve grouped by program: Map(program -> [schedule]), `auto` first. */
export function groupByProgram(schedules, valve) {
  const g = new Map([['auto', []]]);
  for (const s of schedules) if (s.valve === valve) (g.get(s.program) ?? g.set(s.program, []).get(s.program)).push(s);
  return g;
}

// ---------- data access ----------

export async function loadSchedules(hass) {
  return ((await hass.callWS({ type: 'scheduler' })) || []).map(parseSchedule);
}

/** Adds (no model.id) or edits one schedule; `existing` = its parsed schedule when editing. */
export function saveSchedule(hass, model, existing = null) {
  const body = toPayload(model, existing);
  return hass.callApi('POST', body.schedule_id ? 'scheduler/edit' : 'scheduler/add', body);
}

export const removeSchedule = (hass, id) => hass.callApi('POST', 'scheduler/remove', { schedule_id: id });

// ---------- element ----------

const STYLE = `
  :host { display: block; }
  ha-card { padding: 16px; color: var(--primary-text-color); }
  h3 { margin: 0 0 8px; font-size: 16px; }
  .prog { margin: 8px 0 2px; color: var(--secondary-text-color); font-size: 13px; }
  .row { display: flex; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--divider-color); font-size: 14px; }
  .row.off { opacity: .5; }
  .days { min-width: 90px; }
  .chip { display: inline-block; padding: 0 6px; margin-right: 4px; border-radius: 8px; color: #fff; }
  .muted { color: var(--secondary-text-color); }
`;

class HeatingScheduleCard extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._schedules = [];
    this._pendingOff = new Set(); // ids of schedules just created: their switch is turned off once it exists
  }

  setConfig(config) {
    this._cfg = normalizeConfig(config);
    this._valve = this._cfg.valve || this._cfg.circuits[0].valves[0];
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) { this._load(); this._subscribe(); }
    this._render();
  }

  connectedCallback() { if (this._hass) this._subscribe(); }

  disconnectedCallback() {
    clearTimeout(this._timer);
    const unsub = this._unsub;
    this._unsub = null;
    Promise.resolve(unsub).then((u) => u && u());
  }

  getCardSize() { return 4; }

  getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto' }; }

  _subscribe() {
    if (this._unsub || !this._hass?.connection) return;
    this._unsub = this._hass.connection.subscribeMessage((ev) => {
      if (ev?.event === 'scheduler_item_created' && ev.schedule_id) this._pendingOff.add(ev.schedule_id);
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._load(), 300);
    }, { type: 'scheduler_updated' });
  }

  async _load() {
    const hass = this._hass;
    try {
      this._schedules = await loadSchedules(hass);
      this._error = null;
    } catch (e) {
      this._error = e?.message || String(e);
    }
    // scheduler-component creates every schedule on; this card keeps them off (heating alone fires the valves)
    for (const s of this._schedules) {
      if (this._pendingOff.delete(s.id)) hass.callService('switch', 'turn_off', { entity_id: s.switch });
    }
    this._render();
  }

  _render() {
    if (!this._cfg) return;
    const hass = this._hass;
    const circuit = this._cfg.circuits.find((c) => c.id === this._cfg.valveCircuit[this._valve]);
    const title = hass?.states?.[this._valve]?.attributes?.friendly_name || this._valve;
    const groups = [...groupByProgram(this._schedules, this._valve)].filter(([p, l]) => l.length || p === 'auto');
    const row = (s) => `<div class="row${s.paused ? ' off' : ''}"><span class="days">${esc(daysLabel(s.days))}</span><span>${
      s.slots.map((x) => `<span class="chip" style="background:${tempColor(x.temp)}">${fmtTime(x.start)} ${fmtTemp(x.temp)}&nbsp;°C</span>`).join('')
    }${s.editable ? '' : '<span class="muted">jen ke čtení</span>'}</span></div>`;
    const body = this._error ? `<div class="muted">Chyba: ${esc(this._error)}</div>`
      : groups.map(([p, list]) => `<div class="prog">${esc(p === 'auto' ? 'Výchozí' : p)}</div>${list.map(row).join('') || '<div class="muted">Žádný rozvrh</div>'}`).join('');
    this.shadowRoot.innerHTML = `<style>${STYLE}</style><ha-card><h3>${esc(title)}${circuit ? ` <span class="muted">· ${esc(circuitName(hass, circuit))}</span>` : ''}</h3>${body}</ha-card>`;
  }
}

if (globalThis.customElements && !customElements.get('heating-schedule-card')) {
  customElements.define('heating-schedule-card', HeatingScheduleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'heating-schedule-card', name: 'Heating Schedule Card', description: 'Weekly heating schedules of climate valves (scheduler-component storage).' });
  console.info(`%c HEATING-SCHEDULE-CARD %c ${VERSION} `, 'color:#fff;background:#DA4A2C', '');
}

export { HeatingScheduleCard, VERSION };
