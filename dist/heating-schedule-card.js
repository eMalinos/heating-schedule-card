// heating-schedule-card: weekly heating schedules of climate valves, stored by scheduler-component.
// One plain ES module: no build step, no dependencies. Pure functions are exported for `node --test`.
const VERSION = '0.1.0';

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Po', tue: 'Út', wed: 'St', thu: 'Čt', fri: 'Pá', sat: 'So', sun: 'Ne' };
const DAY_ALIASES = { daily: DAYS, workday: DAYS.slice(0, 5), weekend: DAYS.slice(5) };
const DAY_END = 1440;
export const dow = (d) => DAYS[(d.getDay() + 6) % 7];
const pad = (n) => String(n).padStart(2, '0');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- formatting ----------

export const DASH = '–';
export const fmtTemp = (t) => (t == null ? DASH : String(Math.round(t * 10) / 10).replace('.', ','));
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

const slotsOf = (list) => list.flatMap((s) => s.slots.map((x) => ({ ...x, schedule: s }))).sort((a, b) => a.start - b.start);

/**
 * The slot a valve follows at `date` -> {temp, start, end, fromYesterday, next: {start, temp, tomorrow} | null}.
 * Latest start <= now today, else the last slot of yesterday's schedules (the evening slot holds past midnight),
 * else today's own last slot (as heating does). `start` / `end` are minutes of the day the slot belongs to.
 */
