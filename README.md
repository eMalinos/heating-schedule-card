# Heating Schedule Card

A Home Assistant card for the weekly heating schedules of climate valves, written in Czech. Schedules are stored by [scheduler-component](https://github.com/nielsfaber/scheduler-component) (no own integration); the card reads them, shows what a valve does now and writes `scheduler/add`, `edit` and `remove`. The schedule switches stay **off**: the heating automation alone decides what a valve gets.

Status: data layer and pure logic with a minimal list (v0.1.0 in progress). Week view, editor, copy and automation states follow.

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

## Tests

Pure functions are exported from the module:

```sh
node --test tests/*.test.mjs
```

Browser check with a fake `hass` (`tests/fixtures/schedules.json` = real items from the dev HA):

```sh
python3 -m http.server 8765 &
"Google Chrome" --headless=new --virtual-time-budget=5000 --dump-dom http://localhost:8765/tests/dom.html | grep RESULT
```

## Licence

MIT
