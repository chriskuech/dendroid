// Round-trip and formatting coverage for the cron-schedule compile step —
// the one piece of lib/automations.ts's own logic (as opposed to thin
// invoke() wrappers) worth testing directly. `src-tauri/src/automation.rs`'s
// own `cron_matches` tests cover the engine's matching half against
// exactly the expressions `cronScheduleToExpression` can produce.

import { describe, expect, it } from "vitest";
import { cronExpressionToSchedule, cronScheduleToExpression, describeCronSchedule } from "./automations";
import type { CronSchedule } from "./types";

describe("cronScheduleToExpression", () => {
  it("compiles an hourly schedule to a minute-only field", () => {
    expect(cronScheduleToExpression({ frequency: "hourly", minute: 15, hour: 9, weekday: 1 })).toBe("15 * * * *");
  });

  it("compiles a daily schedule to minute + hour", () => {
    expect(cronScheduleToExpression({ frequency: "daily", minute: 30, hour: 9, weekday: 1 })).toBe("30 9 * * *");
  });

  it("compiles a weekly schedule to minute + hour + weekday", () => {
    expect(cronScheduleToExpression({ frequency: "weekly", minute: 0, hour: 17, weekday: 5 })).toBe("0 17 * * 5");
  });
});

describe("cronExpressionToSchedule", () => {
  it("round-trips every frequency cronScheduleToExpression can produce", () => {
    const schedules: CronSchedule[] = [
      { frequency: "hourly", minute: 15, hour: 0, weekday: 1 },
      { frequency: "daily", minute: 30, hour: 9, weekday: 1 },
      { frequency: "weekly", minute: 0, hour: 17, weekday: 5 },
    ];
    for (const schedule of schedules) {
      expect(cronExpressionToSchedule(cronScheduleToExpression(schedule))).toEqual(schedule);
    }
  });

  it("falls back to a sane default for a malformed expression", () => {
    expect(cronExpressionToSchedule("not a cron")).toEqual({ frequency: "daily", minute: 0, hour: 9, weekday: 1 });
  });
});

describe("describeCronSchedule", () => {
  it("describes each frequency in a human-readable form", () => {
    expect(describeCronSchedule({ frequency: "hourly", minute: 5, hour: 0, weekday: 1 })).toBe("Hourly at :05");
    expect(describeCronSchedule({ frequency: "daily", minute: 0, hour: 9, weekday: 1 })).toBe("Daily at 09:00");
    expect(describeCronSchedule({ frequency: "weekly", minute: 30, hour: 17, weekday: 5 })).toBe("Weekly on Friday at 17:30");
  });
});
