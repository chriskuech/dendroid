// The "+" flow from ThreadList.tsx — picks a thread kind, then collects
// whatever that kind needs before it's worth saving (see lib/types.ts's
// `ChatThread`): "human" just needs a title, "cron" a schedule + skill,
// "trigger" a database/table/event-kinds + skill. One form rather than
// three separate dialogs so switching kinds mid-fill (before committing to
// one) doesn't lose the title already typed.

import { useEffect, useState } from "react";
import type { DatabaseDto, TableDto } from "../../adapters/db";
import { useDb } from "../../adapters/db/context";
import type { ThreadKind, TriggerEvent } from "../../lib/types";
import type { NewThreadInput } from "./threads";
import { Button } from "../../ui/Button";
import { SidePanelHeader } from "../../ui/SidePanelHeader";
import { THREAD_KIND_LABEL, ThreadKindIcon } from "./ThreadKindIcon";

const KINDS: ThreadKind[] = ["human", "cron", "trigger"];
const EVENTS: TriggerEvent[] = ["insert", "update", "delete"];

interface NewThreadFormProps {
  onCreate: (input: NewThreadInput) => void;
  onCancel: () => void;
}

export function NewThreadForm({ onCreate, onCancel }: NewThreadFormProps) {
  const db = useDb();
  const [kind, setKind] = useState<ThreadKind>("human");
  const [title, setTitle] = useState("");
  const [schedule, setSchedule] = useState("0 9 * * *");
  const [cronSkill, setCronSkill] = useState("");
  const [databases, setDatabases] = useState<DatabaseDto[]>([]);
  const [databaseId, setDatabaseId] = useState("");
  const [tables, setTables] = useState<TableDto[]>([]);
  const [table, setTable] = useState("");
  const [events, setEvents] = useState<TriggerEvent[]>(["insert"]);
  const [triggerSkill, setTriggerSkill] = useState("");

  // Databases only matter for "trigger" threads — fetched lazily once that
  // kind is picked rather than every time the form opens, mirroring
  // DatabaseListView's own lazy "only load what's about to be shown" habit.
  useEffect(() => {
    if (kind !== "trigger") return;
    db.listDatabases()
      .then(setDatabases)
      .catch(() => setDatabases([]));
  }, [kind, db]);

  useEffect(() => {
    if (!databaseId) {
      setTables([]);
      setTable("");
      return;
    }
    let cancelled = false;
    db.listTables(databaseId)
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
  }, [databaseId, db]);

  function toggleEvent(event: TriggerEvent) {
    setEvents((prev) => (prev.includes(event) ? prev.filter((e) => e !== event) : [...prev, event]));
  }

  const canCreate =
    kind === "human"
      ? true
      : kind === "cron"
        ? schedule.trim().length > 0 && cronSkill.trim().length > 0
        : databaseId.length > 0 && table.length > 0 && events.length > 0 && triggerSkill.trim().length > 0;

  function handleCreate() {
    if (!canCreate) return;
    if (kind === "human") {
      onCreate({ kind, title });
    } else if (kind === "cron") {
      onCreate({ kind, title, cron: { schedule: schedule.trim(), skill: cronSkill.trim() } });
    } else {
      onCreate({ kind, title, trigger: { databaseId, table, events, skill: triggerSkill.trim() } });
    }
  }

  return (
    <div className="thread-form">
      <SidePanelHeader label="New thread" onClose={onCancel} closeLabel="Cancel" />

      <div className="thread-form__body">
        <div className="field">
          <span className="field__label">Kind</span>
          <div className="thread-form__kinds" role="radiogroup">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                className={`thread-form__kind${kind === k ? " thread-form__kind--active" : ""}`}
                onClick={() => setKind(k)}
              >
                <ThreadKindIcon kind={k} size={14} />
                {THREAD_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field__label">Title</span>
          <input
            className="field-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={kind === "human" ? "New thread" : kind === "cron" ? "New scheduled thread" : "New trigger thread"}
          />
        </div>

        {kind === "cron" && (
          <>
            <div className="field">
              <span className="field__label">Schedule</span>
              <input
                className="field-input"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="0 9 * * *"
              />
              <span className="field__hint">Standard 5-field cron (minute hour day-of-month month day-of-week)</span>
            </div>
            <div className="field">
              <span className="field__label">Skill</span>
              <textarea
                className="field-input thread-form__skill"
                value={cronSkill}
                onChange={(e) => setCronSkill(e.target.value)}
                placeholder="What should the agent do each time this runs?"
                rows={3}
              />
            </div>
          </>
        )}

        {kind === "trigger" && (
          <>
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
            <div className="field">
              <span className="field__label">Skill</span>
              <textarea
                className="field-input thread-form__skill"
                value={triggerSkill}
                onChange={(e) => setTriggerSkill(e.target.value)}
                placeholder="What should the agent do with the changed row?"
                rows={3}
              />
              <span className="field__hint">The triggering row's change is appended to this as event JSON.</span>
            </div>
          </>
        )}
      </div>

      <div className="thread-form__footer">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={handleCreate} disabled={!canCreate}>
          Create
        </Button>
      </div>
    </div>
  );
}
