// heating-schedule-card: weekly heating schedules of climate valves, stored by scheduler-component.
// One plain ES module: no build step, no dependencies. Pure functions are exported for `node --test`.
const VERSION = '0.3.0';
const isCal = (v) => typeof v === 'string' && v.startsWith('calendar.');
const CZ_CALENDAR = 'calendar.czechia'; // the calendar the Holiday integration creates for Czechia

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Po', tue: 'Út', wed: 'St', thu: 'Čt', fri: 'Pá', sat: 'So', sun: 'Ne' };
const DAY_ALIASES = { daily: DAYS, workday: DAYS.slice(0, 5), weekend: DAYS.slice(5) };
const DAY_END = 1440;
const RUNNING_MSG = 'Program právě běží — nejdřív přepněte okruh na jiný program';
export const dow = (d) => DAYS[(d.getDay() + 6) % 7];
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// ---------- weeks and holidays (the same rules as heating's `heating_week_parity`, `heating_holidays`) ----------

/**
 * 'odd' | 'even' week of `date`: a strict every-7-days alternation counted from Monday 2025-12-29 (= odd), exactly as
 * heating's `heating_week_parity`. Never ISO week % 2: 2026 has ISO week 53, so after it the names differ from the ISO ones.
 * `swap` (input_boolean.heating_week_swap_<circuit>) inverts it.
 */
export function weekParity(date, swap = false) {
  const n = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(2025, 11, 29)) / 6048e5);
  return (n % 2 === 0) !== !!swap ? 'odd' : 'even';
}

/** ISO week number of `date` (display only, next to the parity). */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // the Thursday of this week
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

/** The circuit's public holidays as a Set of 'YYYY-MM-DD' (heating's `heating_holidays`): only mode `calendar`, the dates of `sensor.heating_programs_<circuit>` attribute `holidays` ([{date, name}]). */
export function holidayDates(states, id) {
  if (states?.[`input_select.heating_holidays_${id}`]?.state !== 'calendar') return new Set();
  const list = states?.[`sensor.heating_programs_${id}`]?.attributes?.holidays;
  return new Set((Array.isArray(list) ? list : []).map((h) => h?.date).filter((d) => typeof d === 'string' && /^\d{4}-\d\d-\d\d$/.test(d)));
}

/** Another schedule's week tag overlaps this one: no tag (every week) overlaps both, `odd` and `even` never. */
const weeksOverlap = (a, b) => !a || !b || a === b;
const otherWeek = (w) => (w === 'odd' ? 'even' : 'odd');
const WEEK_LABEL = { odd: 'lichý', even: 'sudý' };
const weekSuffix = (w) => (w ? ` · ${WEEK_LABEL[w]}` : '');
/** A schedule named for a message: its weekdays and, when tagged, its week (`Po–Pá · lichý`). */
const schedName = (s) => daysLabel(s.days) + weekSuffix(s.week);

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
    for (const v of c.valves) if (typeof v !== 'string' || !v.startsWith('climate.')) fail(`circuits[${i}].valves: "${v}" is not a climate entity`);
    // the first circuit listing a valve wins; later duplicates are dropped
    const valves = [...new Set(c.valves)].filter((v) => !valveCircuit[v]);
    valves.forEach((v) => { valveCircuit[v] = c.id; });
    return { id: c.id, name: c.name || null, valves };
  }).filter((c) => c.valves.length);
  // `valve` may live in a circuit that is only discovered from the states: checked by the card once they are known
  const timeStep = config.time_step ?? 15;
  if (!(timeStep > 0) || 1440 % timeStep) fail('`time_step` must be a positive divisor of 1440');
  return { valve, circuits: out, timeStep, valveCircuit };
}

/** Heating circuits found in the states (`sensor.heating_schedule_<id>` with a `targets` attribute) not yet in `cfg`; a valve stays in one circuit. */
export function discoverCircuits(states, cfg) {
  const out = [], seen = new Set(Object.keys(cfg.valveCircuit));
  for (const [e, st] of Object.entries(states || {})) {
    const m = /^sensor\.heating_schedule_(.+)$/.exec(e), t = st?.attributes?.targets;
    if (!m || !t || typeof t !== 'object' || cfg.circuits.some((c) => c.id === m[1])) continue;
    const valves = Object.keys(t).filter((v) => v.startsWith('climate.') && !seen.has(v));
    valves.forEach((v) => seen.add(v));
    if (valves.length) out.push({ id: m[1], name: null, valves });
  }
  return out;
}

/** `cfg` plus the circuits `discoverCircuits` found. */
export function withDiscovered(cfg, found) {
  if (!found.length) return cfg;
  const valveCircuit = { ...cfg.valveCircuit };
  found.forEach((c) => c.valves.forEach((v) => { valveCircuit[v] = c.id; }));
  return { ...cfg, circuits: [...cfg.circuits, ...found], valveCircuit };
}

/** Circuit title: configured name, else the `title` of binary_sensor.heating_state_<id>, else the id. */
export const circuitName = (hass, c) => c.name || hass?.states?.[`binary_sensor.heating_state_${c.id}`]?.attributes?.title || c.id;

// ---------- schedules: scheduler-component item <-> model ----------