export function slotAt(schedules, valve, program, date) {
  const day = (offset) => {
    const d = new Date(date); // calendar days, not 24 h: a DST change day is 23 / 25 h long
    d.setDate(d.getDate() + offset);
    const e = effective(schedules, valve, program, dow(d));
    return slotsOf(e.schedules).map((x) => ({ ...x, schedule: x.schedule, isFallback: e.isFallback }));
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
    schedule: pick.schedule, isFallback: pick.isFallback,
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


// ---------- editor: pure logic ----------
// Editor slots = [{start, end, temp}] in minutes, sorted, covering 00:00-24:00. Every helper returns a new array (or the
// same one when nothing can change).

const snap = (m, step) => Math.round(m / step) * step;

/** Copy of the slots for editing. A first slot after 00:00 stays as it is: the time before it is carried over from the previous day. */
export const normalizeSlots = (slots) => slots.map((x) => ({ ...x }));

/** Splits slot `i` in halves at the nearest `step`; both halves keep at least `step`. */
export function splitSlot(slots, i, step = 15) {
  const s = slots[i];
  if (!s || s.end - s.start < 2 * step) return slots;
  const mid = Math.min(s.end - step, Math.max(s.start + step, snap((s.start + s.end) / 2, step)));
  return [...slots.slice(0, i), { ...s, end: mid }, { ...s, start: mid }, ...slots.slice(i + 1)];
}

/** Removes slot `i`: the previous slot grows over it, the first one is taken over by the next. The last slot stays. */
export function removeSlot(slots, i) {
  if (slots.length < 2 || !slots[i]) return slots;
  if (i === 0) return [{ ...slots[1], start: slots[0].start }, ...slots.slice(2)];
  return [...slots.slice(0, i - 1), { ...slots[i - 1], end: slots[i].end }, ...slots.slice(i + 1)];
}

/**
 * Moves the boundary where slot `i` starts (= where `i - 1` ends) by `delta` minutes; both slots keep at least `step`.
 * The first slot's start moves only when it is not 00:00 already (a schedule that carries the previous day over).
 */
export function moveBoundary(slots, i, delta, step = 15) {
  if (i === 0 && slots[0]?.start > 0) {
    const at = Math.min(slots[0].end - step, Math.max(0, slots[0].start + delta));
    return at === slots[0].start ? slots : [{ ...slots[0], start: at }, ...slots.slice(1)];
  }
  if (i < 1 || i >= slots.length) return slots;
  const a = slots[i - 1], b = slots[i];
  if (a.start + step > b.end - step) return slots;
  const at = Math.min(b.end - step, Math.max(a.start + step, b.start + delta));
  if (at === b.start) return slots;
  return [...slots.slice(0, i - 1), { ...a, end: at }, { ...b, start: at }, ...slots.slice(i + 1)];
}

export const TEMP_MIN = 5, TEMP_MAX = 30;

/** Temperature of slot `i`, rounded to 0.5 and clamped to 5-30 °C. */
export function setTemp(slots, i, t) {
  if (!slots[i] || !Number.isFinite(t)) return slots;
  const temp = Math.min(TEMP_MAX, Math.max(TEMP_MIN, Math.round(t * 2) / 2));
  return slots.map((s, k) => (k === i ? { ...s, temp } : s));
}

/** Of `days`, those another schedule of the same valve and program already uses (`exceptId` = the one being edited). */
export function daysConflict(schedules, valve, program, days, exceptId = null) {
  const used = new Set(schedules.filter((s) => s.id !== exceptId && s.program === program && s.valves.includes(valve)).flatMap((s) => s.days));
  return DAYS.filter((d) => days.includes(d) && used.has(d));
}

const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n < 5 ? few : many}`;

// ---------- week view: pure logic ----------

const stateOf = (states, id) => states?.[id]?.state;
const attrOf = (states, id, a) => states?.[id]?.attributes?.[a];

/** A program without any schedule of this valve (paused ones count) runs on `auto`'s schedules. */
export const isFallbackProgram = (groups, program) => program !== 'auto' && !groups.get(program)?.length;

/** Bar segments covering 00:00–24:00: a first slot after 00:00 is preceded by the last slot (it holds past midnight). */
export function barSegments(s) {
  const slots = s.slots;
  if (!slots.length) return [];
  return slots[0].start > 0 ? [{ start: 0, end: slots[0].start, temp: slots[slots.length - 1].temp }, ...slots] : slots;
}

/** One-line summary of a schedule: `celý den 21 °C` / `5 úseků · 18–21,5 °C`. */
export function slotsSummary(s) {
  const t = s.slots.map((x) => x.temp).filter((x) => x != null);
  if (!s.slots.length) return 'bez úseků';
  if (s.slots.length === 1) return `celý den ${fmtTemp(s.slots[0].temp)} °C`;
  const n = s.slots.length;
  return `${n} ${n < 5 ? 'úseky' : 'úseků'} · ${t.length ? `${fmtTemp(Math.min(...t))}–${fmtTemp(Math.max(...t))} °C` : '–'}`;
}

const PHASES = {
  fast: ['Rychlý start', 'warm', 'fire', 'naplno'],
  run: ['Doběh', 'warm', 'fire', 'naplno'],
  overrun: ['Doběh čerpadla', 'warm', 'fire', 'naplno'],
  closed: ['Zavřeno', 'cold', 'power', 'zavřená'],
};

/**
 * What the heating automation does with a valve now, for the tile at the top. First match wins: applying, mode off,
 * circuit not heating, window open, valve held (phase), manual (valve target != schedule target), normal.
 * -> {kind, icon, text, sub, temp, unit, tone: 'cold' | 'warm' | 'accent' | °C number | null, muted, btn}.
 * `program` = the running program, `nValves` = valves of the circuit (for "N z M hotovo").
 */
export function nowState({ states = {}, circuit, valve, schedules, program, now = new Date(), nValves = 0 }) {
  const slot = slotAt(schedules, valve, program, now);
  const sched = slot?.temp ?? attrOf(states, `sensor.heating_schedule_${circuit}`, 'targets')?.[valve] ?? null;
  const schedTxt = sched == null ? null : `${fmtTemp(sched)} °C`;
  const at = (m, tomorrow) => `${tomorrow ? 'zítra v ' : 'v '}${fmtTime(m)}`;
  const tile = (kind, icon, text, sub, temp, extra = {}) => ({ kind, icon, text, sub, temp, unit: temp === DASH ? '' : '°C', tone: null, muted: false, btn: '', ...extra });
  const wouldBe = schedTxt ? ` · teď by bylo ${schedTxt}` : '';

  if (stateOf(states, `sensor.heating_applying_${circuit}`) === 'applying') {
    const left = Number(attrOf(states, `sensor.heating_applying_${circuit}`, 'left')) || 0;
    return tile('applying', 'progressClock', 'Nastavuji hlavice podle rozvrhu', `${Math.max(0, nValves - left)} z ${nValves} hotovo · po uložení nebo změně programu`,
      fmtTemp(sched), { tone: 'accent' });
  }
  if (stateOf(states, `input_select.heating_mode_${circuit}`) === 'off') {
    return tile('off', 'power', 'Topení je vypnuté', `Rozvrh platí, až se zapne${wouldBe}`, DASH, { muted: true });
  }
  if (stateOf(states, `binary_sensor.heating_active_${circuit}`) === 'off') {
    return tile('noheat', 'weatherPartlyCloudy', 'Podle počasí se netopí', `Rozvrh počká${wouldBe}`, DASH, { muted: true });
  }
  const win = attrOf(states, `sensor.heating_off_schedule_${circuit}`, 'window_open_climates') || [];
  if (win.includes(valve)) {
    const t = attrOf(states, valve, 'temperature');
    return tile('window', 'windowOpenVariant', 'Okno otevřené', `Hlavice zavřená${schedTxt ? ` · po zavření ${schedTxt} podle rozvrhu` : ''}`,
      t == null ? DASH : fmtTemp(Number(t)), { tone: 'cold' });
  }
  const vs = `sensor.heating_valves_${circuit}`;
  const listed = (a) => (attrOf(states, vs, a) || []).includes(valve);
  const phase = attrOf(states, vs, 'phases')?.[valve]?.[0];
  const ph = PHASES[phase] || (listed('closed') ? PHASES.closed : listed('forced') ? PHASES.fast : null);
  if (ph) {
    return tile('held', ph[2], ph[0], `Hlavice ${ph[3]}${schedTxt ? `, pak ${schedTxt} podle rozvrhu` : ''}`, fmtTemp(sched), { tone: ph[1] });
  }
  const target = Number(attrOf(states, valve, 'temperature'));
  const planned = attrOf(states, `sensor.heating_schedule_${circuit}`, 'targets')?.[valve];
  if (planned != null && Number.isFinite(target) && attrOf(states, valve, 'temperature') != null && Math.abs(target - planned) > 0.05) {
    const n = slot?.next;
    return tile('manual', 'pencil', `Ručně ${fmtTemp(target)} °C`,
      n ? `Rozvrh to ${at(n.start, n.tomorrow)} vrátí na ${fmtTemp(n.temp)} °C` : `Podle rozvrhu by bylo ${fmtTemp(planned)} °C`,
      fmtTemp(target), { tone: target, btn: 'Podle rozvrhu' });
  }
  if (!slot) return tile('none', 'clockOutline', 'Žádný rozvrh', 'Pro tuto hlavici není žádný rozvrh', DASH, { muted: true });
  const by = slot.isFallback ? ' podle Výchozího' : '';
  const n = slot.next;
  const names = attrOf(states, `sensor.heating_program_${circuit}`, 'program_names') || {};
  return tile('normal', 'clockOutline',
    `Teď ${fmtTemp(slot.temp)} °C${n ? `, od ${n.tomorrow ? 'zítra ' : ''}${fmtTime(n.start)} ${fmtTemp(n.temp)} °C` : ''}${by}`,
    `Běží program ${names[program] || (program === 'auto' ? 'Výchozí' : program)}${slot.schedule ? ` · ${daysLabel(slot.schedule.days)}` : ''}`,
    fmtTemp(slot.temp), { tone: slot.temp });
}

const slotKey = (slots) => JSON.stringify(slots.map((x) => [x.start, x.temp]));
/** The parts the editor writes (program, weekdays, slots) are equal. */
const sameContent = (a, b) => a.program === b.program && a.days.join() === b.days.join() && slotKey(a.slots) === slotKey(b.slots);

// ---------- element ----------

const ICONS = {
  power: 'M16.56,5.44L15.11,6.89C16.84,7.94 18,9.83 18,12A6,6 0 0,1 12,18A6,6 0 0,1 6,12C6,9.83 7.16,7.94 8.88,6.88L7.44,5.44C5.36,6.88 4,9.28 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,9.28 18.64,6.88 16.56,5.44M13,3H11V13H13',
  weatherPartlyCloudy: 'M12.74,5.47C15.1,6.5 16.35,9.03 15.92,11.46C17.19,12.56 18,14.19 18,16V16.17C18.31,16.06 18.65,16 19,16A3,3 0 0,1 22,19A3,3 0 0,1 19,22H6A4,4 0 0,1 2,18A4,4 0 0,1 6,14H6.27C5,12.45 4.6,10.24 5.5,8.26C6.72,5.5 9.97,4.24 12.74,5.47M11.93,7.3C10.16,6.5 8.09,7.31 7.31,9.07C6.85,10.09 6.93,11.22 7.41,12.13C8.5,10.83 10.16,10 12,10C12.7,10 13.38,10.12 14,10.34C13.94,9.06 13.18,7.86 11.93,7.3M19,18H16V16A4,4 0 0,0 12,12A4,4 0 0,0 8,16H6A2,2 0 0,0 4,18A2,2 0 0,0 6,20H19A1,1 0 0,0 20,19A1,1 0 0,0 19,18Z',
  windowOpenVariant: 'M21 20V2H3V20H1V23H23V20M19 4V11H17V4M5 4H7V11H5M5 20V13H7V20M9 20V4H15V20M17 20V13H19V20Z',
  pencil: 'M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z',
  progressClock: 'M13,2.03V2.05L13,4.05C17.39,4.59 20.5,8.58 19.96,12.97C19.5,16.61 16.64,19.5 13,19.93V21.93C18.5,21.38 22.5,16.5 21.95,11C21.5,6.25 17.73,2.5 13,2.03M11,2.06C9.05,2.25 7.19,3 5.67,4.26L7.1,5.74C8.22,4.84 9.57,4.26 11,4.06V2.06M4.26,5.67C3,7.19 2.25,9.04 2.05,11H4.05C4.24,9.58 4.8,8.23 5.69,7.1L4.26,5.67M2.06,13C2.26,14.96 3.03,16.81 4.27,18.33L5.69,16.9C4.81,15.77 4.24,14.42 4.06,13H2.06M7.1,18.37L5.67,19.74C7.18,21 9.04,21.79 11,22V20C9.58,19.82 8.23,19.25 7.1,18.37M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z',
  clockOutline: 'M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z',
  calendarWeek: 'M6 1H8V3H16V1H18V3H19C20.11 3 21 3.9 21 5V19C21 20.11 20.11 21 19 21H5C3.89 21 3 20.1 3 19V5C3 3.89 3.89 3 5 3H6V1M5 8V19H19V8H5M7 10H17V12H7V10Z',
  contentCopy: 'M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z',
  plus: 'M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z',
  chevronDown: 'M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z',
  chevronLeft: 'M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z',
  minus: 'M19,13H5V11H19V13Z',
  check: 'M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z',
  checkCircle: 'M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z',
  deleteOutline: 'M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H16V19H8V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z',
  split: 'M18,16V13H15V22H13V2H15V11H18V8L22,12L18,16M2,12L6,16V13H9V22H11V2H9V11H6V8L2,12Z',
  fire: 'M17.66 11.2C17.43 10.9 17.15 10.64 16.89 10.38C16.22 9.78 15.46 9.35 14.82 8.72C13.33 7.26 13 4.85 13.95 3C13 3.23 12.17 3.75 11.46 4.32C8.87 6.4 7.85 10.07 9.07 13.22C9.11 13.32 9.15 13.42 9.15 13.55C9.15 13.77 9 13.97 8.8 14.05C8.57 14.15 8.33 14.09 8.14 13.93C8.08 13.88 8.04 13.83 8 13.76C6.87 12.33 6.69 10.28 7.45 8.64C5.78 10 4.87 12.3 5 14.47C5.06 14.97 5.12 15.47 5.29 15.97C5.43 16.57 5.7 17.17 6 17.7C7.08 19.43 8.95 20.67 10.96 20.92C13.1 21.19 15.39 20.8 17.03 19.32C18.86 17.66 19.5 15 18.56 12.72L18.43 12.46C18.22 12 17.66 11.2 17.66 11.2Z',
};
const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="${ICONS[name]}"></path></svg>`;

// Bento tokens (`--bento-*`) with the HA theme variables as fallback. `.dark` only changes the fallbacks and the shadows.
const STYLE = `
  :host { display: block; container-type: inline-size; }
  ha-card { display: block; box-sizing: border-box; padding: 20px; background: var(--bento-card, var(--ha-card-background, var(--card-background-color, #fff))); }
  .card {
    --c-card: var(--bento-card, var(--ha-card-background, var(--card-background-color, #fff)));
    --c-fill: var(--bento-fill, var(--secondary-background-color, #f0f2f5));
    --c-border: var(--bento-border, var(--divider-color, #dfe3e8));
    --c-accent: var(--bento-accent, var(--primary-color, #4f6b8c));
    --c-text: var(--bento-text, var(--primary-text-color, #1c2128));
    --c-text2: var(--bento-text-2, var(--secondary-text-color, #666e79));
    --c-raised: var(--bento-raised, linear-gradient(0deg, color-mix(in srgb, var(--c-fill) 55%, var(--c-border)) 0%, var(--c-fill) 30%, #fff 100%));
    --c-raised-shadow: var(--bento-raised-shadow, inset 0 1px 0 #fff, inset 0 -1px 0 rgba(0,0,0,.05), 0 1px 2px rgba(0,0,0,.08), 0 3px 8px rgba(0,0,0,.05));
    --c-inset: inset 0 1px 3px rgba(0,0,0,.08);
    --c-tint: color-mix(in srgb, var(--c-accent) 14%, var(--c-card));
    --c-on-accent: #fff;
    --c-green: #2e9e5b;
    --c-cold: #3d7fd9; --c-warm: #c2522a;
    display: flex; flex-direction: column; gap: 18px; color: var(--c-text); font-family: inherit;
  }
  .card.dark {
    --c-raised: var(--bento-raised, linear-gradient(0deg, var(--c-card) 0%, color-mix(in srgb, var(--c-fill) 82%, #fff) 100%));
    --c-raised-shadow: var(--bento-raised-shadow, inset 0 1px 0 rgba(255,255,255,.08), inset 0 -1px 0 rgba(0,0,0,.35), 0 1px 2px rgba(0,0,0,.45), 0 3px 8px rgba(0,0,0,.3));
    --c-inset: inset 0 1px 3px rgba(0,0,0,.5);
    --c-tint: color-mix(in srgb, var(--c-accent) 26%, var(--c-card));
    --c-on-accent: #10141a; --c-green: #5fd68a; --c-cold: #5aa0ff; --c-warm: #ff8a61;
  }
  button, select { font-family: inherit; color: inherit; cursor: pointer; }
  .sec { font-size: 12px; color: var(--c-text2); }
  .label { font-size: 11px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; color: var(--c-text2); }
  .head { display: flex; align-items: center; gap: 12px; }
  .head .t { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .head .t b { font-size: 20px; font-weight: 700; letter-spacing: -.4px; overflow-wrap: anywhere; }
  .pill { position: relative; display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 12px 0 16px; border: 1px solid var(--c-border); border-radius: 999px; background: var(--c-raised); box-shadow: var(--c-raised-shadow); font-size: 14px; font-weight: 600; }
  .pill select { position: absolute; inset: 0; width: 100%; opacity: 0; }
  .now { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 18px; border: 1px solid var(--c-border);
    background: linear-gradient(150deg, var(--c-fill) 15%, color-mix(in srgb, var(--tone) 22%, var(--c-fill)) 100%); }
  .card.dark .now { background: linear-gradient(150deg, var(--c-fill) 15%, color-mix(in srgb, var(--tone) 30%, var(--c-fill)) 100%); }
  .now.muted { background: var(--c-fill); box-shadow: var(--c-inset); opacity: .85; border-color: transparent; }
  .ic { width: 36px; height: 36px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--c-card); color: var(--c-text2); }
  .now:not(.muted) .ic.tone { background: var(--tone); color: #fff; }
  .now .tx { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .now .tx b { font-size: 15px; font-weight: 600; }
  .now .big { font-size: 26px; font-weight: 700; letter-spacing: -.8px; }
  .now .big small { font-size: 12px; font-weight: 500; margin-left: 1px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 0 14px; border: 1px solid var(--c-border); border-radius: 999px; background: var(--c-raised); box-shadow: var(--c-raised-shadow); font-size: 14px; font-weight: 600; }
  .btn.primary { min-height: 48px; border-color: color-mix(in srgb, var(--c-accent) 70%, #000); color: var(--c-on-accent); font-weight: 700;
    background: linear-gradient(0deg, var(--c-accent) 0%, color-mix(in srgb, var(--c-accent) 80%, #fff) 100%); box-shadow: inset 0 1px 0 rgba(255,255,255,.25), 0 2px 8px color-mix(in srgb, var(--c-accent) 35%, transparent); }
  .btn.wide { min-height: 48px; width: 100%; }
  .btn:disabled { opacity: .5; cursor: default; }
  .progs { display: flex; flex-direction: column; gap: 8px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; min-height: 44px; padding: 0 16px; border-radius: 999px; font-size: 14px; font-weight: 600; border: 1px solid var(--c-border); background: var(--c-raised); box-shadow: var(--c-raised-shadow); }
  .chip[aria-pressed="true"] { border-color: color-mix(in srgb, var(--c-accent) 45%, var(--c-border)); background: var(--c-tint); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c-green); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-green) 22%, transparent); }
  .rows { display: flex; flex-direction: column; gap: 10px; }
  .row { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 18px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .row .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .row .open { flex: 1; display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-width: 0; padding: 0; border: 0; background: none; text-align: left; }
  .row .open b { font-size: 15px; font-weight: 700; }
  .row .bar { cursor: pointer; }
  .row.ro .bar, .row.ro .open, .rows.dim .row .bar, .rows.dim .row .open { cursor: default; }
  .row.paused .bar, .row.paused .ruler { opacity: .4; }
  .row.paused .open .sec { font-weight: 600; }
  .bar { position: relative; display: flex; gap: 2px; height: 34px; padding: 3px; border-radius: 13px; background: var(--c-card); box-shadow: var(--c-inset); }
  .muted-bars .bar { opacity: .55; filter: saturate(.4); }
  .seg { flex: 1 1 0; min-width: 0; display: grid; place-items: center; border-radius: 3px; color: #1c2128; font-size: 12px; font-weight: 700; letter-spacing: -.2px; box-shadow: inset 0 1px 0 rgba(255,255,255,.45);
    background: linear-gradient(180deg, color-mix(in srgb, var(--c) 78%, #fff) 0%, var(--c) 100%); }
  .seg:first-of-type { border-top-left-radius: 10px; border-bottom-left-radius: 10px; }
  .seg:last-of-type { border-top-right-radius: 10px; border-bottom-right-radius: 10px; }
  i.nowline { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; border-radius: 2px; background: var(--c-text); box-shadow: 0 0 0 2px var(--c-card); }
  .ruler { display: flex; justify-content: space-between; padding: 0 3px; font-size: 11px; font-weight: 600; color: var(--c-text2); font-variant-numeric: tabular-nums; }
  .sw { display: inline-flex; align-items: center; gap: 8px; flex: none; min-height: 32px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .sw input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .sw .knob { position: relative; width: 38px; height: 22px; border-radius: 999px; background: var(--c-card); box-shadow: var(--c-inset); transition: background .15s; }
  .sw .knob::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--c-text2); transition: transform .15s, background .15s; }
  .sw input:checked + .knob { background: var(--c-accent); }
  .sw input:checked + .knob::after { transform: translateX(16px); background: var(--c-on-accent); }
  .sw input:focus-visible + .knob { outline: 2px solid var(--c-accent); outline-offset: 2px; }
  .sw input:disabled + .knob { opacity: .5; }
  .note { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 18px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .note b { font-size: 15px; font-weight: 600; }
  .note .tx { flex: 1; display: flex; flex-direction: column; gap: 2px; }
  .dim { opacity: .55; }
  .err { padding: 10px 14px; border-radius: 14px; background: color-mix(in srgb, var(--c-warm) 14%, var(--c-card)); color: var(--c-text); font-size: 13px; }
  .round { width: 44px; height: 44px; flex: none; display: grid; place-items: center; padding: 0; border: 1px solid var(--c-border); border-radius: 50%; background: var(--c-raised); box-shadow: var(--c-raised-shadow); }
  .btn.small { min-height: 44px; font-size: 13px; }
  .btn.danger { color: var(--c-warm); }
  .grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .col { display: flex; flex-direction: column; gap: 8px; }
  .title { font-size: 20px; font-weight: 700; letter-spacing: -.4px; }
  .days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 6px; }
  .day { min-height: 44px; padding: 0; border: 0; border-radius: 14px; background: var(--c-fill); box-shadow: var(--c-inset); color: var(--c-text2); font-size: 14px; font-weight: 700; }
  .day[aria-pressed="true"] { border: 1px solid color-mix(in srgb, var(--c-accent) 45%, var(--c-border)); background: var(--c-tint); box-shadow: var(--c-raised-shadow); color: var(--c-text); }
  .edbar { position: relative; display: flex; gap: 3px; height: 64px; padding: 5px; border-radius: 19px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .edseg { flex: 1 1 0; min-width: 0; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px; color: #1c2128; font-size: 13px; font-weight: 700; box-shadow: inset 0 1px 0 rgba(255,255,255,.45);
    background: linear-gradient(180deg, color-mix(in srgb, var(--c) 78%, #fff) 0%, var(--c) 100%); }
  .edseg:first-of-type { border-top-left-radius: 14px; border-bottom-left-radius: 14px; }
  .edseg:last-of-type { border-top-right-radius: 14px; border-bottom-right-radius: 14px; }
  .edseg[aria-pressed="true"] { outline: 2.5px solid var(--c-text); outline-offset: 2px; z-index: 1; }
  .handle { position: absolute; top: 50%; width: 10px; height: 34px; margin: -17px 0 0 -5px; box-sizing: border-box; border-radius: 999px; background: var(--c-raised); border: 1px solid var(--c-border); box-shadow: var(--c-raised-shadow); z-index: 2; pointer-events: none; }
  .hlabels { position: relative; height: 16px; }
  .hlabels span { position: absolute; top: 0; transform: translateX(-50%); font-size: 11px; font-weight: 600; color: var(--c-text2); font-variant-numeric: tabular-nums; }
  .panel { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 14px; border-radius: 20px; border: 1px solid var(--c-border); background: linear-gradient(150deg, var(--c-card) 15%, color-mix(in srgb, var(--tone) 14%, var(--c-card)) 100%); }
  .card.dark .panel { background: linear-gradient(150deg, var(--c-card) 15%, color-mix(in srgb, var(--tone) 22%, var(--c-card)) 100%); }
  .panel .l { display: flex; flex-direction: column; gap: 10px; flex: 1 1 220px; min-width: 0; }
  .panel .r { display: flex; flex-direction: column; align-items: center; gap: 10px; flex: none; margin: 0 auto; }
  .ttile { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 8px 8px 14px; border-radius: 16px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .ttile b { display: block; font-size: 20px; font-weight: 700; letter-spacing: -.4px; }
  .pair { display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: var(--c-raised); border: 1px solid var(--c-border); box-shadow: var(--c-raised-shadow); }
  .step { width: 44px; height: 38px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 999px; background: transparent; }
  .step:disabled { opacity: .35; cursor: default; }
  .dial { position: relative; width: 188px; height: 188px; }
  .dial > div, .dial > span { position: absolute; }
  .dial .ring { inset: 0; border-radius: 50%; }
  .dial .face { left: 50%; top: 50%; width: 117px; height: 117px; margin: -58.5px 0 0 -58.5px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; background: var(--c-card); box-shadow: 0 10px 26px rgba(40,55,80,.16), 0 0 0 1px var(--c-border); }
  .card.dark .dial .face { box-shadow: 0 10px 26px rgba(0,0,0,.6), 0 0 0 1px var(--c-border); }
  .dial .face b { font-size: 34px; font-weight: 700; letter-spacing: -1px; line-height: 1.05; }
  .dial .face small { font-size: 13px; font-weight: 500; margin-left: 2px; }
  .dial .knob2 { width: 22px; height: 22px; box-sizing: border-box; border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .dial .lim { bottom: 2px; font-size: 11px; font-weight: 600; color: var(--c-text2); }
  .why { font-size: 13px; color: var(--c-warm); }
  .why:empty { display: none; }
  .edseg.carry { background: repeating-linear-gradient(135deg, var(--c-fill) 0 6px, color-mix(in srgb, var(--c-text2) 14%, var(--c-fill)) 6px 12px); color: var(--c-text2); font-size: 11px; font-weight: 600; box-shadow: none; cursor: default; }
  .err.stale { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .err.stale span { flex: 1 1 160px; font-weight: 600; }
  .tile { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 56px; padding: 10px 12px; border: 1px solid transparent; border-radius: 16px; background: var(--c-fill); box-shadow: var(--c-inset); text-align: left; }
  .tile[aria-pressed="true"] { border-color: color-mix(in srgb, var(--c-accent) 45%, var(--c-border)); background: var(--c-tint); box-shadow: var(--c-raised-shadow); }
  .tile .tic { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--c-card); color: var(--c-warm); }
  .tile[aria-pressed="true"] .tic { background: var(--c-accent); color: var(--c-on-accent); }
  .tile .tx { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .tile .tx b { font-size: 14px; font-weight: 600; }
  .tile .tx .sec { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tile.sel { justify-content: space-between; }
  .tile.sel select { position: absolute; inset: 0; width: 100%; opacity: 0; }
  .confirm { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 12px 14px; border-radius: 18px; background: color-mix(in srgb, var(--c-warm) 14%, var(--c-card)); }
  .confirm span { flex: 1 1 160px; font-size: 14px; font-weight: 600; }
  button:focus-visible, select:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
  @container (max-width: 450px) {
    ha-card { padding: 16px; }
    .card { gap: 16px; }
    .head .t b { font-size: 18px; }
    .now .big { font-size: 22px; }
    .now .btn { flex: 1 1 100%; }
    .chip { padding: 0 14px; }
    .dial { zoom: .9; }
  }
`;

class HeatingScheduleCard extends (globalThis.HTMLElement ?? class {}) {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._schedules = [];
    this._created = new Map(); // id -> loads that did not list it yet; schedules just created: their switch is turned off once it exists
    this._turning = new Set(); // ids with a turn_off in flight
    this._busy = new Set(); // ids of schedules being written (pause toggle), `copy` while the fallback copy runs
    this._seq = 0;
    this._view = 'week'; // 'week' | 'picker' | 'editor'
    this._ed = null; // editor state while view is 'editor'
    this._pick = null; // valve picker state while view is 'picker'
    this.shadowRoot.addEventListener('click', (e) => this._click(e));
    this.shadowRoot.addEventListener('change', (e) => this._change(e));
    // a render deferred while something in the card had focus runs once the focus leaves
    this.shadowRoot.addEventListener('focusout', () => setTimeout(() => { if (this._dirty) this._render(); }, 0));
  }

  setConfig(config) {
    this._cfg = normalizeConfig(config);
    this._valve = this._cfg.valve || this._cfg.circuits[0].valves[0];
    this._prog = null;
    this._progPicked = false; // until a chip is picked the card shows the running program
    this._view = 'week';
    this._ed = this._pick = null;
    this._sig = null;
    this._render(true);
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
    clearInterval(this._tick);
    clearTimeout(this._errTimer);
    this._tick = null;
    this._started = false;
    const unsub = this._unsub;
    this._unsub = null;
    Promise.resolve(unsub).then((u) => u && u()).catch(() => {});
  }

  getCardSize() { return 6; }

  getGridOptions() { return { columns: 12, min_columns: 6, rows: 'auto' }; }

  _start() {
    if (!this._hass || !this._cfg || !this.isConnected) return;
    this._subscribe(); // also retried on every hass update after a failure
    if (!this._tick) this._tick = setInterval(() => this._render(), 60000); // the now line and tile follow the clock
    if (!this._started) { this._started = true; this._load(); }
  }

  _subscribe() {
    if (this._unsub || !this._hass.connection) return;
    const p = this._hass.connection.subscribeMessage((ev) => {
      if (ev?.event === 'scheduler_item_created' && ev.schedule_id) this._created.set(ev.schedule_id, 0);
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
      if (n === this._seq) this._loadError = e?.message || String(e);
    }
    if (n !== this._seq) return; // a newer load is in flight: ignore this response
    if (schedules) { this._schedules = schedules; this._loadError = null; }
    this._turnOff();
    this._render();
  }

  /** scheduler-component creates every schedule on; this card keeps its own off (heating alone fires the valves). */
  _turnOff() {
    const mine = new Set(this._cfg.circuits.flatMap((c) => c.valves));
    for (const id of [...this._created.keys()]) {
      const s = this._schedules.find((x) => x.id === id);
      if (!s) { // not listed yet: retried on the next load, dropped after a few (rolled back or removed elsewhere)
        if (this._created.get(id) >= 3) this._created.delete(id); else this._created.set(id, this._created.get(id) + 1);
        continue;
      }
      if (!s.valves.some((v) => mine.has(v))) { this._created.delete(id); continue; } // not ours: never touched
      if (!this._hass.states?.[s.switch] || this._turning.has(id)) continue; // switch entity not there yet
      this._turning.add(id);
      Promise.resolve(this._hass.callService('switch', 'turn_off', { entity_id: s.switch }))
        .then(() => this._created.delete(id), () => {}) // failed: stays queued for the next load
        .then(() => this._turning.delete(id));
    }
  }

  _allValves() { return [...new Set(this._cfg.circuits.flatMap((c) => c.valves))]; }

  /** Programs every picked valve's circuit(s) have (a valve listed in two circuits needs both). */
  _pickerPrograms() {
    const valves = this._pick.valves.length ? this._pick.valves : [this._valve];
    const cs = [...new Set(valves.flatMap((v) => this._cfg.circuits.filter((c) => c.valves.includes(v))))];
    const lists = cs.map((c) => this._programs(c).list);
    return lists[0].filter((p) => lists.every((l) => l.some((q) => q.id === p.id)));
  }

  _circuit() { return this._cfg.circuits.find((c) => c.id === this._cfg.valveCircuit[this._valve]); }

  /** Everything the week view reads from the states; a change of any of it re-renders. */
  _signature() {
    const st = this._hass?.states ?? {};
    const c = this._circuit();
    const id = c.id, v = this._valve;
    const a = (e, k) => st[e]?.attributes?.[k];
    const s = (e) => st[e]?.state;
    return JSON.stringify([
      this._hass?.themes?.darkMode,
      this._cfg.circuits.flatMap((x) => x.valves).map((x) => a(x, 'friendly_name')), this._cfg.circuits.map((x) => circuitName(this._hass, x)),
      a(v, 'temperature'),
      s(`sensor.heating_program_${id}`), a(`sensor.heating_program_${id}`, 'programs'), a(`sensor.heating_program_${id}`, 'program_names'),
      s(`binary_sensor.heating_active_${id}`), s(`input_select.heating_mode_${id}`),
      a(`sensor.heating_off_schedule_${id}`, 'window_open_climates'),
      a(`sensor.heating_valves_${id}`, 'phases')?.[v]?.[0], a(`sensor.heating_valves_${id}`, 'forced'), a(`sensor.heating_valves_${id}`, 'closed'),
      s(`sensor.heating_applying_${id}`), a(`sensor.heating_applying_${id}`, 'left'),
      a(`sensor.heating_schedule_${id}`, 'targets'),
    ]);
  }

  // ---------- actions ----------

  _click(e) {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const { a, id } = el.dataset;
    if (a === 'prog') { this._prog = id; this._progPicked = true; this._render(true); }
    else if (a === 'sync') {
      Promise.resolve().then(() => this._hass.callService('input_button', 'press', { entity_id: `input_button.heating_sync_${this._circuit().id}` }))
        .catch((err) => this._fail(err));
    }
    else if (a === 'open' || a === 'add') {
      // rows and the add button announce `hsc-edit`; the editor opens unless a listener calls preventDefault
      const ev = new CustomEvent('hsc-edit', { bubbles: true, composed: true, cancelable: true, detail: { valve: this._valve, program: this._prog, schedule: id ? this._schedules.find((s) => s.id === id) : null } });
      if (this.dispatchEvent(ev)) this._onEdit(ev);
    } else if (a === 'copyDefault') this._copyDefault();
    else this._editorAction(el.dataset);
  }

  _change(e) {
    const el = e.target.closest('[data-a]');
    if (!el) return;
    if (el.dataset.a === 'valve') { this._valve = el.value; this._prog = null; this._progPicked = false; this._render(true); }
    else if (el.dataset.a === 'pause') this._pause(el.dataset.id, !el.checked);
    else if (el.dataset.a === 'pickprog' && this._pick) { this._pick.program = el.value; this._render(true); }
  }

  // ---------- editor ----------

  _onEdit(e) {
    if (this._view !== 'week') return;
    const { schedule } = e.detail || {};
    const prog = this._prog;
    if (schedule) {
      const s = this._schedules.find((x) => x.id === schedule.id);
      if (!s || !s.editable) return; // read-only or gone: never opened
      this._openExisting(s);
    } else if (this._cfg.valve) {
      this._newEditor([this._valve], prog);
    } else {
      this._pick = { valves: [this._valve], program: prog };
      this._view = 'picker';
    }
    this._render(true);
  }

  _openExisting(s) {
    this._ed = { existing: s, valves: [s.valve], program: s.program, days: [...s.days], slots: normalizeSlots(s.slots), sel: 0, confirm: false, stale: false };
    this._view = 'editor';
  }

  /** A new schedule: one slot 00:00-24:00 at 20 °C, the weekdays no schedule of these valves and the program uses yet. */
  _newEditor(valves, program) {
    const used = valves.flatMap((v) => daysConflict(this._schedules, v, program, DAYS));
    this._ed = { existing: null, valves, program, days: DAYS.filter((d) => !used.includes(d)), slots: [{ start: 0, end: DAY_END, temp: 20 }], sel: 0, confirm: false, stale: false };
    this._pick = null;
    this._view = 'editor';
  }

  /** Why Uložit is disabled, or ''. */
  _saveBlock(ed) {
    if (!ed.days.length) return 'Vyber aspoň jeden den';
    const title = (v) => this._hass?.states?.[v]?.attributes?.friendly_name || v;
    const parts = ed.valves.map((v) => [v, daysConflict(this._schedules, v, ed.program, ed.days, ed.existing?.id)]).filter(([, d]) => d.length);
    if (!parts.length) return '';
    return parts.map(([v, d]) => `${ed.valves.length > 1 ? `${title(v)}: ` : ''}${d.map((x) => DAY_LABELS[x]).join(', ')} už má jiný rozvrh`).join(' · ');
  }

  _editorAction({ a, k }) {
    const ed = this._ed, step = this._cfg.timeStep, i = Number(k);
    if (a === 'back') {
      if (this._busy.has('ed')) return;
      if (this._view === 'editor' && ed?.fromPicker) { this._view = 'picker'; this._pick = { valves: ed.valves, program: ed.program }; }
      else { this._view = 'week'; this._pick = null; }
      this._ed = null;
      return this._render(true);
    }
    if (a === 'pv' && this._pick) {
      const v = this._pick.valves;
      this._pick.valves = v.includes(k) ? v.filter((x) => x !== k) : [...v, k];
      if (!this._pickerPrograms().some((p) => p.id === this._pick.program)) this._pick.program = 'auto';
      return this._render(true);
    }
    if (a === 'go' && this._pick?.valves.length) {
      // keep the order of the circuits' valve lists
      const all = this._allValves();
      this._newEditor(all.filter((v) => this._pick.valves.includes(v)), this._pick.program);
      this._ed.fromPicker = true;
      return this._render(true);
    }
    if (this._view !== 'editor' || !ed) return;
    if (a === 'day') ed.days = ed.days.includes(k) ? ed.days.filter((d) => d !== k) : [...ed.days, k];
    else if (a === 'sel') ed.sel = i;
    else if (a === 'sdn' || a === 'sup') ed.slots = moveBoundary(ed.slots, ed.sel, a === 'sdn' ? -step : step, step);
    else if (a === 'edn' || a === 'eup') ed.slots = moveBoundary(ed.slots, ed.sel + 1, a === 'edn' ? -step : step, step);
    else if (a === 'split') ed.slots = splitSlot(ed.slots, ed.sel, step);
    else if (a === 'rm') { ed.slots = removeSlot(ed.slots, ed.sel); ed.sel = Math.min(ed.sel > 0 ? ed.sel - 1 : 0, ed.slots.length - 1); }
    else if (a === 'tdn' || a === 'tup') ed.slots = setTemp(ed.slots, ed.sel, ed.slots[ed.sel].temp + (a === 'tdn' ? -0.5 : 0.5));
    else if (a === 'copy') { this.dispatchEvent(new CustomEvent('hsc-copy', { bubbles: true, composed: true, detail: { valve: ed.valves[0], program: ed.program, schedule: ed.existing } })); return; }
    else if (a === 'reload') {
      const fresh = this._schedules.find((x) => x.id === ed.existing?.id);
      if (fresh?.editable) this._openExisting(fresh); else this._leave();
    }
    else if (a === 'del') ed.confirm = true;
    else if (a === 'delno') ed.confirm = false;
    else if (a === 'delok') return this._deleteEditor();
    else if (a === 'save') return this._saveEditor();
    this._render(true);
  }

  _leave() { this._view = 'week'; this._ed = this._pick = null; }

  _saveEditor() {
    const ed = this._ed;
    if (!ed || this._busy.has('ed') || ed.stale || this._saveBlock(ed)) return;
    return this._write('ed', async () => {
      const fresh = await loadSchedules(this._hass); // the stored state right now, not the list from a while ago
      if (ed.existing) {
        const cur = fresh.find((x) => x.id === ed.existing.id);
        if (!cur || !cur.editable) throw new Error('Rozvrh už neexistuje nebo ho nelze upravovat');
        if (!sameContent(cur, ed.existing)) { ed.stale = true; return; } // changed elsewhere: ask instead of overwriting
        // days, slots and program come from the editor; paused, name, foreign tags and dates from the stored version
        await saveSchedule(this._hass, { id: cur.id, valve: cur.valve, program: ed.program, days: ed.days, slots: ed.slots, paused: cur.paused }, cur);
      } else {
        if (ed.valves.some((v) => daysConflict(fresh, v, ed.program, ed.days).length)) throw new Error('Některý z dnů už má jiný rozvrh');
        const before = new Set(fresh.map((x) => x.id));
        const days = DAYS.filter((d) => ed.days.includes(d));
        const expected = ed.valves.map((valve) => ({ valve, program: ed.program, days, slots: ed.slots }));
        try {
          for (const e of expected) await saveSchedule(this._hass, { ...e, paused: false });
        } catch (err) { await this._rollback(before, expected); throw err; }
      }
      if (this._ed === ed) this._leave(); // another editor may be open by now
    });
  }

  _deleteEditor() {
    const ed = this._ed;
    if (!ed?.existing || this._busy.has('ed')) return;
    return this._write('ed', async () => { await removeSchedule(this._hass, ed.existing.id); if (this._ed === ed) this._leave(); });
  }

  /**
   * Removes what a failed multi-step write already added: of the schedules not listed before it, only those whose valve,
   * program, weekdays and slots equal one of the `expected` payloads (each matches at most once).
   */
  async _rollback(before, expected) {
    try {
      const left = [...expected];
      for (const c of (await loadSchedules(this._hass)).filter((x) => !before.has(x.id))) {
        const k = left.findIndex((e) => e.valve === c.valve && e.program === c.program && c.days.join() === e.days.join() && slotKey(c.slots) === slotKey(e.slots));
        if (k < 0) continue;
        left.splice(k, 1);
        this._created.delete(c.id);
        await removeSchedule(this._hass, c.id);
      }
    } catch { /* the original error is the one to show */ }
  }

  /** Shows a failed write / service call until the next successful write or for 10 s. */
  _fail(err) {
    this._writeError = err?.message || String(err);
    clearTimeout(this._errTimer);
    this._errTimer = setTimeout(() => { this._writeError = null; this._render(); }, 10000);
    this._render(true);
  }

  async _write(key, fn) {
    this._busy.add(key);
    this._render(true);
    let failed = false;
    try {
      await fn();
      this._writeError = null;
    } catch (err) {
      failed = true;
      this._fail(err);
    }
    this._busy.delete(key);
    await this._load(); // the subscription would too; this makes the result show without waiting for its debounce
    if (failed) this._render(true);
  }

  /** "Aktivní" switch of a row: only the `paused` tag changes. */
  _pause(id, paused) {
    const s = this._schedules.find((x) => x.id === id);
    if (!s || !s.editable || this._busy.has(id)) { this._render(true); return; } // put the checkbox back to the stored state
    return this._write(id, () => saveSchedule(this._hass, { ...s, paused }, s));
  }

  /** A program without schedules gets copies of the valve's Výchozí schedules, tagged with the program. All or nothing. */
  _copyDefault() {
    const prog = this._prog, valve = this._valve;
    const groups = groupByProgram(this._schedules, valve);
    const src = (groups.get('auto') || []).filter((s) => !s.paused && s.editable);
    if (this._busy.has('copy') || !src.length || !isFallbackProgram(groups, prog)) return;
    return this._write('copy', async () => {
      const before = new Set((await loadSchedules(this._hass)).map((x) => x.id));
      const expected = src.map((s) => ({ valve: s.valve, program: prog, days: s.days, slots: s.slots }));
      try {
        for (const s of src) await saveSchedule(this._hass, { ...s, id: undefined, program: prog, paused: false });
      } catch (err) { await this._rollback(before, expected); throw err; } // roll back the copies already added, report the original error
    });
  }

  // ---------- render ----------

  _programs(c = this._circuit()) {
    const st = this._hass?.states ?? {};
    const p = st[`sensor.heating_program_${c.id}`];
    const running = p?.state && p.state !== 'unknown' && p.state !== 'unavailable' ? p.state : 'auto';
    const ids = p?.attributes?.programs?.length ? [...p.attributes.programs] : ['auto'];
    if (!ids.includes('auto')) ids.unshift('auto');
    if (!ids.includes(running)) ids.push(running);
    const names = { auto: 'Výchozí', ...(p?.attributes?.program_names || {}) };
    return { running, list: ids.map((id) => ({ id, name: names[id] || id })) };
  }

  /** `force` = a user action: renders even with the focus inside the card. */
  _render(force = false) {
    if (!this._cfg) return;
    this._sig = this._signature();
    const hass = this._hass, now = new Date();
    const circuit = this._circuit();
    const dark = !!hass?.themes?.darkMode;
    const states = hass?.states ?? {};
    const valve = this._valve;
    const { running, list } = this._programs();
    if (!this._progPicked || !list.some((p) => p.id === this._prog)) { this._prog = running; this._progPicked = false; }
    const prog = this._prog, progName = list.find((p) => p.id === prog).name;
    const title = states[valve]?.attributes?.friendly_name || valve;

    const ns = nowState({ states, circuit: circuit.id, valve, schedules: this._schedules, program: running, now, nValves: circuit.valves.length });
    const toneCss = ns.tone == null ? '' : ns.tone === 'cold' ? 'var(--c-cold)' : ns.tone === 'warm' ? 'var(--c-warm)' : ns.tone === 'accent' ? 'var(--c-accent)' : tempColor(ns.tone, dark);

    const today = dow(now), frac = (now.getHours() * 60 + now.getMinutes()) / 1440;
    const seg = (x) => `<span class="seg" style="flex:${x.end - x.start} 1 0;--c:${tempColor(x.temp, dark)}">${x.end - x.start >= 150 ? `${fmtTemp(x.temp)}°` : ''}</span>`;
    const bar = (s, line) => `<div class="bar" ${line ? 'data-a="open" data-id="' + esc(s.id) + '"' : ''}>${barSegments(s).map(seg).join('')}${line && s.days.includes(today) ? `<i class="nowline" style="left:calc(3px + (100% - 6px) * ${frac.toFixed(4)})"></i>` : ''}</div>`;
    const ruler = '<div class="ruler"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>';
    const row = (s) => {
      const label = esc(daysLabel(s.days));
      const sub = !s.editable ? 'Jen ke čtení (upraveno jinde)' : s.paused ? 'Pozastaveno' : slotsSummary(s);
      const head = s.editable
        ? `<button type="button" class="open" data-a="open" data-id="${esc(s.id)}" aria-label="Upravit rozvrh ${label}"><b>${label}</b><span class="sec">${sub}</span></button>`
        : `<span class="open"><b>${label}</b><span class="sec">${sub}</span></span>`;
      const sw = s.editable
        ? `<label class="sw"><input type="checkbox" role="switch" data-a="pause" data-id="${esc(s.id)}" ${s.paused ? '' : 'checked'} ${this._busy.has(s.id) ? 'disabled' : ''}><span class="knob"></span>Aktivní</label>`
        : '';
      return `<div class="row${s.paused ? ' paused' : ''}${s.editable ? '' : ' ro'}"><div class="top">${head}${sw}</div>${bar(s, s.editable)}${ruler}</div>`;
    };

    const groups = groupByProgram(this._schedules, valve);
    const own = groups.get(prog) || [];
    let main;
    if (!isFallbackProgram(groups, prog)) {
      main = `<div class="rows">${own.map(row).join('') || '<span class="sec">Žádný rozvrh</span>'}</div>
        <button type="button" class="btn wide" data-a="add">${icon('plus')}Přidat dny s jiným rozvrhem</button>`;
    } else {
      const dflt = (groups.get('auto') || []).filter((s) => !s.paused);
      const copyable = dflt.some((s) => s.editable);
      main = `<div class="note">
          <span class="ic">${icon('calendarWeek')}</span>
          <div class="tx"><b>${esc(progName)} používá výchozí rozvrh</b><span class="sec">Hlavice pojede podle Výchozího, dokud tu nebude vlastní rozvrh.</span></div>
        </div>
        <div class="rows dim">${dflt.map((s) => `<div class="row${s.editable ? '' : ' ro'}"><div class="top"><span class="open"><b>${esc(daysLabel(s.days))}</b><span class="sec">Výchozí</span></span></div>${bar(s, false)}</div>`).join('') || '<span class="sec">Výchozí rozvrh nemá žádné úseky.</span>'}</div>
        <button type="button" class="btn primary wide" data-a="copyDefault" ${copyable && !this._busy.has('copy') ? '' : 'disabled'}>${icon('contentCopy')}Vlastní rozvrh pro ${esc(progName.toLowerCase())}</button>`;
    }

    const circuits = this._cfg.circuits;
    const opts = (v) => v.map((x) => `<option value="${esc(x)}"${x === valve ? ' selected' : ''}>${esc(states[x]?.attributes?.friendly_name || x)}</option>`).join('');
    const picker = this._cfg.valve ? '' : `<label class="pill">Hlavice: ${esc(title)}${icon('chevronDown', 18)}<select data-a="valve" aria-label="Hlavice">${
      circuits.length > 1 ? circuits.map((c) => `<optgroup label="${esc(circuitName(hass, c))}">${opts(c.valves)}</optgroup>`).join('') : opts(circuits[0].valves)
    }</select></label>`;

    const err = this._subError || this._writeError || this._loadError;
    const errHtml = err ? `<div class="err">Chyba: ${esc(err)}</div>` : '';
    const wrap = (inner, tone, cls = '') => `<style>${STYLE}</style><ha-card><div class="card${dark ? ' dark' : ''}${cls}" style="--tone:${tone || 'transparent'}">${inner}</div></ha-card>`;
    let html;
    if (this._view === 'editor' && this._ed) html = wrap(this._editorHtml(dark, errHtml), tempColor(this._ed.slots[this._ed.sel].temp, dark));
    else if (this._view === 'picker' && this._pick) {
      const plist = this._pickerPrograms();
      if (!plist.some((p) => p.id === this._pick.program)) this._pick.program = 'auto';
      html = wrap(this._pickerHtml(plist, errHtml), null);
    } else html = wrap(`
      <div class="head"><div class="t"><span class="sec">${esc(circuitName(hass, circuit))}</span><b>${esc(title)}</b></div>${picker}</div>
      ${errHtml}
      <div class="now${ns.muted || ns.tone == null ? ' muted' : ''}" data-kind="${ns.kind}">
        <span class="ic${toneCss ? ' tone' : ''}">${icon(ns.icon)}</span>
        <div class="tx"><b>${esc(ns.text)}</b><span class="sec">${esc(ns.sub)}</span></div>
        ${ns.btn ? `<button type="button" class="btn" data-a="sync">${esc(ns.btn)}</button>` : ''}
        <span class="big">${esc(ns.temp)}${ns.unit ? `<small>${ns.unit}</small>` : ''}</span>
      </div>
      <div class="progs"><span class="label">Program</span><div class="chips">${list.map((p) =>
        `<button type="button" class="chip" data-a="prog" data-id="${esc(p.id)}" aria-pressed="${p.id === prog}">${p.id === running ? '<span class="dot" title="Běží"></span>' : ''}${esc(p.name)}</button>`).join('')}</div></div>
      ${main}
    `, toneCss, ns.muted ? ' muted-bars' : '');
    if (html === this._html) { this._dirty = false; return; }
    // an automatic render never rebuilds the DOM under the user's hands (focused control, open select)
    if (!force && this.shadowRoot.activeElement) {
      this._dirty = true;
      if (this._view === 'editor' && this._ed) this._patchSave(); // the save button must not lag behind a reload
      return;
    }
    this._dirty = false;
    this._html = html;
    // a pressed editor control keeps the focus through the rebuild (keyboard and screen reader users)
    const f = this.shadowRoot.activeElement?.dataset;
    this.shadowRoot.innerHTML = html;
    if (f?.a && f.k != null) [...this.shadowRoot.querySelectorAll('[data-a][data-k]')].find((x) => x.dataset.a === f.a && x.dataset.k === f.k)?.focus();
  }

  /** Updates Uložit and its reason in place (a rebuild would drop the focus). */
  _patchSave() {
    const ed = this._ed, root = this.shadowRoot;
    const btn = root.querySelector('[data-a="save"]'), why = root.querySelector('.why');
    if (!btn || !why) return;
    const block = this._saveBlock(ed);
    btn.disabled = !!(block || ed.stale || this._busy.has('ed'));
    why.textContent = block;
  }

  _editorHtml(dark, errHtml) {
    const ed = this._ed, step = this._cfg.timeStep, states = this._hass?.states ?? {};
    const sl = ed.slots, cur = sl[ed.sel], last = sl.length - 1;
    const names = this._programs().list;
    const valveTitle = ed.valves.map((v) => states[v]?.attributes?.friendly_name || v).join(', ');
    const progName = names.find((p) => p.id === ed.program)?.name || ed.program;
    const block = this._saveBlock(ed), busy = this._busy.has('ed');
    const btn = (a, label, svg, dis = false) => `<button type="button" class="step" data-a="${a}" data-k="" aria-label="${label}" ${dis ? 'disabled' : ''}>${svg}</button>`;
    const stepTile = (label, value, dn, up, canMove) => `<div class="ttile"><div><span class="sec">${label}</span><b>${fmtTime(value)}</b></div>
      <div class="pair">${btn(dn, `${label} o ${step} minut dřív`, icon('minus', 18), !canMove)}${btn(up, `${label} o ${step} minut později`, icon('plus', 18), !canMove)}</div></div>`;
    const carry = sl[0].start > 0 ? `<span class="edseg carry" style="flex:${sl[0].start} 1 0" aria-label="Od půlnoci do ${fmtTime(sl[0].start)} platí rozvrh z předchozího dne">${sl[0].start >= 150 ? 'z předchozího dne' : ''}</span>` : '';
    const segs = carry + sl.map((x, n) => `<button type="button" class="edseg" data-a="sel" data-k="${n}" style="flex:${x.end - x.start} 1 0;--c:${tempColor(x.temp, dark)}" aria-pressed="${n === ed.sel}"
      aria-label="Úsek ${fmtTime(x.start)}–${fmtTime(x.end)}, ${fmtTemp(x.temp)} °C">${x.end - x.start >= 90 ? `${fmtTemp(x.temp)}°` : ''}</button>`).join('');
    const pos = (m) => `calc(5px + (100% - 10px) * ${(m / DAY_END).toFixed(4)})`;
    const handles = sl.filter((x) => x.start > 0).map((x) => `<span class="handle" style="left:${pos(x.start)}"></span>`).join('');
    const hlabels = sl.filter((x) => x.start > 0).map((x) => `<span style="left:${pos(x.start)}">${Math.floor(x.start / 60)}:${pad(x.start % 60)}</span>`).join('');
    const daysHtml = DAYS.map((d) => `<button type="button" class="day" data-a="day" data-k="${d}" aria-pressed="${ed.days.includes(d)}">${DAY_LABELS[d]}</button>`).join('');
    return `<div class="head">
        <button type="button" class="round" data-a="back" data-k="" aria-label="Zpět" ${busy ? 'disabled' : ''}>${icon('chevronLeft')}</button>
        <div class="t"><span class="sec">${esc(valveTitle)} · ${esc(progName)}</span><span class="title">${ed.existing ? 'Upravit rozvrh' : 'Nový rozvrh'}</span></div>
        ${ed.existing ? `<button type="button" class="round" data-a="copy" data-k="" aria-label="Kopírovat tento rozvrh">${icon('contentCopy')}</button>
        <button type="button" class="round" data-a="del" data-k="" aria-label="Smazat rozvrh" ${busy ? 'disabled' : ''}>${icon('deleteOutline')}</button>` : ''}
      </div>
      ${ed.confirm ? `<div class="confirm" role="alertdialog" aria-label="Smazat rozvrh"><span>Smazat rozvrh ${esc(daysLabel(ed.existing?.days ?? ed.days))}?</span>
        <button type="button" class="btn small" data-a="delno" data-k="">Zrušit</button><button type="button" class="btn small danger" data-a="delok" data-k="" ${busy ? 'disabled' : ''}>Smazat</button></div>` : ''}
      ${errHtml}
      ${ed.stale ? '<div class="err stale" role="alert"><span>Rozvrh se mezitím změnil</span><button type="button" class="btn small" data-a="reload" data-k="">Načíst znovu</button></div>' : ''}
      <div class="col"><span class="label">Dny</span><div class="days">${daysHtml}</div></div>
      <div class="col"><span class="label">Průběh dne</span><div class="edbar">${segs}${handles}</div><div class="hlabels">${hlabels}</div></div>
      <div class="panel">
        <div class="l"><span class="label">Úsek ${fmtTime(cur.start)}–${fmtTime(cur.end)}</span>
          ${stepTile('Začátek', cur.start, 'sdn', 'sup', ed.sel > 0 || cur.start > 0)}${stepTile('Konec', cur.end, 'edn', 'eup', ed.sel < last)}
          <div class="grid2">
            <button type="button" class="btn small" data-a="split" data-k="" ${cur.end - cur.start >= 2 * step ? '' : 'disabled'}><span style="color:var(--c-accent);display:inline-flex">${icon('split', 18)}</span>Rozdělit</button>
            <button type="button" class="btn small" data-a="rm" data-k="" ${sl.length > 1 ? '' : 'disabled'}><span style="color:var(--c-accent);display:inline-flex">${icon('deleteOutline', 18)}</span>Smazat</button>
          </div>
        </div>
        <div class="r">${this._dialHtml(cur.temp, dark)}
          <div class="pair">${btn('tdn', 'Snížit teplotu', icon('minus'), cur.temp <= TEMP_MIN)}${btn('tup', 'Zvýšit teplotu', icon('plus'), cur.temp >= TEMP_MAX)}</div>
        </div>
      </div>
      <span class="why" role="status">${esc(block)}</span>
      <div class="grid2">
        <button type="button" class="btn wide" data-a="back" data-k="c" ${busy ? 'disabled' : ''}>Zrušit</button>
        <button type="button" class="btn primary wide" data-a="save" data-k="" ${block || busy || ed.stale ? 'disabled' : ''}>${icon('check')}Uložit</button>
      </div>`;
  }

  /** The Bento dial of the canvas: 270° ring of ticks over 15–25 °C, knob at the value, the value in the face. */
  _dialHtml(temp, dark) {
    const S = 188, ctr = S / 2, kr = ctr - 10, sweep = 270;
    const t = Math.min(25, Math.max(15, temp));
    const f = (t - 15) / 10, sp = (f * sweep).toFixed(1);
    const stops = dark ? STOPS_DARK : STOPS;
    const grad = stops.map((h, n) => `${h} ${(n / (stops.length - 1) * sweep).toFixed(1)}deg`).join(', ');
    const ring = (w, o = 0) => `radial-gradient(closest-side, transparent calc(100% - ${o + w}px), #000 calc(100% - ${o + w - 1}px), #000 calc(100% - ${o}px), transparent calc(100% - ${o}px))`;
    const bg = `conic-gradient(from 225deg, transparent 0deg ${sp}deg, var(--c-border) ${sp}deg ${sweep}deg, transparent ${sweep}deg), conic-gradient(from 225deg, ${grad}, transparent ${sweep}deg)`;
    const mask = (m, w, o) => `-webkit-mask: ${m}, ${ring(w, o)}; -webkit-mask-composite: source-in; mask: ${m}, ${ring(w, o)}; mask-composite: intersect`;
    const ang = (225 + f * sweep) * Math.PI / 180, kx = ctr + kr * Math.sin(ang), ky = ctr - kr * Math.cos(ang), kc = tempColor(t, dark);
    return `<div class="dial" role="img" aria-label="Teplota ${fmtTemp(temp)} °C">
      <div class="ring" style="background:${bg};${mask('repeating-conic-gradient(from 224.5deg, #000 0deg 1deg, transparent 1deg 3.6deg)', 9, 4)}"></div>
      <div class="ring" style="background:${bg};${mask('repeating-conic-gradient(from 224deg, #000 0deg 2deg, transparent 2deg 18deg)', 17, 0)}"></div>
      <div class="face"><span class="sec">Teplota</span><b>${fmtTemp(temp)}<small>°C</small></b></div>
      <span class="knob2" style="left:${(kx - 11).toFixed(1)}px;top:${(ky - 11).toFixed(1)}px;background:radial-gradient(circle, ${kc} 0 3px, var(--c-card) 3.5px);border:2px solid ${kc}"></span>
      <span class="lim" style="left:${Math.round(S * 0.19)}px">15°</span><span class="lim" style="right:${Math.round(S * 0.19)}px">25°</span></div>`;
  }

  _pickerHtml(list, errHtml) {
    const pick = this._pick, states = this._hass?.states ?? {};
    const names = Object.fromEntries(list.map((p) => [p.id, p.name]));
    const seen = new Set(); // a climate listed in two circuits is one tile
    const tile = (v) => {
      if (seen.has(v)) return '';
      seen.add(v);
      const on = pick.valves.includes(v);
      const groups = [...groupByProgram(this._schedules, v)].filter(([, g]) => g.length);
      const n = groups.reduce((a, [, g]) => a + g.length, 0);
      const sub = n ? `${plural(n, 'rozvrh', 'rozvrhy', 'rozvrhů')} · ${groups.map(([id]) => names[id] || id).join(', ')}` : 'bez rozvrhu';
      return `<button type="button" class="tile" data-a="pv" data-k="${esc(v)}" aria-pressed="${on}"><span class="tic">${icon(on ? 'checkCircle' : 'fire', 18)}</span>
        <span class="tx"><b>${esc(states[v]?.attributes?.friendly_name || v)}</b><span class="sec">${esc(sub)}</span></span></button>`;
    };
    const circuits = this._cfg.circuits.map((c) => `<div class="col"><span class="label">${esc(circuitName(this._hass, c))}</span><div class="grid2">${c.valves.map(tile).join('')}</div></div>`).join('');
    const n = pick.valves.length;
    return `<div class="head">
        <button type="button" class="round" data-a="back" data-k="" aria-label="Zpět">${icon('chevronLeft')}</button>
        <div class="t"><span class="sec">Nový rozvrh · krok 1 ze 2</span><span class="title">Pro které hlavice?</span></div>
      </div>
      ${errHtml}
      <label class="tile sel"><span class="tx"><span class="sec">Program</span><b>${esc(names[pick.program] || pick.program)}</b></span>${icon('chevronDown')}
        <select data-a="pickprog" aria-label="Program">${list.map((p) => `<option value="${esc(p.id)}"${p.id === pick.program ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      ${circuits}
      <div class="grid2">
        <button type="button" class="btn wide" data-a="back" data-k="c">Zrušit</button>
        <button type="button" class="btn primary wide" data-a="go" data-k="" ${n ? '' : 'disabled'}>Pokračovat (${n})</button>
      </div>`;
  }
}

if (globalThis.customElements && !customElements.get('heating-schedule-card')) {
  customElements.define('heating-schedule-card', HeatingScheduleCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'heating-schedule-card', name: 'Heating Schedule Card', description: 'Weekly heating schedules of climate valves (scheduler-component storage).' });
  console.info(`%c HEATING-SCHEDULE-CARD %c ${VERSION} `, 'color:#fff;background:#DA4A2C', '');
}

export { HeatingScheduleCard, VERSION };
