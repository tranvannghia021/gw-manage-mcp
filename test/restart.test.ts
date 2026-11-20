import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Manager } from "../src/manager.ts";

const pidfile = join(mkdtempSync(join(tmpdir(), "mcp-")), "pids");
const cfg = (greeting: string) => ({
  name: "fake",
  command: "node",
  args: [new URL("./fake-server.mjs", import.meta.url).pathname],
  env: { PIDFILE: pidfile, GREETING: greeting },
  enabled: true,
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pids = () => readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number);

const m = new Manager();
after(() => m.stopAll());

test("restart kills old process group (incl. grandchild) and applies new env", async () => {
  await m.start(cfg("one"));
  const old = m.status("fake").pid!;
  const [grand1] = pids();
  assert.ok(alive(old) && alive(grand1));
  assert.deepEqual(m.allTools().map((t) => t.name).sort(), ["fake__fail", "fake__hang", "fake__ping", "fake__softfail"]);
  assert.deepEqual(m.allTools("fake").length, 4);
  assert.deepEqual(m.allTools("other"), []);
  assert.match(JSON.stringify(await m.callTool("fake__ping")), /pong one/);

  await m.start(cfg("two"));
  const now = m.status("fake").pid!;
  assert.notEqual(now, old);
  assert.equal(alive(old), false);
  assert.equal(alive(grand1), false);
  assert.match(JSON.stringify(await m.callTool("fake__ping")), /pong two/);
});

test("restart during an in-flight call rejects the call instead of hanging", async () => {
  const call = m.callTool("fake__hang");
  const settled = call.then(() => "ok", () => "rejected");
  await m.start(cfg("three"));
  assert.equal(await settled, "rejected");
});

test("bad command -> crashed, no process left", async () => {
  await m.start({ ...cfg("x"), name: "bad", command: "/nonexistent" });
  assert.equal(m.status("bad").status, "crashed");
});

test("stop -> stopped, pid gone", async () => {
  const pid = m.status("fake").pid!;
  await m.stop("fake");
  assert.equal(m.status("fake").status, "stopped");
  assert.equal(alive(pid), false);
});

test("app dies without cleanup -> next boot reaps the recorded group; reused pid is left alone", async () => {
  const { reap, procStart } = await import("../src/manager.ts");
  const rec: { pid?: number; start?: string | null } = {};
  const first = new Manager();
  first.onPid = (_n, pid, start) => { if (pid) Object.assign(rec, { pid, start }); };
  await first.start({ ...cfg("orphan"), name: "orphan" });
  assert.ok(rec.pid && rec.start, "pid and start time were recorded");
  assert.equal(rec.pid, first.status("orphan").pid);
  const grand = pids().at(-1)!;

  // a recorded pid whose start time differs = pid reuse: must NOT be killed
  await reap(rec.pid, "0");
  assert.ok(alive(rec.pid) && alive(grand));

  // "next boot" has only the DB row: no Manager entry, just pid + start time
  assert.equal(procStart(rec.pid), rec.start);
  await reap(rec.pid, rec.start);
  assert.equal(alive(rec.pid), false);
  assert.equal(alive(grand), false);
  await first.stopAll();
});

test("failed tool calls are counted and surfaced (isError, JSON {error}, thrown), and reset on restart", async () => {
  const mm = new Manager();
  await mm.start({ ...cfg("err"), name: "err" });
  await mm.callTool("err__ping");
  assert.deepEqual([mm.status("err").calls, mm.status("err").errors], [1, 0]);

  await mm.callTool("err__fail");
  await mm.callTool("err__softfail");
  const s = mm.status("err");
  assert.deepEqual([s.calls, s.errors], [3, 2]);
  assert.equal(s.lastError?.tool, "softfail");
  assert.equal(s.lastError?.msg, "session expired");
  assert.ok(s.logs.some((l) => l.includes("[tool error] fail: 403 permission denied")));

  assert.ok(!s.lastOkAt || s.lastOkAt <= s.lastError!.at, "no success after the last failure yet");
  await mm.callTool("err__ping");
  const after = mm.status("err");
  assert.ok(after.lastOkAt! >= after.lastError!.at, "a later success marks the error as history");
  assert.equal(after.errors, 2); // history is kept

  await mm.start({ ...cfg("err2"), name: "err" }); // restart: counters start from zero
  assert.deepEqual([mm.status("err").calls, mm.status("err").errors], [0, 0]);
  await mm.stopAll();
});
