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

export const fmtTemp = (t) => (t == null ? '–' : String(Math.round(t * 10) / 10).replace('.', ','));
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
  if (t == null || !Number.isFinite(t)) return '#9AA0A6'; // unknown temperature: neutral grey
  const stops = dark ? STOPS_DARK : STOPS;
  const x =Math.min(1, Math.max(0, (t - 15) / 10)) * (stops.length - 1);
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
 * {id, switch, valve, valves, program, days, slots: [{start, end, temp}], paused, editable, raw}.
 * Like heating, only slot STARTS count: slots are sorted, each ends where the next starts, the last at 24:00 (a first
 * slot after 00:00 is fine: the previous day's last slot holds until then). `valve` = the only valve, else null.
 * Not editable (shown read-only, never written): repeat_type != repeat, workday / weekend weekdays, conditions,
 * other actions, no or several valves, no temperature, sun-relative times, overlapping or duplicate slots.
 */
export function parseSchedule(item) {
  const tags = item.tags || [];
  const weekdays = item.weekdays || [];
  const days = [...new Set(weekdays.flatMap((d) => DAY_ALIASES[d] || [d]))].filter((d) => DAYS.includes(d));
  days.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  let editable = item.repeat_type === 'repeat' && days.length > 0 && !weekdays.some((d) => d === 'workday' || d === 'weekend');
  const valves = [];
  const slots = [];
  for (const ts of item.timeslots || []) {
    const actions = ts.actions || [];
    if ((ts.conditions || []).length) editable = false;
    for (const a of actions) for (const e of [].concat(a.entity_id ?? [])) if (e.startsWith('climate.') && !valves.includes(e)) valves.push(e);
    const set = actions.find((a) => a.service === 'climate.set_temperature');
    if (actions.length !== 1 || !set) editable = false;
    const raw = set && (set.service_data ?? set.data ?? {}).temperature;
    const temp = raw == null || raw === '' || !Number.isFinite(Number(raw)) ? null : Number(raw);
    if (temp === null) editable = false;
    if (SUN.test(ts.start) || SUN.test(ts.stop ?? '')) { editable = false; continue; }
    const stop = ts.stop == null ? null : toMin(ts.stop) || DAY_END; // 00:00 = end of the day
    slots.push({ start: toMin(ts.start), end: stop, temp });
  }
  slots.sort((a, b) => a.start - b.start);
  slots.forEach((s, i) => {
    const next = slots[i + 1];
    if (next && (next.start === s.start || (s.end != null && s.end > next.start))) editable = false;
    s.end = next ? next.start : DAY_END;
  });
  if (!slots.length || valves.length !== 1) editable = false;
  const program = tags.find((t) => t.startsWith('program:'))?.slice(8) || 'auto';
  return {
    id: item.schedule_id, switch: item.entity_id, valve: valves.length === 1 ? valves[0] : null, valves,
    program, days, slots, paused: tags.includes('paused'), editable, raw: item,
  };
}

/**
 * Model -> body for `scheduler/add` (no id) or `scheduler/edit` (`schedule_id`). `existing` = the parsed schedule being
 * edited. The model owns weekdays, timeslots, tags and repeat_type; name, start_date and end_date are kept from the
 * existing item.
 */
export function toPayload(model, existing = null) {
  const raw = existing?.raw ?? {};
  const kept = (raw.tags ?? []).filter((t) => t !== 'paused' && !t.startsWith('program:'));
  const days = DAYS.filter((d) => model.days.includes(d));
  const body = {
    weekdays: days.length === 7 ? ['daily'] : days,
    timeslots: model.slots.map((s, i) => ({
      start: hms(s.start),
      stop: i === model.slots.length - 1 ? '23:59:00' : hms(model.slots[i + 1].start),
      actions: [{ service: 'climate.set_temperature', entity_id: model.valve, service_data: { temperature: s.temp } }],
    })),
    repeat_type: 'repeat',
    tags: [...kept, `program:${model.program}`, ...(model.paused ? ['paused'] : [])],
    name: raw.name ?? null,
  };
  for (const k of ['start_date', 'end_date']) if (raw[k] != null) body[k] = raw[k];
  const id = model.id ?? existing?.id;
  if (id) body.schedule_id = id;
  return body;
}

// ---------- what a valve does ----------

/**
 * Schedules a valve uses on `day`: the running program's non-paused schedules that include the day, else `auto`'s
 * (fallback per day, `isFallback` true then). A schedule with several valves counts for each of them (heating matches
 * by `entities` membership). Same rules as heating's `heating_slot_temp`.
 */
export function effective(schedules, valve, program, day) {
  const on = schedules.filter((s) => s.valves.includes(valve) && !s.paused && s.days.includes(day));
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
  const day = (offset) => {
    const d = new Date(date); // calendar days, not 24 h: a DST change day is 23 / 25 h long
    d.setDate(d.getDate() + offset);
    return slotsOf(effective(schedules, valve, program, dow(d)).schedules);
  };
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
  for (const s of schedules) if (s.valves.includes(valve)) (g.get(s.program) ?? g.set(s.program, []).get(s.program)).push(s);
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
    this._created = new Set(); // ids of schedules just created: their switch is turned off once it exists
    this._turning = new Set(); // ids with a turn_off in flight
    this._seq = 0;
  }

  setConfig(config) {
    this._cfg = normalizeConfig(config);
    this._valve = this._cfg.valve || this._cfg.circuits[0].valves[0];
    this._sig = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._start();
    // re-render only when what the card reads from the states changed
    const sig = this._signature();
    if (sig !== this._sig) this._render();
  }

  connectedCallback() { this._start(); }

  disconnectedCallback() {
    // a pending reload is dropped (connectedCallback reloads); `_created` is kept for the next load
    clearTimeout(this._timer);
    this._started = false;
    const unsub = this._unsub;
    this._unsub = null;
    Promise.resolve(unsub).then((u) => u && u()).catch(() => {});
  }

  getCardSize() { return 4; }

  getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto' }; }

  _start() {
    if (!this._hass || !this._cfg || !this.isConnected) return;
    this._subscribe(); // also retried on every hass update after a failure
    if (!this._started) { this._started = true; this._load(); }
  }

  _subscribe() {
    if (this._unsub || !this._hass.connection) return;
    const p = this._hass.connection.subscribeMessage((ev) => {
      if (ev?.event === 'scheduler_item_created' && ev.schedule_id) this._created.add(ev.schedule_id);
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._load(), 300);
    }, { type: 'scheduler_updated' });
    this._unsub = p;
    Promise.resolve(p).then(() => { if (this._subError) { this._subError = null; this._render(); } }, (e) => {
      if (this._unsub === p) this._unsub = null;
      this._subError = e?.message || 'scheduler-component neodpovídá';
      this._render();
    });
  }

  async _load() {
    const hass = this._hass, n = ++this._seq;
    let schedules = null;
    try {
      schedules = await loadSchedules(hass);
    } catch (e) {
      if (n === this._seq) this._error = e?.message || String(e);
    }
    if (n !== this._seq) return; // a newer load is in flight: ignore this response
    if (schedules) { this._schedules = schedules; this._error = null; }
    this._turnOff();
    this._render();
  }

  /** scheduler-component creates every schedule on; this card keeps its own off (heating alone fires the valves). */
  _turnOff() {
    const mine = new Set(this._cfg.circuits.flatMap((c) => c.valves));
    for (const id of [...this._created]) {
      const s = this._schedules.find((x) => x.id === id);
      if (!s) continue; // not listed yet: retried on the next load
      if (!s.valves.some((v) => mine.has(v))) { this._created.delete(id); continue; } // not ours: never touched
      if (!this._hass.states?.[s.switch] || this._turning.has(id)) continue; // switch entity not there yet
      this._turning.add(id);
      Promise.resolve(this._hass.callService('switch', 'turn_off', { entity_id: s.switch }))
        .then(() => this._created.delete(id), () => {}) // failed: stays queued for the next load
        .then(() => this._turning.delete(id));
    }
  }

  _signature() {
    const st = this._hass?.states ?? {};
    const c = this._cfg.circuits.find((x) => x.id === this._cfg.valveCircuit[this._valve]);
    return JSON.stringify([st[this._valve]?.attributes?.friendly_name, c && circuitName(this._hass, c)]);
  }

  _render() {
    if (!this._cfg) return;
    this._sig = this._signature();
    const hass = this._hass;
    const circuit = this._cfg.circuits.find((c) => c.id === this._cfg.valveCircuit[this._valve]);
    const title = hass?.states?.[this._valve]?.attributes?.friendly_name || this._valve;
    const groups = [...groupByProgram(this._schedules, this._valve)].filter(([p, l]) => l.length || p === 'auto');
    const row = (s) => `<div class="row${s.paused ? ' off' : ''}"><span class="days">${esc(daysLabel(s.days))}</span><span>${
      s.slots.map((x) => `<span class="chip" style="background:${tempColor(x.temp)}">${fmtTime(x.start)} ${fmtTemp(x.temp)}&nbsp;°C</span>`).join('')
    }${s.editable ? '' : '<span class="muted">jen ke čtení</span>'}</span></div>`;
    const err = this._subError || this._error;
    const body = (err ? `<div class="muted">Chyba: ${esc(err)}</div>` : '')
      + groups.map(([p, list]) => `<div class="prog">${esc(p === 'auto' ? 'Výchozí' : p)}</div>${list.map(row).join('') || '<div class="muted">Žádný rozvrh</div>'}`).join('');
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