const SUN = /^sun(rise|set)/i;
const toMin = (t) => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };
const hms = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}:00`;

/**
 * One element of the WS `{type: 'scheduler'}` list (scheduler-component's async_get_entity_state) -> the card's model:
 * {id, switch, valve, valves, program, week: null | 'odd' | 'even' (tag `week:*`), days, slots: [{start, end, temp}], paused, editable, raw}.
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
  const week = tags.includes('week:odd') ? 'odd' : tags.includes('week:even') ? 'even' : null; // odd wins, as in heating
  return {
    id: item.schedule_id, switch: item.entity_id, valve: valves.length === 1 ? valves[0] : null, valves,
    program, week, days, slots, paused: tags.includes('paused'), editable, raw: item,
  };
}

/**
 * Model -> body for `scheduler/add` (no id) or `scheduler/edit` (`schedule_id`). `existing` = the parsed schedule being
 * edited. The model owns weekdays, timeslots, tags and repeat_type; name, start_date and end_date are kept from the
 * existing item.
 */
export function toPayload(model, existing = null) {
  const raw = existing?.raw ?? {};
  const kept = (raw.tags ?? []).filter((t) => t !== 'paused' && !t.startsWith('program:') && t !== 'week:odd' && t !== 'week:even');
  const week = model.week === undefined ? existing?.week ?? null : model.week; // a model without `week` keeps the stored one
  const days = DAYS.filter((d) => model.days.includes(d));
  const body = {
    weekdays: days.length === 7 ? ['daily'] : days,
    timeslots: model.slots.map((s, i) => ({
      start: hms(s.start),
      stop: i === model.slots.length - 1 ? '23:59:00' : hms(model.slots[i + 1].start),
      actions: [{ service: 'climate.set_temperature', entity_id: model.valve, service_data: { temperature: s.temp } }],
    })),
    repeat_type: 'repeat',
    tags: [...kept, `program:${model.program}`, ...(week ? [`week:${week}`] : []), ...(model.paused ? ['paused'] : [])],
    name: raw.name ?? null,
  };
  for (const k of ['start_date', 'end_date']) if (raw[k] != null) body[k] = raw[k];
  const id = model.id ?? existing?.id;
  if (id) body.schedule_id = id;
  return body;
}

// ---------- what a valve does ----------

/**
 * Schedules a valve uses on the calendar day `date`: the running program's non-paused schedules that include the weekday
 * and the week parity of that date, else `auto`'s (fallback per day, `isFallback` true then). `ctx.holidays` (Set of
 * 'YYYY-MM-DD'): a holiday counts as `sun`; `ctx.swap` inverts the week parity. Program `vacation` falls back to `auto`'s
 * Sunday every day (as a holiday). A schedule with several valves counts for each of them (heating matches by
 * `entities` membership). Same rules as heating's `heating_slot_temp`.
 */
export function effective(schedules, valve, program, date, ctx = {}) {
  const day = ctx.holidays?.has(ymd(date)) ? 'sun' : dow(date), week = weekParity(date, ctx.swap);
  const on = (d) => schedules.filter((s) => s.valves.includes(valve) && !s.paused && s.days.includes(d) && (!s.week || s.week === week));
  const own = on(day).filter((s) => s.program === program);
  if (own.length || program === 'auto') return { schedules: own, isFallback: false };
  return { schedules: on(program === 'vacation' ? 'sun' : day).filter((s) => s.program === 'auto'), isFallback: true };
}

const slotsOf = (list) => list.flatMap((s) => s.slots.map((x) => ({ ...x, schedule: s }))).sort((a, b) => a.start - b.start);

/**
 * The slot a valve follows at `date` -> {temp, start, end, fromYesterday, boundary, next: {start, temp, days} | null}.
 * Latest start <= now today, else the last slot of yesterday's schedules (the evening slot holds past midnight),
 * else today's own last slot (as heating does). `start` / `end` are minutes of the day the slot belongs to.
 */
export function slotAt(schedules, valve, program, date, ctx = {}) {
  const memo = new Map(); // one effective() per calendar day within a call (today and yesterday are read again below)
  const day = (offset) => memo.get(offset) ?? memo.set(offset, dayOf(offset)).get(offset);
  const dayOf = (offset) => {
    const d = new Date(date); // calendar days, not 24 h: a DST change day is 23 / 25 h long
    d.setDate(d.getDate() + offset);
    const e = effective(schedules, valve, program, d, ctx);
    return slotsOf(e.schedules).map((x) => ({ ...x, schedule: x.schedule, isFallback: e.isFallback }));
  };
  const now = date.getHours() * 60 + date.getMinutes();
  const today = day(0), yesterday = day(-1);
  const cur = today.filter((s) => s.start <= now).pop();
  const pick = cur || yesterday[yesterday.length - 1] || today[today.length - 1];
  if (!pick) return null;
  // boundary = the next slot start (heating re-applies the target there); next = the next slot with another temperature
  let boundary = null, nxt = null;
  for (let k = 0; k <= 14 && !nxt; k++) { // two weeks: odd / even weeks may differ
    for (const x of k ? day(k) : today.filter((y) => y.start > now)) {
      const m = { start: x.start, temp: x.temp, days: k };
      boundary = boundary || m;
      if (x.temp !== pick.temp) { nxt = m; break; }
    }
  }
  return {
    temp: pick.temp, start: pick.start, end: pick.end, fromYesterday: !cur && yesterday.includes(pick),
    schedule: pick.schedule, isFallback: pick.isFallback,
    boundary, next: nxt,
  };
}

/**
 * Where the morning before `sched`'s late first start comes from on its weekdays (over the next two weeks, so both week
 * parities count): the last slot of the previous day's schedules, by the same rules as heating (program, Výchozí
 * fallback, weeks; holidays left out). -> [{schedule, days, start, temp}] for the schedules other than `sched`.
 */
export function carryOrigins(schedules, sched, from = new Date()) {
  if (!(sched.slots[0]?.start > 0)) return [];
  const list = [...schedules.filter((s) => s.id !== sched.id), sched];
  const at = (d, k) => { const x = new Date(d); x.setDate(x.getDate() + k); return x; };
  const out = new Map();
  for (let k = 0; k < 14; k++) {
    const d = at(from, k);
    if (!effective(list, sched.valve, sched.program, d).schedules.includes(sched)) continue;
    const last = slotsOf(effective(list, sched.valve, sched.program, at(d, -1)).schedules).pop();
    if (!last || last.schedule === sched) continue; // no schedule the day before: heating takes today's own last slot
    const o = out.get(last.schedule) ?? out.set(last.schedule, { schedule: last.schedule, days: [], start: last.start, temp: last.temp }).get(last.schedule);
    if (!o.days.includes(dow(d))) o.days.push(dow(d));
  }
  return [...out.values()].map((o) => ({ ...o, days: DAYS.filter((d) => o.days.includes(d)) }));
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

/** Dial point (dx, dy) from the centre -> temperature on the 270° arc of 15–25 °C (0.5 °C); the gap at the bottom snaps to the nearer end. */
export function dialTemp(dx, dy) {
  let rel = ((Math.atan2(dx, -dy) * 180 / Math.PI) - 225 + 720) % 360;
  if (rel > 270) rel = rel > 315 ? 0 : 270;
  return Math.round((15 + rel / 27) * 2) / 2;
}

/** Temperature of slot `i`, rounded to 0.5 and clamped to 5-30 °C. */
export function setTemp(slots, i, t) {
  if (!slots[i] || !Number.isFinite(t)) return slots;
  const temp = Math.min(TEMP_MAX, Math.max(TEMP_MIN, Math.round(t * 2) / 2));
  return slots.map((s, k) => (k === i ? { ...s, temp } : s));
}

/** Of `days`, those another schedule of the same valve and program in an overlapping week already uses (`exceptId` = the one being edited; `week` = the edited one's tag). */
export function daysConflict(schedules, valve, program, days, exceptId = null, week = null) {
  const used = new Set(schedules.filter((s) => s.id !== exceptId && s.program === program && s.valves.includes(valve) && weeksOverlap(s.week, week)).flatMap((s) => s.days));
  return DAYS.filter((d) => days.includes(d) && used.has(d));
}

const plural = (n, one, few, many) => `${n} ${n === 1 ? one : n > 1 && n < 5 ? few : many}`;

// ---------- copy: pure logic ----------

/** The schedules of `source` a copy can start from: editable and not paused (a read-only or paused one is never copied). */
export const copyable = (schedules, source) => schedules.filter((s) => s.editable && !s.paused && s.valve === source);

/**
 * What copying from `source` to `targets` changes -> {add: [model], edit: [model with id], remove: [id], notes: {valve: text}}.
 * Only the source's editable, non-paused single-valve schedules are copied (never a read-only one); only slot starts count,
 * a copy keeps its slots as they are. mode 'valve': every schedule of the `programs`; mode 'one': the `scheduleIds`, into
 * `targetProgram` ('same' = their own program). conflict 'replace': whole valve = the target's schedules of each copied
 * program are removed first; selected = the copied weekdays are taken out of the target's schedules of that program (one left
 * without days is removed); 'fill': a program the target already has is kept / only weekdays it has free are copied.
 * A target's read-only schedule is never removed or edited, its weekdays stay taken and it gets its own note (only editable
 * schedules count as "the target already has"). Weekdays are compared per week: odd and even never collide, a schedule without a
 * week tag collides with both; a copy keeps the source's `week`. With a fixed target program, weekdays two selected schedules both want go to
 * the first one; the note names the rest. A target whose circuit lacks a
 * target program is skipped with a note. `programsByValve` = {valve: [program ids of its circuit]} (absent = no check).
 */
export function planCopy({ schedules, source, mode, programs = [], scheduleIds = [], targetProgram = 'same', targets = [], conflict = 'replace', programsByValve = null, names = {} }) {
  const pn = (p) => names[p] || (p === 'auto' ? 'Normální' : p);
  const list = (ps) => ps.map(pn).join(', ');
  const pool = copyable(schedules, source);
  const progs = new Set(programs), ids = new Set(scheduleIds);
  const jobs = mode === 'valve' ? pool.filter((s) => progs.has(s.program)) : [...ids].map((id) => pool.find((s) => s.id === id)).filter(Boolean);
  const progOf = (s) => (mode === 'one' && targetProgram !== 'same' ? targetProgram : s.program);
  const out = { add: [], edit: [], remove: [], notes: {} };
  const copyOf = (v, p, days, s) => ({ valve: v, program: p, days: DAYS.filter((d) => days.includes(d)), week: s.week, slots: s.slots.map((x) => ({ ...x })), paused: false });
  // occupied (weekday, week) cells: a schedule without a week tag occupies both parities
  const cells = (list) => list.flatMap((s) => s.days.map((d) => ({ d, w: s.week })));
  const at = (list, d, w) => list.find((c) => c.d === d && weeksOverlap(c.w, w));
  for (const v of [...new Set(targets)].filter((x) => x !== source)) {
    if (!jobs.length) { out.notes[v] = 'není co kopírovat.'; continue; }
    const wanted = [...new Set(jobs.map(progOf))];
    const missing = programsByValve ? wanted.filter((p) => !programsByValve[v]?.includes(p)) : [];
    if (missing.length) { out.notes[v] = `přeskočeno, program ${list(missing)} v jeho okruhu není.`; continue; }
    const st = new Map(); // program -> what the target has there + what this copy already claimed
    const state = (p) => {
      if (!st.has(p)) {
        const ex = schedules.filter((s) => s.valves.includes(v) && s.program === p);
        st.set(p, { ex, had: cells(ex.filter((s) => s.editable)), ro: cells(ex.filter((s) => !s.editable)),
          cur: new Map(ex.filter((s) => s.editable).map((s) => [s.id, { s, days: [...s.days], week: s.week }])), claimed: [] }); // claimed: {d, w, by} = the source program that took the weekday
      }
      return st.get(p);
    };
    const added0 = out.add.length;
    const hit = new Set(), kept = new Set(), ro = new Set(), replaced = [], dropped = [];
    if (mode === 'valve') {
      for (const p of wanted) {
        const S = state(p);
        if (S.ex.some((s) => !s.editable)) { ro.add(p); continue; }
        if (S.ex.length) {
          if (conflict === 'fill') { kept.add(p); continue; }
          replaced.push([p, S.ex.length]);
          S.ex.forEach((s) => out.remove.push(s.id));
          S.cur.clear();
        }
        jobs.filter((s) => progOf(s) === p).forEach((s) => out.add.push(copyOf(v, p, s.days, s)));
      }
    } else {
      for (const s of jobs) {
        const p = progOf(s), S = state(p);
        if (s.days.some((d) => at(S.had, d, s.week))) hit.add(p);
        if (s.days.some((d) => at(S.ro, d, s.week))) ro.add(p);
        const taken = s.days.filter((d) => !at(S.ro, d, s.week) && at(S.claimed, d, s.week));
        const by1 = (d) => at(S.claimed, d, s.week).by;
        for (const by of new Set(taken.map(by1))) {
          dropped.push(`${daysLabel(taken.filter((d) => by1(d) === by))}${weekSuffix(s.week)} z programu ${pn(s.program)} se nekopírují, ${pn(by)} je už má`);
        }
        let days = s.days.filter((d) => !at(S.ro, d, s.week) && !at(S.claimed, d, s.week));
        if (conflict === 'fill') days = days.filter((d) => !at(S.had, d, s.week));
        else {
          // the copied weekdays leave the target's schedules of an overlapping week; an every-week schedule hit by a
          // one-parity copy keeps the other parity as a schedule of its own
          for (const e of [...S.cur.values()]) {
            const gone = weeksOverlap(e.week, s.week) ? e.days.filter((d) => days.includes(d)) : [];
            if (!gone.length) continue;
            e.days = e.days.filter((d) => !gone.includes(d));
            if (s.week && !e.week) S.cur.set(`split${S.cur.size}`, { s: e.s, days: gone, week: otherWeek(s.week), fresh: true });
          }
        }
        if (!days.length) continue;
        days.forEach((d) => S.claimed.push({ d, w: s.week, by: s.program }));
        out.add.push(copyOf(v, p, days, s));
      }
    }
    const n = out.add.length - added0; // copies of the source (not the kept-parity remainders below)
    for (const S of st.values()) {
      for (const [id, e] of S.cur) {
        if (e.fresh) { if (e.days.length) out.add.push({ valve: e.s.valve, program: e.s.program, days: DAYS.filter((d) => e.days.includes(d)), week: e.week, slots: e.s.slots.map((x) => ({ ...x })), paused: e.s.paused }) }
        else if (e.days.length === e.s.days.length) continue;
        else if (e.days.length) out.edit.push({ id, valve: e.s.valve, program: e.s.program, days: e.days, week: e.s.week, slots: e.s.slots, paused: e.s.paused });
        else out.remove.push(id);
      }
    }
    // the preview text, as in the canvas (copyNotes)
    const parts = [];
    if (mode === 'valve') {
      if (replaced.length) parts.push(`nahradí ${replaced.map(([p, k]) => `${pn(p)} (${plural(k, 'rozvrh', 'rozvrhy', 'rozvrhů')})`).join(', ')}`);
      if (kept.size) parts.push(`${list([...kept])} nechá být, doplní jen ${list(wanted.filter((p) => !kept.has(p) && !ro.has(p))) || 'nic'}`);
      else if (replaced.length && wanted.length > replaced.length) parts.push('ostatní programy doplní');
    } else if (hit.size) {
      parts.push(conflict === 'replace' ? `v ${list([...hit])} přepíše stejné dny, ostatní dny zůstanou` : n ? `doplní jen dny, které v ${list([...hit])} ještě nemá` : `nic nedoplní, dny už v ${list([...hit])} má`);
    }
    parts.push(...dropped);
    if (ro.size) parts.push(`${list([...ro])} má rozvrh jen ke čtení, ten zůstane`);
    out.notes[v] = parts.length ? `${parts.join('; ')}.` : n ? `dostane ${plural(n, 'rozvrh', 'rozvrhy', 'rozvrhů')}, nic se nepřepíše.` : 'nic se nezkopíruje.';
  }
  return out;
}

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
export function nowState({ states = {}, circuit, valve, schedules, program, now = new Date(), nValves = 0, ctx = {} }) {
  const slot = slotAt(schedules, valve, program, now, ctx);
  const sched = slot?.temp ?? attrOf(states, `sensor.heating_schedule_${circuit}`, 'targets')?.[valve] ?? null;
  const schedTxt = sched == null ? null : `${fmtTemp(sched)} °C`;
  const when = (n) => {
    if (n.days < 2) return n.days ? 'zítra ' : '';
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n.days), d = DAY_LABELS[dow(t)];
    return n.days === 7 ? `příští ${d} ` : n.days > 7 ? `${d} ${t.getDate()}. ${t.getMonth() + 1}. ` : `${d} `;
  };
  const at = (n) => `${when(n)}v ${fmtTime(n.start)}`;
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
    const n = slot?.boundary; // heating re-applies the schedule at every slot start, whatever its temperature
    return tile('manual', 'pencil', `Ručně ${fmtTemp(target)} °C`,
      n ? `Rozvrh to ${at(n)} vrátí na ${fmtTemp(n.temp)} °C` : `Podle rozvrhu by bylo ${fmtTemp(planned)} °C`,
      fmtTemp(target), { tone: target, btn: 'Podle rozvrhu' });
  }
  if (!slot) return tile('none', 'clockOutline', 'Žádný rozvrh', 'Pro tuto hlavici není žádný rozvrh', DASH, { muted: true });
  const by = slot.isFallback ? (program === 'vacation' ? ' podle neděle Normálního' : ' podle Normálního') : '';
  const n = slot.next;
  const names = attrOf(states, `sensor.heating_program_${circuit}`, 'program_names') || {};
  return tile('normal', 'clockOutline',
    `Teď ${fmtTemp(slot.temp)} °C${n ? `, od ${when(n)}${fmtTime(n.start)} ${fmtTemp(n.temp)} °C` : ''}${by}`,
    ctx.holidays?.has(ymd(now)) ? 'Svátek · podle neděle'
      : `Běží program ${names[program] || (program === 'auto' ? 'Normální' : program)}${slot.schedule ? ` · ${daysLabel(slot.schedule.days)}` : ''}`,
    fmtTemp(slot.temp), { tone: slot.temp });
}

const slotKey = (slots) => JSON.stringify(slots.map((x) => [x.start, x.temp]));
const ownKey = (m) => `${m.valve}|${m.program}|${m.week ?? ''}|${m.days.join()}|${slotKey(m.slots)}`;
/** The parts the editor writes (program, week, weekdays, slots) are equal. */
const sameContent = (a, b) => a.program === b.program && (a.week ?? null) === (b.week ?? null) && a.days.join() === b.days.join() && slotKey(a.slots) === slotKey(b.slots);

// ---------- programs: pure logic ----------

/** Program id from a name: ASCII lower-case letters and digits, `_` between them (`Chata u lesa` -> `chata_u_lesa`). */
export const slugify = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Checks a program name against the circuit's programs (`list` = [{id, name}] including Normální): -> {id, error}.
 * `error` is '' when the name can be written: not empty, has a letter or digit, is not Normální / `auto` nor the heating's
 * own ids (`vacation`, `alternating`), and neither
 * its name nor its id is used by another program (`exceptId` = the program being renamed).
 */
export function checkProgram(name, list, exceptId = null) {
  const n = String(name ?? '').trim(), id = slugify(n), low = n.toLocaleLowerCase('cs');
  const error = !n ? 'Zadej název programu'
    : !id ? 'Název musí obsahovat písmeno nebo číslici'
    : ['auto', 'normalni', 'vychozi', 'alternating', 'lichy_sudy_tyden'].includes(id) || (id === 'vacation' && exceptId !== 'vacation') ? 'Tento název je vyhrazený'
    : list.some((p) => p.id !== exceptId && (p.id === id || String(p.name).trim().toLocaleLowerCase('cs') === low)) ? 'Program s tímto názvem už existuje' : '';
  return { id, error };
}

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
  cogOutline: 'M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10M10,22C9.75,22 9.54,21.82 9.5,21.58L9.13,18.93C8.5,18.68 7.96,18.34 7.44,17.94L4.95,18.95C4.73,19.03 4.46,18.95 4.34,18.73L2.34,15.27C2.21,15.05 2.27,14.78 2.46,14.63L4.57,12.97L4.5,12L4.57,11L2.46,9.37C2.27,9.22 2.21,8.95 2.34,8.73L4.34,5.27C4.46,5.05 4.73,4.96 4.95,5.05L7.44,6.05C7.96,5.66 8.5,5.32 9.13,5.07L9.5,2.42C9.54,2.18 9.75,2 10,2H14C14.25,2 14.46,2.18 14.5,2.42L14.87,5.07C15.5,5.32 16.04,5.66 16.56,6.05L19.05,5.05C19.27,4.96 19.54,5.05 19.66,5.27L21.66,8.73C21.79,8.95 21.73,9.22 21.54,9.37L19.43,11L19.5,12L19.43,13L21.54,14.63C21.73,14.78 21.79,15.05 21.66,15.27L19.66,18.73C19.54,18.95 19.27,19.04 19.05,18.95L16.56,17.95C16.04,18.34 15.5,18.68 14.87,18.93L14.5,21.58C14.46,21.82 14.25,22 14,22H10M11.25,4L10.88,6.61C9.68,6.86 8.62,7.5 7.82,8.38L5.4,7.35L4.65,8.65L6.76,10.2C6.38,11.3 6.38,12.5 6.76,13.8L4.65,15.35L5.4,16.65L7.82,15.62C8.62,16.5 9.68,17.14 10.88,17.39L11.25,20H12.75L13.12,17.39C14.32,17.14 15.38,16.5 16.18,15.62L18.6,16.65L19.35,15.35L17.24,13.8C17.62,12.7 17.62,11.5 17.24,10.2L19.35,8.65L18.6,7.35L16.18,8.38C15.38,7.5 14.32,6.86 13.12,6.61L12.75,4H11.25Z',
  close: 'M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z',
  chevronRight: 'M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z',
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
  .lrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .wbadge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 999px; background: var(--c-tint); font-size: 12px; font-weight: 600; }
  .chip.add { padding: 0 14px 0 10px; gap: 4px; border-style: dashed; background: transparent; box-shadow: none; color: var(--c-text2); }
  .lbl { display: inline-flex; align-items: center; gap: 8px; }
  .rep { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--c-border); background: var(--c-card); color: var(--c-text2); font-size: 11px; font-weight: 700; letter-spacing: .3px; }
  .rep.on { background: var(--c-tint); }
  .row.offweek .bar { opacity: .55; filter: saturate(.4); }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; }
  .preset { min-height: 32px; padding: 0 12px; border: 1px solid var(--c-border); border-radius: 999px; background: var(--c-raised); box-shadow: var(--c-raised-shadow); font-size: 12px; font-weight: 600; }
  .prow { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 12px; border-radius: 16px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .prow .tx { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .prow .tx b { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
  .prow .tic { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--c-card); color: var(--c-text2); }
  .prow .tic.base { background: var(--c-accent); color: var(--c-on-accent); }
  .field { display: flex; gap: 8px; }
  .field input { flex: 1; min-width: 0; min-height: 48px; box-sizing: border-box; padding: 0 14px; border-radius: 14px; border: 1px solid var(--c-border); background: var(--c-fill); box-shadow: var(--c-inset); color: var(--c-text); font-size: 15px; font-family: inherit; }
  .field input:focus-visible { outline: 2px solid var(--c-accent); outline-offset: 2px; }
  .field .btn { flex: none; }
  .swrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 16px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .swrow .tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .swrow b { font-size: 15px; font-weight: 600; }
  .switch { flex: none; display: flex; width: 52px; height: 32px; box-sizing: border-box; padding: 3px; align-items: center; border: 0; border-radius: 999px; background: var(--c-border); }
  .switch::after { content: ''; width: 26px; height: 26px; border-radius: 50%; background: var(--c-card); box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform .15s; }
  .switch[aria-checked="true"] { background: var(--c-accent); }
  .switch[aria-checked="true"]::after { transform: translateX(20px); }
  .switch:disabled { opacity: .5; cursor: default; }
  .hols { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: 18px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .hols b { font-size: 13px; font-weight: 600; }
  .hols .h { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
  .hols .h span:first-child { flex: none; font-weight: 600; font-variant-numeric: tabular-nums; }
  .hols .h span:last-child { text-align: right; color: var(--c-text2); }
  .tile.link { width: 100%; box-sizing: border-box; justify-content: space-between; }
  .repro { display: inline-flex; align-items: center; align-self: flex-start; padding: 6px 12px; border-radius: 999px; background: var(--c-fill); box-shadow: var(--c-inset); font-size: 13px; font-weight: 600; color: var(--c-text2); }
  input:disabled { opacity: .5; }
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
  .handle { position: absolute; top: 50%; width: 10px; height: 34px; margin: -17px 0 0 -5px; box-sizing: border-box; border-radius: 999px; background: var(--c-raised); border: 1px solid var(--c-border); box-shadow: var(--c-raised-shadow); z-index: 2; cursor: ew-resize; touch-action: none; }
  .handle::before { content: ''; position: absolute; inset: -14px -12px; }
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
  .dial { cursor: pointer; touch-action: none; user-select: none; }
  .dial svg { position: absolute; inset: 0; }
  .dial .face { left: 50%; top: 50%; width: 117px; height: 117px; margin: -58.5px 0 0 -58.5px; border-radius: 50%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; background: var(--c-card); box-shadow: 0 10px 26px rgba(40,55,80,.16), 0 0 0 1px var(--c-border); }
  .card.dark .dial .face { box-shadow: 0 10px 26px rgba(0,0,0,.6), 0 0 0 1px var(--c-border); }
  .dial .face b { font-size: 34px; font-weight: 700; letter-spacing: -1px; line-height: 1.05; }
  .dial .face small { font-size: 13px; font-weight: 500; margin-left: 2px; }
  .dial .knob2 { width: 22px; height: 22px; box-sizing: border-box; border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,.2); }
  .dial .lim { bottom: 2px; font-size: 11px; font-weight: 600; color: var(--c-text2); }
  .why { font-size: 13px; color: var(--c-warm); }
  .why:empty { display: none; }
  .edseg.carry { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--c) 55%, var(--c-fill)) 0 6px, color-mix(in srgb, var(--c) 35%, var(--c-fill)) 6px 12px); color: var(--c-text2); font-size: 11px; font-weight: 600; box-shadow: none; }
  .carrynote { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; font-size: 13px; color: var(--c-text2); }
  .carrynote span { flex: 1 1 200px; }
  .err.stale { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .err.stale span { flex: 1 1 160px; font-weight: 600; }
  .tile { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 56px; padding: 10px 12px; border: 1px solid transparent; border-radius: 16px; background: var(--c-fill); box-shadow: var(--c-inset); text-align: left; }
  .tile[aria-pressed="true"] { border-color: color-mix(in srgb, var(--c-accent) 45%, var(--c-border)); background: var(--c-tint); box-shadow: var(--c-raised-shadow); }
  .tile .tic { width: 32px; height: 32px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--c-card); color: var(--c-warm); }
  .tabs { display: flex; gap: 4px; padding: 3px; border-radius: 999px; background: var(--c-fill); box-shadow: var(--c-inset); }
  .tab { flex: 1; min-height: 40px; border: 1px solid transparent; border-radius: 999px; background: transparent; font-size: 14px; font-weight: 600; color: var(--c-text2); }
  .tab[aria-pressed="true"] { border-color: var(--c-border); background: var(--c-raised); box-shadow: var(--c-raised-shadow); color: var(--c-text); }
  .tab:disabled, .tile:disabled { opacity: .5; cursor: default; }
  .tile .tic.cal { color: var(--c-text2); }
  .tile.wide { width: 100%; box-sizing: border-box; }
  .tile.wide .tx { flex: 1; gap: 6px; }
  .bar.mini { height: 14px; padding: 0; background: none; box-shadow: none; }
  .note.stack { flex-direction: column; align-items: stretch; gap: 6px; }
  .note.stack .sec { font-size: 13px; line-height: 1.4; }
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
    this._own = []; // content keys of the schedules this instance added and has not seen turned off yet
    this._created = new Map(); // id -> loads that did not list it yet; schedules just created: their switch is turned off once it exists
    this._turning = new Set(); // ids with a turn_off in flight
    this._busy = new Set(); // ids of schedules being written (pause toggle), `copy` while the fallback copy runs
    this._seq = 0;
    this._view = 'week'; // 'week' | 'picker' | 'editor' | 'copy' | 'programs' | 'settings'
    this._pg = null; // programs view state while view is 'programs'
    this._copy = null; // copy view state while view is 'copy'
    this._ed = null; // editor state while view is 'editor'
    this._pick = null; // valve picker state while view is 'picker'
    this.shadowRoot.addEventListener('click', (e) => this._click(e));
    this.shadowRoot.addEventListener('pointerdown', (e) => this._drag(e));
    this.shadowRoot.addEventListener('change', (e) => this._change(e));
    this.shadowRoot.addEventListener('input', (e) => this._input(e));
    this.shadowRoot.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return; const a = e.target.dataset?.a; if (a === 'pg-text' || a === 'pg-rtext') this._progAction(a === 'pg-text' ? 'pg-add' : 'pg-rok', e.target.dataset.k); });
    // a render deferred while something in the card had focus runs once the focus leaves
    this.shadowRoot.addEventListener('focusout', () => setTimeout(() => { if (this._dirty) this._render(); }, 0));
  }

  setConfig(config) {
    this._base = this._cfg = normalizeConfig(config);
    this._found = []; this._refs = null;
    this._valve = this._base.valve || this._base.circuits[0].valves[0];
    this._valvePending = !!this._base.valve && !this._base.valveCircuit[this._base.valve]; // maybe a discovered valve
    if (this._hass) this._discover();
    this._prog = null;
    this._progPicked = false; // until a chip is picked the card shows the running program
    this._view = 'week';
    this._ed = this._pick = this._copy = this._pg = null;
    this._sig = null;
    this._render(true);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._cfg) return; // hass before setConfig
    this._discover();
    this._start();
    // re-render only when what the card reads from the states changed
    if (this._cfg !== this._renderedCfg || this._signature() !== this._sig) this._render();
  }

  /**
   * Base config + the circuits found in the states. Skipped while the `sensor.heating_schedule_*` state objects are the
   * ones of the last scan (same entity count); `_cfg` changes identity only when the found circuits or valves change.
   */
  _discover() {
    if (!this._base) return;
    const st = this._hass.states ?? {}, ids = Object.keys(st);
    if (this._refs && ids.length === this._n && this._refs.every(([id, o]) => st[id] === o)) return;
    this._n = ids.length;
    this._refs = ids.filter((id) => id.startsWith('sensor.heating_schedule_')).map((id) => [id, st[id]]);
    const found = discoverCircuits(st, this._base);
    const same = found.length === this._found.length && found.every((c, i) => c.id === this._found[i].id && c.valves.join() === this._found[i].valves.join());
    if (same) return;
    this._found = found;
    this._cfg = withDiscovered(this._base, found);
    this._fixValve();
  }

  /** The shown valve is gone (its circuit vanished) or the configured `valve` has just been discovered. */
  _fixValve() {
    const vc = this._cfg.valveCircuit, want = this._base.valve;
    let v = this._valve;
    if (this._valvePending && vc[want]) { v = want; this._valvePending = false; }
    if (!vc[v]) v = vc[want] ? want : this._cfg.circuits[0]?.valves[0] ?? null;
    if (v === this._valve) return;
    this._valve = v;
    this._prog = null; this._progPicked = false;
    this._view = 'week'; this._ed = this._pick = this._copy = this._pg = null;
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
    const mine = new Set(this._base.circuits.flatMap((c) => c.valves)); // configured valves; discovered ones only for own adds
    for (const id of [...this._created.keys()]) {
      const s = this._schedules.find((x) => x.id === id);
      if (!s) { // not listed yet: retried on the next load, dropped after a few (rolled back or removed elsewhere)
        if (this._created.get(id) >= 3) this._created.delete(id); else this._created.set(id, this._created.get(id) + 1);
        continue;
      }
      const k = ownKey(s), own = this._own.indexOf(k);
      if (!s.valves.some((v) => mine.has(v)) && own < 0) { this._created.delete(id); continue; } // not ours: never touched
      if (own >= 0) this._own.splice(own, 1);
      if (!this._hass.states?.[s.switch] || this._turning.has(id)) continue; // switch entity not there yet
      this._turning.add(id);
      Promise.resolve(this._hass.callService('switch', 'turn_off', { entity_id: s.switch }))
        .then(() => this._created.delete(id), () => {}) // failed: stays queued for the next load
        .then(() => this._turning.delete(id));
    }
  }

  _allValves() { return [...new Set(this._cfg.circuits.flatMap((c) => c.valves))]; }

  /** Programs every circuit of `valves` has (a valve listed in two circuits needs both). */
  _sharedPrograms(valves) {
    const cs = [...new Set(valves.flatMap((v) => this._cfg.circuits.filter((c) => c.valves.includes(v))))];
    const lists = cs.map((c) => this._programs(c).list);
    return lists[0].filter((p) => lists.every((l) => l.some((q) => q.id === p.id)));
  }

  _pickerPrograms() { return this._sharedPrograms(this._pick.valves.length ? this._pick.valves : [this._valve]); }

  /** Program ids per valve (see `_sharedPrograms`) and all program names; rebuilt only when the config or a program sensor changes. */
  _programInfo() {
    const st = this._hass?.states ?? {};
    const key = this._cfg.circuits.map((c) => st[`sensor.heating_program_${c.id}`]);
    const k = this._pi;
    if (!k || k.cfg !== this._cfg || key.some((x, i) => x !== k.key[i])) {
      this._pi = {
        cfg: this._cfg, key,
        byValve: Object.fromEntries(this._allValves().map((v) => [v, this._sharedPrograms([v]).map((p) => p.id)])),
        names: Object.assign({}, ...this._cfg.circuits.map((c) => Object.fromEntries(this._programs(c).list.map((p) => [p.id, p.name])))),
      };
    }
    return this._pi;
  }

  _circuit() { return this._cfg.circuits.find((c) => c.id === this._cfg.valveCircuit[this._valve]); }

  /** The holidays and the week swap the heating rules use for this circuit: `{holidays: Set, swap}`. */
  _ctx(circuit = this._circuit()) {
    const swap = this._hass?.states?.[`input_boolean.heating_week_swap_${circuit.id}`]?.state === 'on';
    // rebuilt only when the circuit, the mode or the holidays (by reference) change, not on every render
    const st = this._hass?.states, mode = st?.[`input_select.heating_holidays_${circuit.id}`]?.state, dates = st?.[`sensor.heating_programs_${circuit.id}`]?.attributes?.holidays;
    const m = this._holMemo?.get(circuit.id);
    if (m && m.mode === mode && m.dates === dates) return { holidays: m.set, swap };
    const set = holidayDates(st, circuit.id);
    (this._holMemo ??= new Map()).set(circuit.id, { mode, dates, set });
    return { holidays: set, swap };
  }

  /** *Program Lichý/sudý týden* is on for the circuit (the program `alternating` exists; the tags always count). */
  _alternates(circuit = this._circuit()) { return this._hass?.states?.[`input_boolean.heating_week_alternation_${circuit.id}`]?.state === 'on'; }

  /** Everything the week view reads from the states; a change of any of it re-renders. */
  _signature() {
    const st = this._hass?.states ?? {};
    const id = this._circuit()?.id, v = this._valve;
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
      a(`sensor.heating_schedule_${id}`, 'targets'), a(`sensor.heating_schedule_${id}`, 'holidays_next'),
      s(`input_boolean.heating_week_alternation_${id}`), s(`input_boolean.heating_week_swap_${id}`), s(`input_select.heating_holidays_${id}`), s(`input_text.heating_holiday_calendar_${id}`),
      a(`sensor.heating_programs_${id}`, 'programs'), a(`sensor.heating_programs_${id}`, 'holidays'), a(`sensor.heating_programs_${id}`, 'holiday_error'),
      this._view === 'settings' ? Object.keys(st).filter((e) => e.startsWith('calendar.')) : null,
    ]);
  }

  // ---------- actions ----------

  /** Drags a boundary on the day bar (`[data-h]`) or the dial; window listeners, because every move rebuilds the DOM. */
  _drag(e) {
    const ed = this._ed, h = e.target.closest('[data-h]'), dial = !h && e.target.closest('.dial');
    if (this._view !== 'editor' || !ed || e.button || (!h && !dial)) return;
    e.preventDefault();
    const box = (h ? h.parentElement : dial).getBoundingClientRect(), step = this._cfg.timeStep;
    const i = h ? (ed.sel = Number(h.dataset.h)) : ed.sel, x0 = e.clientX, m0 = ed.slots[i].start;
    const move = (ev) => {
      if (h) ed.slots = moveBoundary(ed.slots, i, Math.round((m0 + (ev.clientX - x0) / (box.width - 10) * DAY_END) / step) * step - ed.slots[i].start, step);
      else ed.slots = setTemp(ed.slots, i, dialTemp(ev.clientX - box.left - box.width / 2, ev.clientY - box.top - box.height / 2));
      this._render(true);
    };
    const up = () => {
      for (const [t, fn] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) removeEventListener(t, fn);
      this._dragged = true; setTimeout(() => { this._dragged = false; }); // swallow the click that ends the drag
    };
    for (const [t, fn] of [['pointermove', move], ['pointerup', up], ['pointercancel', up]]) addEventListener(t, fn);
    if (dial) move(e); // a tap on the dial sets the temperature
  }

  _click(e) {
    if (this._dragged) return;
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
    } else if (a === 'copyOpen') this._announceCopy({ valve: this._valve, program: this._prog, schedule: null });
    else if (a === 'cog') { this._view = 'settings'; this._render(true); }
    else if (a === 'addprog') this._openPrograms('week');
    else if (a.startsWith('pg-')) this._progAction(a, el.dataset.k);
    else if (a.startsWith('st-')) this._settingsAction(a, el.dataset.k);
    else if (a.startsWith('cp-')) { if (a !== 'cp-prog') this._copyAction(a, el.dataset.k); }
    else if (a === 'copyDefault') this._copyDefault();
    else this._editorAction(el.dataset);
  }

  _change(e) {
    const el = e.target.closest('[data-a]');
    if (!el) return;
    if (el.dataset.a === 'valve') { this._valve = el.value; this._prog = null; this._progPicked = false; this._render(true); }
    else if (el.dataset.a === 'pause') this._pause(el.dataset.id, !el.checked);
    else if (el.dataset.a === 'pickprog' && this._pick) { this._pick.program = el.value; this._render(true); }
    else if (el.dataset.a === 'cp-prog' && this._copy) { this._copy.targetProgram = el.value; this._render(true); }
    else if (el.dataset.a === 'st-cal') this._settingsAction('st-cal', el.value);
  }

  /** Typing in a programs-view input: kept in the state, the message and buttons are patched in place (a rebuild would drop the focus). */
  _input(e) {
    const a = e.target.dataset?.a, pg = this._pg;
    if (!pg || (a !== 'pg-text' && a !== 'pg-rtext')) return;
    if (a === 'pg-text') pg.text = e.target.value; else pg.rtext = e.target.value;
    this._patchProgram();
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
    this._ed = { existing: s, valves: [s.valve], program: s.program, week: s.week, days: [...s.days], slots: normalizeSlots(s.slots), sel: 0, confirm: false, stale: false };
    this._view = 'editor';
  }

  /** A new schedule: one slot 00:00-24:00 at 20 °C, the weekdays no schedule of these valves and the program uses yet. */
  _newEditor(valves, program) {
    this._ed = { existing: null, valves, program, week: null, days: this._freeDays(valves, program, null), slots: [{ start: 0, end: DAY_END, temp: 20 }], sel: 0, confirm: false, stale: false };
    this._pick = null;
    this._view = 'editor';
  }

  /** The weekdays no schedule of `valves` in `program` and a week overlapping `week` uses yet. */
  _freeDays(valves, program, week) {
    const used = valves.flatMap((v) => daysConflict(this._schedules, v, program, DAYS, null, week));
    return DAYS.filter((d) => !used.includes(d));
  }

  /** Why the editor's copy button is off, or ''. Only a stored, active schedule without unsaved edits is copied. */
  _copyBlock(ed) {
    if (!ed.existing) return '';
    if (ed.existing.paused) return 'Pozastavený rozvrh se nekopíruje';
    const days = DAYS.filter((d) => ed.days.includes(d));
    return sameContent({ program: ed.program, week: ed.week, days, slots: ed.slots }, ed.existing) ? '' : 'Nejdřív uložte rozvrh';
  }

  /** Why Uložit is disabled, or ''. */
  _saveBlock(ed) {
    if (!ed.days.length) return 'Vyber aspoň jeden den';
    const title = (v) => this._hass?.states?.[v]?.attributes?.friendly_name || v;
    const parts = ed.valves.map((v) => [v, daysConflict(this._schedules, v, ed.program, ed.days, ed.existing?.id, ed.week)]).filter(([, d]) => d.length);
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
    if (a === 'day') { ed.days = ed.days.includes(k) ? ed.days.filter((d) => d !== k) : [...ed.days, k]; ed.daysTouched = true; }
    else if (a === 'preset') { ed.days = [...DAY_ALIASES[k]]; ed.daysTouched = true; }
    else if (a === 'wk') {
      ed.week = k === 'all' ? null : k;
      // a new schedule's untouched days follow the chosen week (the days free for that parity)
      if (!ed.existing && !ed.daysTouched) ed.days = this._freeDays(ed.valves, ed.program, ed.week);
    }
    else if (a === 'sel') ed.sel = i;
    else if (a === 'carry') ed.sel = ed.slots.length - 1; // the carried-over morning is the last slot running past midnight
    else if (a === 'carryOpen') {
      // the schedule the morning really comes from on some days: its editor, its evening slot selected
      const s = this._schedules.find((x) => x.id === k);
      if (!s?.editable || this._edChanged(ed)) return;
      this._openExisting(s);
      this._ed.sel = this._ed.slots.length - 1;
    }
    else if (a === 'sdn' || a === 'sup') ed.slots = moveBoundary(ed.slots, ed.sel, a === 'sdn' ? -step : step, step);
    else if (a === 'edn' || a === 'eup') {
      // the last slot of a schedule with a late first start ends the next day, where the first slot starts
      const wrap = ed.sel === ed.slots.length - 1 && ed.slots[0].start > 0;
      ed.slots = moveBoundary(ed.slots, wrap ? 0 : ed.sel + 1, a === 'edn' ? -step : step, step);
    }
    else if (a === 'split') ed.slots = splitSlot(ed.slots, ed.sel, step);
    else if (a === 'rm') { ed.slots = removeSlot(ed.slots, ed.sel); ed.sel = Math.min(ed.sel > 0 ? ed.sel - 1 : 0, ed.slots.length - 1); }
    else if (a === 'tdn' || a === 'tup') ed.slots = setTemp(ed.slots, ed.sel, ed.slots[ed.sel].temp + (a === 'tdn' ? -0.5 : 0.5));
    else if (a === 'copy') return !ed.existing || this._copyBlock(ed) ? undefined : this._announceCopy({ valve: ed.valves[0], program: ed.program, schedule: ed.existing });
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

  /** The editor differs from the stored schedule (a new one always does). */
  _edChanged(ed) {
    const x = ed.existing;
    return !x || ed.week !== x.week || DAYS.filter((d) => ed.days.includes(d)).join() !== x.days.join()
      || JSON.stringify(ed.slots) !== JSON.stringify(x.slots.map(({ start, end, temp }) => ({ start, end, temp })));
  }

  _leave() { this._view = 'week'; this._ed = this._pick = this._copy = this._pg = null; }

  _saveEditor() {
    const ed = this._ed;
    if (!ed || this._busy.has('ed') || ed.stale || this._saveBlock(ed)) return;
    return this._write('ed', async () => {
      const fresh = await loadSchedules(this._hass); // the stored state right now, not the list from a while ago
      if (ed.existing) {
        const cur = fresh.find((x) => x.id === ed.existing.id);
        if (!cur || !cur.editable) throw new Error(`Rozvrh ${schedName(ed.existing)} už neexistuje nebo ho nelze upravovat`);
        if (!sameContent(cur, ed.existing)) { ed.stale = true; return; } // changed elsewhere: ask instead of overwriting
        // days, slots and program come from the editor; paused, name, foreign tags and dates from the stored version
        await this._save({ id: cur.id, valve: cur.valve, program: ed.program, week: ed.week, days: ed.days, slots: ed.slots, paused: cur.paused }, cur);
      } else {
        if (ed.valves.some((v) => daysConflict(fresh, v, ed.program, ed.days, null, ed.week).length)) throw new Error('Některý z dnů už má jiný rozvrh');
        const before = new Set(fresh.map((x) => x.id));
        const days = DAYS.filter((d) => ed.days.includes(d));
        const expected = ed.valves.map((valve) => ({ valve, program: ed.program, week: ed.week, days, slots: ed.slots }));
        try {
          for (const e of expected) await this._save({ ...e, paused: false });
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
        const k = left.findIndex((e) => e.valve === c.valve && e.program === c.program && (e.week ?? null) === c.week && c.days.join() === e.days.join() && slotKey(c.slots) === slotKey(e.slots));
        if (k < 0) continue;
        left.splice(k, 1);
        this._created.delete(c.id);
        await removeSchedule(this._hass, c.id);
      }
    } catch { /* the original error is the one to show */ }
  }

  /** `saveSchedule`; an add is remembered by content so its schedule is recognised as this card's own. */
  async _save(model, existing = null) {
    const k = !(model.id ?? existing?.id) ? ownKey(model) : null;
    if (k) this._own.push(k);
    try { return await saveSchedule(this._hass, model, existing); } catch (e) {
      if (k) this._own.splice(this._own.indexOf(k), 1);
      throw e;
    }
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
    return this._write(id, () => this._save({ ...s, paused }, s));
  }

  /**
   * A program without schedules gets copies of the valve's Normální schedules, tagged with the program; Dovolená gets
   * Normální's Sunday schedules for every day (what it runs by now). All or nothing.
   */
  _copyDefault() {
    const prog = this._prog, valve = this._valve;
    const groups = groupByProgram(this._schedules, valve);
    const src = (groups.get('auto') || []).filter((s) => !s.paused && s.editable && (prog !== 'vacation' || s.days.includes('sun')))
      .map((s) => (prog === 'vacation' ? { ...s, days: [...DAYS] } : s));
    if (this._busy.has('copy') || !src.length || !isFallbackProgram(groups, prog)) return;
    return this._write('copy', async () => {
      const before = new Set((await loadSchedules(this._hass)).map((x) => x.id));
      const expected = src.map((s) => ({ valve: s.valve, program: prog, week: s.week, days: s.days, slots: s.slots }));
      try {
        for (const s of src) await this._save({ ...s, id: undefined, program: prog, paused: false });
      } catch (err) { await this._rollback(before, expected); throw err; } // roll back the copies already added, report the original error
    });
  }

  // ---------- copy ----------

  /** `2 rozvrhy · Normální, Dovolená` / `bez rozvrhu`: what a valve has now. */
  _valveSub(v, names) {
    const groups = [...groupByProgram(this._schedules, v)].filter(([, g]) => g.length);
    const n = groups.reduce((a, [, g]) => a + g.length, 0);
    return n ? `${plural(n, 'rozvrh', 'rozvrhy', 'rozvrhů')} · ${groups.map(([id]) => names[id] || id).join(', ')}` : 'bez rozvrhu';
  }

  /** Schedules of `source` the copy view can copy: editable and not paused. */
  _copyPool(source) { return copyable(this._schedules, source); }

  /** The copy button of the week header and of the editor announce `hsc-copy`; the copy view opens unless a listener calls preventDefault. */
  _announceCopy(detail) {
    const ev = new CustomEvent('hsc-copy', { bubbles: true, composed: true, cancelable: true, detail });
    if (this.dispatchEvent(ev)) this._onCopy(ev);
  }

  _onCopy(e) {
    if (this._view !== 'week' && this._view !== 'editor') return;
    const { valve, schedule } = e.detail || {};
    const source = this._cfg.valveCircuit[valve] ? valve : this._valve;
    const pool = this._copyPool(source);
    const one = schedule && pool.find((s) => s.id === schedule.id); // a schedule from the editor: mode "selected", that one preselected
    this._copy = {
      source, mode: one ? 'one' : 'valve', programs: [...new Set(pool.map((s) => s.program))], ids: one ? [one.id] : [],
      targetProgram: 'same', targets: [], conflict: 'replace', prev: this._view, busy: false, progress: '', errors: {},
    };
    this._view = 'copy';
    this._render(true);
  }

  _copyInput(schedules) {
    const c = this._copy;
    return {
      schedules, source: c.source, mode: c.mode, programs: c.programs, scheduleIds: c.ids, targetProgram: c.targetProgram, targets: c.targets, conflict: c.conflict,
      programsByValve: this._programInfo().byValve, names: this._programInfo().names,
    };
  }

  _copyAction(a, k) {
    const c = this._copy;
    if (this._view !== 'copy' || !c) return;
    if (a === 'cp-back') {
      if (c.busy) return;
      this._view = c.prev;
      this._copy = null;
      return this._render(true);
    }
    if (c.busy) return;
    const toggle = (arr) => (arr.includes(k) ? arr.filter((x) => x !== k) : [...arr, k]);
    if (a === 'cp-mode') c.mode = k;
    else if (a === 'cp-pt') c.programs = toggle(c.programs);
    else if (a === 'cp-row') c.ids = toggle(c.ids);
    else if (a === 'cp-tgt') { const t = toggle(c.targets); c.targets = this._allValves().filter((v) => t.includes(v)); }
    else if (a === 'cp-conf') c.conflict = k;
    else if (a === 'cp-go') return this._runCopy();
    c.errors = {};
    this._render(true);
  }

  /**
   * Runs the plan the user saw (`_copy.shown`, set by the last render). The stored schedules are re-read first and the plan
   * made again from them; when it differs nothing is written. Per valve: the copies are added first, then the replaced
   * schedules are trimmed / removed, so a valve is never left without schedules. A failure puts that valve back as it was
   * (its new copies removed, trimmed ones edited back, removed ones added again from their stored versions) and shows its
   * error; the other valves go through.
   */
  async _runCopy() {
    const c = this._copy, shown = c?.shown;
    if (!c || c.busy || !shown || !(shown.add.length + shown.edit.length + shown.remove.length)) return;
    c.busy = true;
    c.errors = {};
    c.progress = 'Načítám rozvrhy…';
    this._writeError = null;
    this._render(true);
    let failed = false;
    try {
      const fresh = await loadSchedules(this._hass);
      const plan = planCopy(this._copyInput(fresh));
      const same = (p) => JSON.stringify([p.add, p.edit, p.remove]);
      if (same(plan) !== same(shown)) { this._schedules = fresh; throw new Error('Rozvrhy se mezitím změnily, zkontroluj náhled a spusť kopírování znovu'); }
      const before = new Set(fresh.map((x) => x.id));
      const stored = (id) => fresh.find((x) => x.id === id);
      const valves = c.targets.filter((v) => [...plan.add, ...plan.edit].some((m) => m.valve === v) || plan.remove.some((id) => stored(id)?.valve === v));
      for (const [i, v] of valves.entries()) {
        c.progress = `Kopíruji ${i + 1} z ${valves.length} hlavic…`;
        this._render(true);
        const adds = plan.add.filter((m) => m.valve === v), trimmed = [], removed = [];
        try {
          for (const m of adds) await this._save(m);
          for (const m of plan.edit.filter((x) => x.valve === v)) { await this._save(m, stored(m.id)); trimmed.push(stored(m.id)); }
          for (const id of plan.remove.filter((x) => stored(x)?.valve === v)) { await removeSchedule(this._hass, id); removed.push(stored(id)); }
        } catch (err) {
          failed = true;
          c.errors[v] = err?.message || String(err);
          await this._rollback(before, adds); // before the re-adds below: those may look like the copies
          try {
            for (const old of trimmed) await this._save(old, old);
            for (const old of removed) await this._save({ ...old, id: undefined }, { raw: old.raw });
          } catch { /* the original error is the one to show */ }
        }
      }
    } catch (err) {
      failed = true;
      this._fail(err);
    }
    c.busy = false;
    c.progress = '';
    await this._load();
    if (!failed && this._copy === c) {
      if (c.prev === 'editor') { this._view = 'editor'; this._copy = null; } // back to the untouched editor, as Zpět
      else this._leave();
    }
    this._render(true);
  }

  _copyHtml(errHtml) {
    const c = this._copy, st = this._hass?.states ?? {}, dark = !!this._hass?.themes?.darkMode;
    const title = (v) => st[v]?.attributes?.friendly_name || v;
    const names = this._programInfo().names;
    const pool = this._copyPool(c.source);
    const srcCircuit = this._cfg.circuits.find((x) => x.id === this._cfg.valveCircuit[c.source]);
    const ids = [...new Set([...this._programs(srcCircuit).list.map((p) => p.id), ...pool.map((s) => s.program)])];
    const pname = (id) => names[id] || id;
    const plan = planCopy(this._copyInput(this._schedules));
    c.shown = plan; // what the user sees is what Kopírovat runs
    const changes = plan.add.length + plan.edit.length + plan.remove.length;
    const busy = c.busy, dis = busy ? 'disabled' : '';
    const tab = (a, k, label, on) => `<button type="button" class="tab" data-a="${a}" data-k="${k}" aria-pressed="${on}" ${dis}>${label}</button>`;
    const tile = (a, k, on, off, ic, cls, name, sub) => `<button type="button" class="tile${cls}" data-a="${a}" data-k="${esc(k)}" aria-pressed="${on}" ${off || busy ? 'disabled' : ''}>
      <span class="tic${cls.includes('cal') ? ' cal' : ''}">${icon(ic, 18)}</span><span class="tx"><b>${esc(name)}</b>${sub}</span></button>`;
    const sec = (t) => `<span class="sec">${esc(t)}</span>`;

    let which;
    if (!pool.length) which = `<div class="col">${sec('Hlavice nemá žádný rozvrh, který jde kopírovat.')}</div>`;
    else if (c.mode === 'valve') {
      which = `<div class="col"><span class="label">Které programy</span><div class="grid2">${ids.map((p) => {
        const n = pool.filter((s) => s.program === p).length, on = n > 0 && c.programs.includes(p);
        return tile('cp-pt', p, on, !n, on ? 'checkCircle' : 'calendarWeek', ' cal', pname(p), sec(n ? plural(n, 'rozvrh', 'rozvrhy', 'rozvrhů') : p === 'auto' ? 'bez rozvrhu' : 'nemá vlastní · jede podle Normálního'));
      }).join('')}</div></div>`;
    } else {
      const rows = ids.flatMap((p) => pool.filter((s) => s.program === p));
      const bar = (s) => `<span class="bar mini">${barSegments(s).map((x) => `<span class="seg" style="flex:${x.end - x.start} 1 0;--c:${tempColor(x.temp, dark)}"></span>`).join('')}</span>`;
      which = `<div class="col"><span class="label">Které rozvrhy</span>${rows.map((s) => {
        const on = c.ids.includes(s.id);
        return tile('cp-row', s.id, on, false, on ? 'checkCircle' : 'calendarWeek', ' wide cal', `${pname(s.program)} · ${schedName(s)}`, bar(s));
      }).join('')}
        <label class="tile sel"><span class="tx"><span class="sec">Do programu</span><b>${esc(c.targetProgram === 'same' ? 'Stejného jako zdroj' : pname(c.targetProgram))}</b></span>${icon('chevronDown')}
          <select data-a="cp-prog" aria-label="Do programu" ${dis}><option value="same"${c.targetProgram === 'same' ? ' selected' : ''}>Stejného jako zdroj</option>${
            ids.map((p) => `<option value="${esc(p)}"${p === c.targetProgram ? ' selected' : ''}>${esc(pname(p))}</option>`).join('')}</select></label></div>`;
    }

    const seen = new Set([c.source]); // a climate listed in two circuits is one tile
    const circuits = this._cfg.circuits.map((ci) => `<div class="col"><span class="label">Na hlavice · ${esc(circuitName(this._hass, ci))}</span><div class="grid2">${ci.valves.map((v) => {
      if (v === c.source) return tile('cp-tgt', v, false, true, 'contentCopy', ' cal', title(v), sec('zdroj'));
      if (seen.has(v)) return '';
      seen.add(v);
      const on = c.targets.includes(v);
      return tile('cp-tgt', v, on, false, on ? 'checkCircle' : 'fire', '', title(v), sec(this._valveSub(v, names)));
    }).join('')}</div></div>`).join('');

    const notes = c.targets.length ? c.targets.map((v) => `<span class="sec"><b>${esc(title(v))}:</b> ${esc(plan.notes[v] || '')}</span>`).join('') : sec('Vyber aspoň jednu hlavici.');
    const errs = Object.entries(c.errors).map(([v, m]) => `<div class="err">Chyba: ${esc(title(v))}: ${esc(m)}</div>`).join('');
    const go = busy ? c.progress : c.targets.length ? `Kopírovat na ${plural(c.targets.length, 'hlavici', 'hlavice', 'hlavic')}` : 'Kopírovat';
    return `<div class="head">
        <button type="button" class="round" data-a="cp-back" data-k="" aria-label="Zpět" ${dis}>${icon('chevronLeft')}</button>
        <div class="t"><span class="sec">Z hlavice ${esc(title(c.source))}</span><span class="title">Kopírovat rozvrh</span></div>
      </div>
      ${errHtml}${errs}
      <div class="tabs">${tab('cp-mode', 'valve', 'Celá hlavice', c.mode === 'valve')}${tab('cp-mode', 'one', 'Vybrané rozvrhy', c.mode === 'one')}</div>
      ${which}
      ${circuits}
      <div class="col"><span class="label">Když cíl už rozvrh má</span>
        <div class="tabs">${tab('cp-conf', 'replace', 'Nahradit', c.conflict === 'replace')}${tab('cp-conf', 'fill', 'Jen doplnit', c.conflict === 'fill')}</div>
        <div class="note stack" role="status">${notes}</div></div>
      <div class="grid2">
        <button type="button" class="btn wide" data-a="cp-back" data-k="c" ${dis}>Zrušit</button>
        <button type="button" class="btn primary wide" data-a="cp-go" data-k="" ${busy || !changes ? 'disabled' : ''}>${busy ? '' : icon('contentCopy')}${esc(go)}</button>
      </div>`;
  }

  // ---------- programs ----------

  _openPrograms(prev) {
    if (this._view !== 'week' && this._view !== 'settings') return;
    this._pg = { prev, text: '', renaming: null, rtext: '', confirm: null };
    this._view = 'programs';
    this._render(true);
  }

  /**
   * The circuit's programs besides Normální, from `sensor.heating_program_<c>` (`programs` / `program_names`, legacy `program:` tags
   * included: the one list the chips, editor and picker use). Entries keep the fields the stored list has besides id and name.
   */
  _progList(c) {
    const stored = this._hass?.states?.[`sensor.heating_programs_${c.id}`]?.attributes?.programs;
    const byId = new Map((Array.isArray(stored) ? stored : []).filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));
    const view = this._hass?.states?.[`sensor.heating_program_${c.id}`]?.attributes;
    const ids = Array.isArray(view?.programs) ? view.programs : [...byId.keys()];
    return ids.filter((id) => id !== 'auto').map((id) => ({ ...byId.get(id), id, name: String(view?.program_names?.[id] ?? byId.get(id)?.name ?? id) }));
  }

  /** Schedules of program `id` on the circuit's valves: {all, editable, readonly: n, valves: n}. */
  _progStats(c, id) {
    const mine = this._schedules.filter((s) => s.program === id && s.valves.some((v) => c.valves.includes(v)));
    return { n: mine.length, ro: mine.filter((s) => !s.editable).length, valves: new Set(mine.flatMap((s) => s.valves.filter((v) => c.valves.includes(v)))).size };
  }

  _progAction(a, k) {
    const pg = this._pg;
    if (this._view !== 'programs' || !pg) return;
    if (this._busy.has('pg')) return;
    if (a === 'pg-back') { this._view = pg.prev; this._pg = null; }
    else if (a === 'pg-add') return this._addProgram();
    else if (a === 'pg-ren') { pg.renaming = k; pg.rtext = this._progList(this._circuit()).find((p) => p.id === k)?.name ?? ''; pg.confirm = null; }
    else if (a === 'pg-rcancel') { pg.renaming = null; pg.rtext = ''; }
    else if (a === 'pg-rok') return this._renameProgram(k);
    else if (a === 'pg-del') {
      const st = this._progStats(this._circuit(), k);
      pg.confirm = { id: k, n: st.n, ro: st.ro > 0, running: this._programs(this._circuit()).running === k };
      pg.renaming = null;
    }
    else if (a === 'pg-delno') pg.confirm = null;
    else if (a === 'pg-delok') return this._deleteProgram(k);
    this._render(true);
  }

  /** Writes the whole list through the circuit's script and waits until both program sensors show it (see `_programsShown`). */
  async _setPrograms(c, list) {
    list = list.filter((p) => p.id !== 'alternating'); // the heating lists it while its switch is on
    await this._hass.callService('script', `heating_programs_set_${c.id}`, { programs: list });
    const wait = async (n) => { for (let i = 0; i < n; i++) { if (this._programsShown(c, list)) return true; await new Promise((r) => setTimeout(r, 250)); } return this._programsShown(c, list); };
    if (await wait(24)) return;
    // a slow read-back is not a failure: look once more after 5 s before reporting anything
    await new Promise((r) => setTimeout(r, 5000));
    if (this._programsShown(c, list)) return;
    throw Object.assign(new Error('Seznam se možná neuložil — zkontrolujte'), { unsure: true });
  }

  /** `sensor.heating_programs_<c>` holds exactly `list` (id, name) and `sensor.heating_program_<c>` (legacy tags included) lists each with its name. */
  _programsShown(c, list) {
    const st = this._hass?.states ?? {}, key = (l) => JSON.stringify(l.map((p) => [p.id, p.name]));
    const stored = st[`sensor.heating_programs_${c.id}`]?.attributes?.programs, view = st[`sensor.heating_program_${c.id}`]?.attributes;
    return Array.isArray(stored) && key(stored) === key(list) && list.every((p) => view?.programs?.includes(p.id) && (view?.program_names?.[p.id] ?? p.id) === p.name);
  }

  _addProgram() {
    const pg = this._pg, c = this._circuit(), list = this._progList(c);
    const chk = checkProgram(pg.text, [{ id: 'auto', name: 'Normální' }, ...list]);
    if (chk.error) return;
    return this._write('pg', async () => { await this._setPrograms(c, [...list, { id: chk.id, name: pg.text.trim() }]); pg.text = ''; });
  }

  _renameProgram(id) {
    const pg = this._pg, c = this._circuit(), list = this._progList(c);
    const chk = checkProgram(pg.rtext, [{ id: 'auto', name: 'Normální' }, ...list], id);
    if (chk.error) return;
    return this._write('pg', async () => { await this._setPrograms(c, list.map((p) => (p.id === id ? { ...p, name: pg.rtext.trim() } : p))); pg.renaming = null; pg.rtext = ''; });
  }

  /**
   * Deletes a program: the list entry first (waits for the read-back), then its schedules on the circuit's valves. The stored
   * schedules are re-read first; the running program, a read-only schedule, or a count other than the confirmed one stops it
   * before anything is written. A failing removal puts the removed schedules back (added again from their stored versions) and
   * the old list. A read-back that does not show up is reported, never rolled back (the write may still land).
   */
  _deleteProgram(id) {
    const pg = this._pg, c = this._circuit(), list = this._progList(c);
    if (!pg.confirm || pg.confirm.id !== id || pg.confirm.ro || pg.confirm.running) return;
    return this._write('pg', async () => {
      if (this._programs(c).running === id) throw new Error(RUNNING_MSG);
      const fresh = await loadSchedules(this._hass);
      const mine = fresh.filter((s) => s.program === id && s.valves.some((v) => c.valves.includes(v)));
      if (mine.some((s) => !s.editable)) throw new Error('Program má rozvrh jen ke čtení, ten smaž jinde');
      if (mine.length !== pg.confirm.n) { pg.confirm = null; throw new Error('Rozvrhy se mezitím změnily, zkontroluj program a zkus to znovu'); }
      await this._setPrograms(c, list.filter((p) => p.id !== id));
      const removed = [];
      try {
        for (const s of mine) { await removeSchedule(this._hass, s.id); removed.push(s); }
      } catch (err) {
        try {
          for (const old of removed) await this._save({ ...old, id: undefined }, { raw: old.raw });
          await this._setPrograms(c, list);
        } catch { /* the original error is the one to show */ }
        throw err;
      }
      pg.confirm = null;
    });
  }

  /** Updates the validation message and the buttons of the programs view in place (a rebuild would drop the focus). */
  _patchProgram() {
    const pg = this._pg, root = this.shadowRoot, c = this._circuit();
    if (!pg || !c) return;
    const all = [{ id: 'auto', name: 'Normální' }, ...this._progList(c)];
    const busy = this._busy.has('pg');
    const put = (sel, text, dis) => { const el = root.querySelector(sel); if (!el) return; if (text != null) el.textContent = text; if (dis != null) el.disabled = dis; };
    const add = checkProgram(pg.text, all);
    put('[data-pg="msg"]', pg.text.trim() ? add.error : '');
    put('[data-a="pg-add"]', null, !!add.error || busy);
    if (pg.renaming) {
      const ren = checkProgram(pg.rtext, all, pg.renaming);
      put('[data-pg="rmsg"]', pg.rtext.trim() ? ren.error : '');
      put('[data-a="pg-rok"]', null, !!ren.error || busy);
    }
  }

  _programsHtml(circuit, errHtml) {
    const pg = this._pg, busy = this._busy.has('pg'), dis = busy ? 'disabled' : '';
    const list = this._progList(circuit), all = [{ id: 'auto', name: 'Normální' }, ...list];
    const add = checkProgram(pg.text, all);
    const rows = all.map((p) => {
      const st = this._progStats(circuit, p.id);
      const sub = p.id === 'auto' ? `${plural(st.valves, 'hlavice', 'hlavice', 'hlavic')} · ${plural(st.n, 'rozvrh', 'rozvrhy', 'rozvrhů')} · platí, když program nemá svůj`
        : st.n ? `${plural(st.valves, 'hlavice', 'hlavice', 'hlavic')} · ${plural(st.n, 'rozvrh', 'rozvrhy', 'rozvrhů')}` : p.id === 'vacation' ? 'zatím bez rozvrhů · jede podle neděle Normálního'
        : p.id === 'alternating' ? 'zatím bez rozvrhů · rozvrhy pro lichý a sudý týden, jinak Normální' : 'zatím bez rozvrhů · jede podle Normálního';
      const ic = `<span class="tic${p.id === 'auto' ? ' base' : ''}">${icon('calendarWeek', 18)}</span>`;
      if (p.id === 'auto') return `<div class="prow">${ic}<div class="tx"><b>${esc(p.name)}</b><span class="sec">${esc(sub)}</span></div></div>`;
      if (pg.renaming === p.id) {
        const ren = checkProgram(pg.rtext, all, p.id);
        return `<div class="prow" style="flex-wrap:wrap">${ic}<div class="field" style="flex:1 1 180px"><input type="text" data-a="pg-rtext" data-k="${esc(p.id)}" value="${esc(pg.rtext)}" aria-label="Nový název programu ${esc(p.name)}" ${dis}></div>
          <button type="button" class="round" data-a="pg-rok" data-k="${esc(p.id)}" aria-label="Uložit název" ${ren.error || busy ? 'disabled' : ''}>${icon('check')}</button>
          <button type="button" class="round" data-a="pg-rcancel" data-k="" aria-label="Zrušit přejmenování" ${dis}>${icon('close')}</button>
          <span class="why" data-pg="rmsg" role="status" style="flex:1 1 100%">${esc(pg.rtext.trim() ? ren.error : '')}</span></div>`;
      }
      // Dovolená can be renamed, not deleted; Lichý/sudý týden is switched in the settings
      if (p.id === 'alternating') return `<div class="prow">${ic}<div class="tx"><b>${esc(p.name)}</b><span class="sec">${esc(sub)}</span></div></div>`;
      return `<div class="prow">${ic}<div class="tx"><b>${esc(p.name)}</b><span class="sec">${esc(sub)}</span></div>
        <button type="button" class="round" data-a="pg-ren" data-k="${esc(p.id)}" aria-label="Přejmenovat ${esc(p.name)}" ${dis}>${icon('pencil', 18)}</button>
        ${p.id === 'vacation' ? '' : `<button type="button" class="round" data-a="pg-del" data-k="${esc(p.id)}" aria-label="Smazat program ${esc(p.name)}" ${dis}>${icon('deleteOutline', 18)}</button>`}</div>`;
    }).join('');
    const cf = pg.confirm, cfName = cf && all.find((p) => p.id === cf.id)?.name;
    const confirm = cf ? `<div class="confirm" role="alertdialog" aria-label="Smazat program"><span>${cf.running ? RUNNING_MSG : cf.ro ? `Program ${esc(cfName)} má rozvrh jen ke čtení, ten smaž jinde.`
        : `Smazat program ${esc(cfName)}${cf.n ? ` a jeho ${plural(cf.n, 'rozvrh', 'rozvrhy', 'rozvrhů')}` : ''}?`}</span>
        <button type="button" class="btn small" data-a="pg-delno" data-k="" ${dis}>${cf.ro || cf.running ? 'Zavřít' : 'Zrušit'}</button>${cf.ro || cf.running ? '' : `<button type="button" class="btn small danger" data-a="pg-delok" data-k="${esc(cf.id)}" ${dis}>Smazat</button>`}</div>` : '';
    return `<div class="head">
        <button type="button" class="round" data-a="pg-back" data-k="" aria-label="Zpět" ${dis}>${icon('chevronLeft')}</button>
        <div class="t"><span class="sec">Okruh ${esc(circuitName(this._hass, circuit))}</span><span class="title">Programy</span></div>
      </div>
      ${errHtml}${confirm}
      <div class="col">${rows}</div>
      <div class="col"><label class="label" for="newprog">Nový program</label>
        <div class="field"><input id="newprog" type="text" data-a="pg-text" data-k="" value="${esc(pg.text)}" placeholder="Název, např. Chata" autocomplete="off" ${dis}>
          <button type="button" class="btn primary" data-a="pg-add" data-k="" ${add.error || busy ? 'disabled' : ''}>${icon('plus')}Přidat</button></div>
        <span class="why" data-pg="msg" role="status">${esc(pg.text.trim() ? add.error : '')}</span>
        <span class="sec">Nový program jede podle Normálního, dokud mu nepřidáte vlastní rozvrh. Program se vybírá v kartě okruhu.</span></div>`;
  }

  // ---------- settings ----------

  _settingsAction(a, k) {
    const c = this._circuit(), id = c.id;
    const call = (domain, service, data) => Promise.resolve().then(() => this._hass.callService(domain, service, data)).catch((err) => this._fail(err));
    if (a === 'st-back') { this._view = 'week'; this._render(true); }
    else if (a === 'st-prog') this._openPrograms('settings');
    else if (a === 'st-alt') call('input_boolean', 'toggle', { entity_id: `input_boolean.heating_week_alternation_${id}` });
    else if (a === 'st-swap') call('input_boolean', 'toggle', { entity_id: `input_boolean.heating_week_swap_${id}` });
    else if (a === 'st-hol') {
      const st = this._hass.states, calEnt = `input_text.heating_holiday_calendar_${id}`, cur = st[calEnt]?.state;
      if (k === (st[`input_select.heating_holidays_${id}`]?.state === 'calendar' ? 'calendar' : 'none')) return; // the active tab
      const select = () => call('input_select', 'select_option', { entity_id: `input_select.heating_holidays_${id}`, option: k });
      if (k !== 'calendar') return select();
      if (!st[calEnt]) return this._fail(new Error('Heating je starší, aktualizujte ho'));
      // the only place that writes the default: nothing valid stored and the Holiday integration's Czechia calendar exists
      if (isCal(cur) || !st[CZ_CALENDAR]) return select();
      Promise.resolve().then(() => this._hass.callService('input_text', 'set_value', { entity_id: calEnt, value: CZ_CALENDAR })).then(select).catch((err) => this._fail(err));
    }
    else if (a === 'st-cal') call('input_text', 'set_value', { entity_id: `input_text.heating_holiday_calendar_${id}`, value: k });
  }

  _settingsHtml(circuit, errHtml) {
    const id = circuit.id, st = this._hass?.states ?? {}, att = (e, a) => st[e]?.attributes?.[a];
    const alt = this._alternates(circuit), mode = st[`input_select.heating_holidays_${id}`]?.state === 'calendar' ? 'calendar' : 'none'; // anything else shows as Žádné
    const stored = st[`input_text.heating_holiday_calendar_${id}`]?.state, cal = isCal(stored) ? stored : ''; // only the stored value is shown
    const swap = this._ctx(circuit).swap, parity = weekParity(new Date(), swap);
    const calendars = Object.keys(st).filter((e) => e.startsWith('calendar.'));
    if (cal && !calendars.includes(cal)) calendars.unshift(cal);
    const next = (Array.isArray(att(`sensor.heating_schedule_${id}`, 'holidays_next')) ? att(`sensor.heating_schedule_${id}`, 'holidays_next') : []);
    const fmt = (iso) => `${Number(String(iso).slice(8, 10))}. ${Number(String(iso).slice(5, 7))}.`;
    const tab = (k, label) => `<button type="button" class="tab" data-a="st-hol" data-k="${k}" aria-pressed="${mode === k}" ${st[`input_select.heating_holidays_${id}`] ? '' : 'disabled'}>${label}</button>`;
    const err = mode === 'calendar' ? att(`sensor.heating_programs_${id}`, 'holiday_error') : null;
    const picker = mode === 'calendar' ? `<label class="tile sel"><span class="tx"><span class="sec">Kalendář svátků (integrace Holiday)</span><b>${esc(cal || 'Vyberte kalendář')}</b></span>${icon('chevronDown')}
        <select data-a="st-cal" aria-label="Kalendář svátků"><option value=""${cal ? '' : ' selected'}>Vyberte kalendář</option>${calendars.map((e) => `<option value="${esc(e)}"${e === cal ? ' selected' : ''}>${esc(e)}</option>`).join('')}</select></label>
        <span class="sec">Svátky přidáte integrací Holiday (Nastavení › Zařízení a služby › Přidat integraci › Holiday, země Česko).</span>${err ? `<div class="err">Kalendář se nenačetl: ${esc(err)}</div>` : ''}` : '';
    const hols = mode === 'none' ? '' : `<div class="hols"><b>Nejbližší svátky · ve svátek se jede podle rozvrhu neděle</b>${next.length
      ? next.map((h) => `<div class="h"><span>${esc(fmt(h.date))}</span><span>${esc(h.name ?? '')}</span></div>`).join('') : '<span class="sec">Žádné nadcházející svátky.</span>'}</div>`;
    const progs = this._progList(circuit);
    return `<div class="head">
        <button type="button" class="round" data-a="st-back" data-k="" aria-label="Zpět">${icon('chevronLeft')}</button>
        <div class="t"><span class="sec">Okruh ${esc(circuitName(this._hass, circuit))}</span><span class="title">Nastavení rozvrhů</span></div>
      </div>
      ${errHtml}
      <div class="swrow"><div class="tx"><b>Program Lichý/sudý týden</b><span class="sec">Jeho rozvrhy platí každý týden, jen v lichém, nebo jen v sudém; co nemá, jede podle Normálního. Teď je ${WEEK_LABEL[parity]} týden.</span></div>
        <button type="button" class="switch" role="switch" aria-checked="${alt}" aria-label="Program Lichý/sudý týden" data-a="st-alt" data-k="" ${st[`input_boolean.heating_week_alternation_${id}`] ? '' : 'disabled'}></button></div>
      ${alt || swap ? `<div class="swrow"><div class="tx"><b>Prohodit lichý a sudý týden</b><span class="sec">Týdny se střídají po 7 dnech. Nesedí-li s kalendářem (po roce s 53 týdny), prohoďte je.</span></div>
        <button type="button" class="switch" role="switch" aria-checked="${swap}" aria-label="Prohodit lichý a sudý týden" data-a="st-swap" data-k="" ${st[`input_boolean.heating_week_swap_${id}`] ? '' : 'disabled'}></button></div>` : ''}
      <div class="col"><span class="label">Státní svátky</span>
        <div class="tabs">${tab('none', 'Žádné')}${tab('calendar', 'Z kalendáře')}</div>
        ${picker}${hols}</div>
      <button type="button" class="tile link" data-a="st-prog" data-k=""><span class="tx"><b>Programy</b><span class="sec">${esc(['Normální', ...progs.map((p) => p.name)].join(', '))}</span></span>${icon('chevronRight')}</button>`;
  }

  // ---------- render ----------

  _programs(c = this._circuit()) {
    const st = this._hass?.states ?? {};
    const p = st[`sensor.heating_program_${c.id}`];
    const running = p?.state && p.state !== 'unknown' && p.state !== 'unavailable' ? p.state : 'auto';
    const ids = p?.attributes?.programs?.length ? [...p.attributes.programs] : ['auto'];
    if (!ids.includes('auto')) ids.unshift('auto');
    if (!ids.includes(running)) ids.push(running);
    const names = { auto: 'Normální', ...(p?.attributes?.program_names || {}) };
    return { running, list: ids.map((id) => ({ id, name: names[id] || id })) };
  }

  /** `force` = a user action: renders even with the focus inside the card. */
  _render(force = false) {
    if (!this._cfg) return;
    this._sig = this._signature();
    this._renderedCfg = this._cfg;
    const hass = this._hass, now = new Date();
    const circuit = this._circuit();
    const dark = !!hass?.themes?.darkMode;
    const states = hass?.states ?? {};
    const valve = this._valve;
    // no valve to show, or the configured `valve` is in no circuit (configured or discovered) once the states are known
    const bad = !circuit ? 'Žádná hlavice' : hass && this._base.valve && !this._cfg.valveCircuit[this._base.valve] ? `heating-schedule-card: valve "${this._base.valve}" is not in any circuit` : null;
    if (bad) {
      const html = `<style>${STYLE}</style><ha-card><div class="card${dark ? ' dark' : ''}"><div class="err">${esc(bad)}</div></div></ha-card>`;
      if (html !== this._html) { this.shadowRoot.innerHTML = html; this._html = html; }
      return;
    }
    const { running, list } = this._programs();
    if (!this._progPicked || !list.some((p) => p.id === this._prog)) { this._prog = running; this._progPicked = false; }
    const prog = this._prog, progName = list.find((p) => p.id === prog).name;
    const title = states[valve]?.attributes?.friendly_name || valve;

    const ctx = this._ctx(circuit), alt = this._alternates(circuit), parity = weekParity(now, ctx.swap);
    const ns = nowState({ states, circuit: circuit.id, valve, schedules: this._schedules, program: running, now, nValves: circuit.valves.length, ctx });
    const toneCss = ns.tone == null ? '' : ns.tone === 'cold' ? 'var(--c-cold)' : ns.tone === 'warm' ? 'var(--c-warm)' : ns.tone === 'accent' ? 'var(--c-accent)' : tempColor(ns.tone, dark);

    const today = ctx.holidays.has(ymd(now)) ? 'sun' : dow(now), frac = (now.getHours() * 60 + now.getMinutes()) / 1440;
    const seg = (x) => `<span class="seg" style="flex:${x.end - x.start} 1 0;--c:${tempColor(x.temp, dark)}">${x.end - x.start >= 150 ? `${fmtTemp(x.temp)}°` : ''}</span>`;
    const bar = (s, line) => `<div class="bar" ${line ? 'data-a="open" data-id="' + esc(s.id) + '"' : ''}>${barSegments(s).map(seg).join('')}${line && s.days.includes(today) && (!s.week || s.week === parity) ? `<i class="nowline" style="left:calc(3px + (100% - 6px) * ${frac.toFixed(4)})"></i>` : ''}</div>`;
    const ruler = '<div class="ruler"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>';
    // a schedule tagged for one parity shows its pill; one not valid this week is dimmed (the tags count whatever the switch says)
    const pill = (s) => (s.week ? `<span class="rep${s.week === 'odd' ? ' on' : ''}">${WEEK_LABEL[s.week]}</span>` : '');
    const row = (s) => {
      const label = esc(daysLabel(s.days));
      const sub = !s.editable ? 'Jen ke čtení (upraveno jinde)' : s.paused ? 'Pozastaveno' : slotsSummary(s);
      const head = s.editable
        ? `<button type="button" class="open" data-a="open" data-id="${esc(s.id)}" aria-label="Upravit rozvrh ${label}"><span class="lbl"><b>${label}</b>${pill(s)}</span><span class="sec">${sub}</span></button>`
        : `<span class="open"><span class="lbl"><b>${label}</b>${pill(s)}</span><span class="sec">${sub}</span></span>`;
      const sw = s.editable
        ? `<label class="sw"><input type="checkbox" role="switch" data-a="pause" data-id="${esc(s.id)}" ${s.paused ? '' : 'checked'} ${this._busy.has(s.id) ? 'disabled' : ''}><span class="knob"></span>Aktivní</label>`
        : '';
      return `<div class="row${s.paused ? ' paused' : ''}${s.editable ? '' : ' ro'}${s.week && s.week !== parity ? ' offweek' : ''}"><div class="top">${head}${sw}</div>${bar(s, s.editable)}${ruler}</div>`;
    };

    const groups = groupByProgram(this._schedules, valve);
    const own = groups.get(prog) || [];
    let main;
    if (!isFallbackProgram(groups, prog)) {
      main = `<div class="rows">${own.map(row).join('') || '<span class="sec">Žádný rozvrh</span>'}</div>
        <button type="button" class="btn wide" data-a="add">${icon('plus')}Přidat dny s jiným rozvrhem</button>`;
    } else {
      const dflt = (groups.get('auto') || []).filter((s) => !s.paused && (prog !== 'vacation' || s.days.includes('sun')));
      const copyable = dflt.some((s) => s.editable);
      main = `<div class="note">
          <span class="ic">${icon('calendarWeek')}</span>
          <div class="tx"><b>${esc(progName)} používá ${prog === 'vacation' ? 'neděli Normálního' : 'Normální rozvrh'}</b><span class="sec">Hlavice pojede ${prog === 'vacation' ? 'každý den podle neděle Normálního' : 'podle Normálního'}, dokud tu nebude vlastní rozvrh.</span></div>
        </div>
        <div class="rows dim">${dflt.map((s) => `<div class="row${s.editable ? '' : ' ro'}"><div class="top"><span class="open"><span class="lbl"><b>${esc(prog === 'vacation' ? 'Každý den' : daysLabel(s.days))}</b>${pill(s)}</span><span class="sec">${prog === 'vacation' ? 'neděle Normálního' : 'Normální'}</span></span></div>${bar(s, false)}</div>`).join('') || '<span class="sec">Normální rozvrh nemá žádné úseky.</span>'}</div>
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
    else if (this._view === 'copy' && this._copy) html = wrap(this._copyHtml(errHtml), null);
    else if (this._view === 'programs' && this._pg) html = wrap(this._programsHtml(circuit, errHtml), null);
    else if (this._view === 'settings') html = wrap(this._settingsHtml(circuit, errHtml), null);
    else if (this._view === 'picker' && this._pick) {
      const plist = this._pickerPrograms();
      if (!plist.some((p) => p.id === this._pick.program)) this._pick.program = 'auto';
      html = wrap(this._pickerHtml(plist, errHtml), null);
    } else html = wrap(`
      <div class="head"><div class="t"><span class="sec">${esc(circuitName(hass, circuit))}</span><b>${esc(title)}</b></div>${picker}<button type="button" class="round" data-a="cog" aria-label="Nastavení rozvrhů okruhu">${icon('cogOutline')}</button>${this._allValves().length > 1 ? `<button type="button" class="round" data-a="copyOpen" aria-label="Kopírovat na jiné hlavice">${icon('contentCopy')}</button>` : ''}</div>
      ${errHtml}
      <div class="now${ns.muted || ns.tone == null ? ' muted' : ''}" data-kind="${ns.kind}">
        <span class="ic${toneCss ? ' tone' : ''}">${icon(ns.icon)}</span>
        <div class="tx"><b>${esc(ns.text)}</b><span class="sec">${esc(ns.sub)}</span></div>
        ${ns.btn ? `<button type="button" class="btn" data-a="sync">${esc(ns.btn)}</button>` : ''}
        <span class="big">${esc(ns.temp)}${ns.unit ? `<small>${ns.unit}</small>` : ''}</span>
      </div>
      <div class="progs"><div class="lrow"><span class="label">Program</span>${alt ? `<span class="wbadge">${icon('calendarWeek', 14)}${WEEK_LABEL[parity]} týden (${isoWeek(now)}.)</span>` : ''}</div><div class="chips">${list.map((p) =>
        `<button type="button" class="chip" data-a="prog" data-id="${esc(p.id)}" aria-pressed="${p.id === prog}">${p.id === running ? '<span class="dot" title="Běží"></span>' : ''}${esc(p.name)}</button>`).join('')}<button type="button" class="chip add" data-a="addprog" aria-label="Nový program">${icon('plus', 18)}Program</button></div></div>
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

  /** Under the selected last slot: the weekdays whose morning another schedule's evening holds, with a way to edit that one. */
  _carryNotes(ed) {
    const model = { ...ed.existing, id: ed.existing?.id ?? null, valve: ed.valves[0], valves: ed.valves, program: ed.program, week: ed.week, days: ed.days, slots: ed.slots, paused: false };
    const changed = this._edChanged(ed);
    return carryOrigins(this._schedules, model).map((o) => `<div class="carrynote"><span>${daysLabel(o.days)} ráno pokračuje rozvrh <b>${esc(schedName(o.schedule))}</b>${o.schedule.program !== ed.program ? ' (Výchozí)' : ''} od ${fmtTime(o.start)}, ${fmtTemp(o.temp)} °C.${changed && o.schedule.editable ? ' Nejdřív uložte nebo zrušte změny.' : ''}</span>
      ${o.schedule.editable ? `<button type="button" class="btn small" data-a="carryOpen" data-k="${esc(o.schedule.id)}" ${changed ? 'disabled' : ''}>Upravit ${esc(schedName(o.schedule))}</button>` : ''}</div>`).join('');
  }

  _editorHtml(dark, errHtml) {
    const ed = this._ed, step = this._cfg.timeStep, states = this._hass?.states ?? {};
    const sl = ed.slots, cur = sl[ed.sel], last = sl.length - 1;
    const wrap = ed.sel === last && sl[0].start > 0, end = wrap ? sl[0].start : cur.end; // the last slot runs on until the first start the next day
    const names = this._programs().list;
    const valveTitle = ed.valves.map((v) => states[v]?.attributes?.friendly_name || v).join(', ');
    const progName = names.find((p) => p.id === ed.program)?.name || ed.program;
    const block = this._saveBlock(ed), busy = this._busy.has('ed'), noCopy = this._copyBlock(ed);
    const btn = (a, label, svg, dis = false) => `<button type="button" class="step" data-a="${a}" data-k="" aria-label="${label}" ${dis ? 'disabled' : ''}>${svg}</button>`;
    const stepTile = (label, value, dn, up, canMove) => `<div class="ttile"><div><span class="sec">${label}</span><b>${fmtTime(value)}</b></div>
      <div class="pair">${btn(dn, `${label} o ${step} minut dřív`, icon('minus', 18), !canMove)}${btn(up, `${label} o ${step} minut později`, icon('plus', 18), !canMove)}</div></div>`;
    const carry = sl[0].start > 0 ? `<button type="button" class="edseg carry" data-a="carry" data-k="" style="flex:${sl[0].start} 1 0;--c:${tempColor(sl[last].temp, dark)}" aria-pressed="${wrap}" aria-label="Od půlnoci do ${fmtTime(sl[0].start)} pokračuje úsek od ${fmtTime(sl[last].start)} z předchozího dne, ${fmtTemp(sl[last].temp)} °C">${sl[0].start >= 150 ? 'z předchozího dne' : ''}</button>` : '';
    const segs = carry + sl.map((x, n) => `<button type="button" class="edseg" data-a="sel" data-k="${n}" style="flex:${x.end - x.start} 1 0;--c:${tempColor(x.temp, dark)}" aria-pressed="${n === ed.sel}"
      aria-label="Úsek ${fmtTime(x.start)}–${fmtTime(x.end)}, ${fmtTemp(x.temp)} °C">${x.end - x.start >= 90 ? `${fmtTemp(x.temp)}°` : ''}</button>`).join('');
    const pos = (m) => `calc(5px + (100% - 10px) * ${(m / DAY_END).toFixed(4)})`;
    const handles = sl.map((x, n) => (x.start > 0 ? `<span class="handle" data-h="${n}" style="left:${pos(x.start)}" title="Přetáhněte"></span>` : '')).join('');
    const hlabels = sl.filter((x) => x.start > 0).map((x) => `<span style="left:${pos(x.start)}">${Math.floor(x.start / 60)}:${pad(x.start % 60)}</span>`).join('');
    // Opakování: tabs in the program Lichý/sudý týden while it is on, and for a schedule that already has a week tag (to change
    // or drop it); elsewhere none
    const repeatHtml = (ed.program === 'alternating' && this._alternates()) || (ed.existing?.week && ed.program !== 'alternating')
      ? `<div class="col"><span class="label">Opakování</span><div class="tabs">${[['all', 'Každý týden'], ['odd', 'Lichý'], ['even', 'Sudý']].map(([k, n]) =>
        `<button type="button" class="tab" data-a="wk" data-k="${k}" aria-pressed="${(ed.week ?? 'all') === k}">${n}</button>`).join('')}</div></div>`
      : ed.week ? `<div class="col"><span class="label">Opakování</span><span class="repro">${WEEK_LABEL[ed.week]} týden</span></div>` : '';
    const daysHtml = DAYS.map((d) => `<button type="button" class="day" data-a="day" data-k="${d}" aria-pressed="${ed.days.includes(d)}">${DAY_LABELS[d]}</button>`).join('');
    return `<div class="head">
        <button type="button" class="round" data-a="back" data-k="" aria-label="Zpět" ${busy ? 'disabled' : ''}>${icon('chevronLeft')}</button>
        <div class="t"><span class="sec">${esc(valveTitle)} · ${esc(progName)}</span><span class="title">${ed.existing ? 'Upravit rozvrh' : 'Nový rozvrh'}</span></div>
        ${ed.existing ? `<button type="button" class="round" data-a="copy" data-k="" aria-label="${esc(noCopy || 'Kopírovat tento rozvrh')}" title="${esc(noCopy)}" ${noCopy ? 'disabled' : ''}>${icon('contentCopy')}</button>
        <button type="button" class="round" data-a="del" data-k="" aria-label="Smazat rozvrh" ${busy ? 'disabled' : ''}>${icon('deleteOutline')}</button>` : ''}
      </div>
      ${noCopy ? `<span class="sec" role="status">${esc(noCopy)}</span>` : ''}
      ${ed.confirm ? `<div class="confirm" role="alertdialog" aria-label="Smazat rozvrh"><span>Smazat rozvrh ${esc(ed.existing ? schedName(ed.existing) : daysLabel(ed.days))}?</span>
        <button type="button" class="btn small" data-a="delno" data-k="">Zrušit</button><button type="button" class="btn small danger" data-a="delok" data-k="" ${busy ? 'disabled' : ''}>Smazat</button></div>` : ''}
      ${errHtml}
      ${ed.stale ? `<div class="err stale" role="alert"><span>Rozvrh${ed.existing?.week ? ` ${esc(schedName(ed.existing))}` : ''} se mezitím změnil</span><button type="button" class="btn small" data-a="reload" data-k="">Načíst znovu</button></div>` : ''}
      <div class="col"><div class="lrow"><span class="label">Dny</span><div class="presets">${[['workday', 'Pracovní dny'], ['weekend', 'Víkend'], ['daily', 'Každý den']].map(([k, n]) =>
        `<button type="button" class="preset" data-a="preset" data-k="${k}">${n}</button>`).join('')}</div></div><div class="days">${daysHtml}</div></div>
      ${repeatHtml}
      <div class="col"><span class="label">Průběh dne</span><div class="edbar">${segs}${handles}</div><div class="hlabels">${hlabels}</div>${wrap ? this._carryNotes(ed) : ''}</div>
      <div class="panel">
        <div class="l"><span class="label">Úsek ${fmtTime(cur.start)}–${fmtTime(end)}${wrap ? ' další den' : ''}</span>
          ${stepTile('Začátek', cur.start, 'sdn', 'sup', ed.sel > 0 || cur.start > 0)}${stepTile(wrap ? 'Konec další den' : 'Konec', end, 'edn', 'eup', ed.sel < last || wrap)}
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
    const f = (t - 15) / 10, sp = f * sweep + 0.01;
    // ticks as SVG lines (anti-aliased): minor every 3.6°, major every 18°, coloured up to the value
    const tick = (rel, r1, r2, w) => {
      const a = (225 + rel) * Math.PI / 180, sx = Math.sin(a), cy = -Math.cos(a), c = rel <= sp ? tempColor(15 + rel / 27, dark) : 'var(--c-border)';
      return `<line x1="${(ctr + r1 * sx).toFixed(2)}" y1="${(ctr + r1 * cy).toFixed(2)}" x2="${(ctr + r2 * sx).toFixed(2)}" y2="${(ctr + r2 * cy).toFixed(2)}" stroke="${c}" stroke-width="${w}"/>`;
    };
    let ticks = '';
    for (let k = 0; k <= 75; k++) ticks += k % 5 ? tick(k * 3.6, 81, 89, 1.5) : tick(k * 3.6, 77, 93, 3);
    const ang = (225 + f * sweep) * Math.PI / 180, kx = ctr + kr * Math.sin(ang), ky = ctr - kr * Math.cos(ang), kc = tempColor(t, dark);
    return `<div class="dial" role="img" aria-label="Teplota ${fmtTemp(temp)} °C">
      <svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" stroke-linecap="round" aria-hidden="true">${ticks}</svg>
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
      const sub = this._valveSub(v, names);
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
