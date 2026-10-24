import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { APP_TIME_ZONE, dateToISO, formatDate, formatDateTime, shiftDate } from "../datetime.mjs";

test("Central African dates change at 22:00 UTC, including year and leap-day boundaries", () => {
  assert.equal(APP_TIME_ZONE, "Africa/Lubumbashi");
  for (const [instant, expected] of [
    ["2026-10-23T21:59:59Z", "2026-10-23"],
    ["2026-10-23T22:00:00Z", "2026-10-24"],
    ["2026-12-31T22:30:00Z", "2027-01-01"],
    ["2028-02-28T22:00:00Z", "2028-02-29"],
  ]) {
    assert.equal(dateToISO(new Date(instant)), expected);
  }
});

test("dates and times are French and use the 24-hour CAT clock", () => {
  assert.equal(formatDate("2026-10-23", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  }), "vendredi 23 octobre 2026");
  assert.equal(formatDateTime("2026-10-23T22:30:00Z"), "24/10/2026 00:30");
  assert.equal(formatDateTime("2026-07-23T12:30:00Z", {
    hour: "2-digit", minute: "2-digit",
  }), "14:30");
});

test("calendar arithmetic keeps civil dates unchanged across DST and month boundaries", () => {
  assert.equal(shiftDate("2026-03-28", 1), "2026-03-29");
  assert.equal(shiftDate("2026-10-25", -1), "2026-10-24");
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDate("2028-01-31", 1, "month"), "2028-02-29");
  assert.equal(shiftDate("2026-01-31", 1, "month"), "2026-02-28");
  assert.equal(shiftDate("2026-01-31", -1, "month"), "2025-12-31");
});

test("server and browser helpers ignore the host timezone", () => {
  const moduleUrl = new URL("../datetime.mjs", import.meta.url).href;
  for (const timezone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { dateToISO, formatDateTime, shiftDate } from ${JSON.stringify(moduleUrl)};
      console.log(JSON.stringify([
        dateToISO(new Date("2026-12-31T22:30:00Z")),
        formatDateTime("2026-12-31T22:30:00Z"),
        shiftDate("2026-03-28", 1)
      ]));
    `], { env: { ...process.env, TZ: timezone }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["2027-01-01", "01/01/2027 00:30", "2026-03-29"]);
  }
});
