# Heating Schedule Card

A Home Assistant card for the weekly heating schedules of climate valves, written in Czech. Schedules are stored by [scheduler-component](https://github.com/nielsfaber/scheduler-component) (no own integration); the card reads them, shows what a valve does now and writes `scheduler/add`, `edit` and `remove`. The schedule switches stay **off**: the heating automation alone decides what a valve gets.

Status: week view (now tile with the heating automation's state, program chips, temperature-coloured 24 h bars, fallback to Výchozí, per-schedule "Aktivní" pause) and the schedule editor (weekdays, 24 h bar with selectable slots, start / end ± `time_step`, split / delete slot, Bento dial ±0.5 °C, save / cancel / delete; a card without `valve` first asks for which valves a new schedule is made) on the data layer (v0.1.0 in progress). Copy to other valves (whole valve or selected schedules, Nahradit / Jen doplnit, with a per-valve preview).

## Installation

Not in HACS. Copy [`dist/heating-schedule-card.js`](dist/heating-schedule-card.js) to `config/www/`, then add a dashboard resource:

Settings → Dashboards → ⋮ → Resources → Add resource → URL `/local/heating-schedule-card.js?v=0.1.0`, type **JavaScript module** → reload the browser. Change `?v=` after copying a new version.

## Configuration

```yaml
type: custom:heating-schedule-card
valve: climate.obyvak_valve        # optional: preselected valve; none = the first valve of the first circuit
circuits:                           # required: circuits whose valves can be picked / copied to
  - id: heating_circuit_1           # heating instance = area id; entity ids derive from it
    name: Přízemí                   # optional: default = attribute `title` of binary_sensor.heating_state_<id>, else the id
    valves: [climate.obyvak_valve, climate.kuchyn_valve]
time_step: 15                       # optional, minutes (divisor of 1440)
```

## Schedule model

One scheduler-component schedule = one program's weekdays with timeslots covering 00:00–24:00, one `climate.set_temperature` action each.

- program = tag `program:<id>`; none = `auto` (Výchozí)
- paused = tag `paused`
- a schedule the card cannot represent (not `repeat`, conditions, other actions, several valves, sun times, gaps) is shown read-only and never written

A day uses the running program's non-paused schedules, else `auto`'s (same rules as the heating feature's `heating_slot_temp`).

## Events

- `hsc-edit` (`detail: {valve, program, schedule | null}`, cancelable): a row or "Přidat dny s jiným rozvrhem" was tapped; the card opens its editor unless a listener calls `preventDefault()`.
- `hsc-copy` (`detail: {valve, program, schedule | null}`, cancelable): the copy button of the week header or of the editor; the card opens its copy view unless a listener calls `preventDefault()`. Only editable, non-paused schedules of the source valve are copied; a target valve whose circuit lacks the target program is skipped.

## Tests

Pure functions are exported from the module:

```sh
node --test tests/*.test.mjs
```

Browser check with a fake `hass` (`tests/fixtures/schedules.json` = real items from the dev HA). Screenshots of the canvas layouts with a fixed clock: `tests/dom.html?shot=week|fallback|states|editor|picker|copy-valve|copy-one` (`&dark=1`, `&w=390`).

```sh
python3 -m http.server 8765 &
"Google Chrome" --headless=new --virtual-time-budget=5000 --dump-dom http://localhost:8765/tests/dom.html | grep RESULT
```

## Licence

MIT
