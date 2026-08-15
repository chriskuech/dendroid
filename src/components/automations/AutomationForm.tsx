// Add/edit an Automation (lib/types.ts) — a name, which Skill it runs, and
// *when*: a friendly cron picker (frequency + time of day, compiled to a
// cron expression by lib/automations.ts's cronScheduleToExpression) and/or
// a database watch (database/table/row-change kinds, the same fields
// NewThreadForm.tsx's "trigger" kind already collects). Both halves are
// independent toggles rather than a mutually-exclusive choice — "trigger
// info" is cron *and* data, per the Automations tab's brief, so an
// automation can fire on either condition, or both.

import { useEffect, useState } from "react";
import { describeCronSchedule, WEEKDAY_NAMES } from "../../lib/automations";
import { listDatabases, listTables, type DatabaseDto, type TableDto } from "../../lib/db";
import type { Automation, CronFrequency, CronSchedule, Skill, TriggerEvent } from "../../lib/types";
import { CronIcon, TriggerIcon } from "../icons";
import { Button } from "../ui/Button";
import { Segmented } from "../ui/Segmented";

export interface AutomationFormInput {
  name: string;
  skillId: string;
  cron?: CronSchedule;
  data?: { databaseId: string; table: string; events: TriggerEvent[] };
}

interface AutomationFormProps {
  automation: Automation | null;
  skills: Skill[];
  onSave: (input: AutomationFormInput) => void | Promise<void>;
  onCancel: () => void;
}

const FREQUENCIES: { value: CronFrequency; label: string }[] = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
];
const EVENTS: TriggerEvent[] = ["insert", "update", "delete"];
const DEFAULT_CRON: CronSchedule = { frequency: "daily", minute: 0, hour: 9, weekday: 1 };

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function AutomationForm({ automation, skills, onSave, onCancel }: AutomationFormProps) {
  const [name, setName] = useState(automation?.name ?? "");
  const [skillId, setSkillId] = useState(automation?.skillId ?? skills[0]?.id ?? "");
  const [cronEnabled, setCronEnabled] = useState(!!automation?.cron);
  const [cron, setCron] = useState<CronSchedule>(automation?.cron ?? DEFAULT_CRON);
  const [dataEnabled, setDataEnabled] = useState(!!automation?.data);
  const [databases, setDatabases] = useState<DatabaseDto[]>([]);
  const [databaseId, setDatabaseId] = useState(automation?.data?.databaseId ?? "");
  const [tables, setTables] = useState<TableDto[]>([]);
  const [table, setTable] = useState(automation?.data?.table ?? "");
  const [events, setEvents] = useState<TriggerEvent[]>(automation?.data?.events ?? ["insert"]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dataEnabled) return;
    listDatabases()
      .then(setDatabases)
      .catch(() => setDatabases([]));
  }, [dataEnabled]);

  useEffect(() => {
    if (!databaseId) {
      setTables([]);
      setTable("");
      return;
    }
    let cancelled = false;
    listTables(databaseId)
      .then((list) => {
        if (cancelled) return;
        setTables(list);
        setTable((prev) => (list.some((t) => t.name === prev) ? prev : (list[0]?.name ?? "")));
      })
      .catch(() => {
        if (!cancelled) setTables([]);
      });
    return () => {
      cancelled = true;
    };
  }, [databaseId]);

  function toggleEvent(event: TriggerEvent) {
    setEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  const canSave =
    name.trim().length > 0 &&
    skillId.length > 0 &&
    (cronEnabled || dataEnabled) &&
    (!dataEnabled || (databaseId.length > 0 && table.length > 0 && events.length > 0));

  async function handleSave() {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      await onSave({
        name,
        skillId,
        cron: cronEnabled ? cron : undefined,
        data: dataEnabled ? { databaseId, table, events } : undefined,
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="automation-form">
      <div className="automation-form__body">
        <div className="field">
          <span className="field__label">Name</span>
          <input className="field-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="New trigger" autoFocus />
        </div>

        <div className="field">
          <span className="field__label">Skill</span>
          {skills.length === 0 ? (
            <span className="field__hint">No skills yet — create one under Skills first.</span>
          ) : (
            <select className="field-input" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
              <option value="" disabled>
                Select a skill…
              </option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="automation-form__section">
          <label className="automation-form__toggle">
            <input type="checkbox" checked={cronEnabled} onChange={(e) => setCronEnabled(e.target.checked)} />
            <CronIcon size={13} />
            Run on a schedule
          </label>
          {cronEnabled && (
            <div className="automation-form__section-body">
              <Segmented value={cron.frequency} onChange={(frequency) => setCron({ ...cron, frequency })} options={FREQUENCIES} />
              {cron.frequency === "hourly" ? (
                <div className="field">
                  <span className="field__label">Minute past the hour</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    className="field-input"
                    value={cron.minute}
                    onChange={(e) => setCron({ ...cron, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                  />
                </div>
              ) : (
                <div className="field">
                  {cron.frequency === "weekly" && (
                    <select className="field-input" value={cron.weekday} onChange={(e) => setCron({ ...cron, weekday: Number(e.target.value) })}>
                      {WEEKDAY_NAMES.map((d, i) => (
                        <option key={d} value={i}>
                          {d}
                        </option>
                      ))}
                    </select>
                  )}
                  <span className="field__label">Time of day</span>
                  <input
                    type="time"
                    className="field-input"
                    value={`${pad2(cron.hour)}:${pad2(cron.minute)}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      setCron({ ...cron, hour: h || 0, minute: m || 0 });
                    }}
                  />
                </div>
              )}
              <span className="field__hint">{describeCronSchedule(cron)}</span>
            </div>
          )}
        </div>

        <div className="automation-form__section">
          <label className="automation-form__toggle">
            <input type="checkbox" checked={dataEnabled} onChange={(e) => setDataEnabled(e.target.checked)} />
            <TriggerIcon size={13} />
            Run on a database change
          </label>
          {dataEnabled && (
            <div className="automation-form__section-body">
              <div className="field">
                <span className="field__label">Database</span>
                <select className="field-input" value={databaseId} onChange={(e) => setDatabaseId(e.target.value)}>
                  <option value="" disabled>
                    {databases.length === 0 ? "No databases in this workspace" : "Select a database…"}
                  </option>
                  {databases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="field__label">Table</span>
                <select className="field-input" value={table} onChange={(e) => setTable(e.target.value)} disabled={tables.length === 0}>
                  <option value="" disabled>
                    {tables.length === 0 ? "Select a database first" : "Select a table…"}
                  </option>
                  {tables.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <span className="field__label">Fires on</span>
                <div className="thread-form__kinds" role="group" aria-label="Row-change kinds">
                  {EVENTS.map((event) => (
                    <button
                      key={event}
                      type="button"
                      aria-pressed={events.includes(event)}
                      className={`thread-form__kind${events.includes(event) ? " thread-form__kind--active" : ""}`}
                      onClick={() => toggleEvent(event)}
                    >
                      {event}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="thread-form__footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void handleSave()} disabled={!canSave || saving}>
          {saving ? "Saving…" : automation ? "Save" : "Create"}
        </Button>
      </div>
    </div>
  );
}
