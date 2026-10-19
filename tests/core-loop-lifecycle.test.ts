import assert from 'node:assert/strict';
import { CoreLoopScheduler, type LoopState, type CycleContext } from '../server/services/coreLoopScheduler';
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let state: LoopState = { isRunning: false, intervalMs: 60000, epoch: 0 };
  let now = 0, lease = false, emergency = false, readFailures = 0;
  let cycles = 0, ones = 0;
  const errors: unknown[] = [];
  let job = async (_ctx: CycleContext): Promise<any> => { cycles++; return { complete: true }; };
  const timers = new Map<any, { fn: () => void; delay: number }>();
  const scheduler = new CoreLoopScheduler({
    read: async () => { if (readFailures-- > 0) throw new Error('Controlled database outage'); return { ...state }; },
    control: async running => { state.epoch += !running || !state.isRunning ? 1 : 0; state.isRunning = running; if (!running) state.nextExecutionAt = null; return { ...state }; },
    update: async (patch, epoch) => { if (epoch === undefined || epoch === state.epoch) Object.assign(state, patch); },
    lease: async () => { if (lease) return null; lease = true; return async () => { lease = false; }; },
    emergency: async () => emergency,
    cycle: ctx => job(ctx), one: async () => { ones++; return 1; }, notify: () => {}, error: error => errors.push(error), now: () => now,
    timer: ((fn: () => void, delay: number) => { const key = { unref() {} }; timers.set(key, { fn, delay }); return key; }) as any,
    clear: ((key: any) => { timers.delete(key); }) as any,
  });
  const fire = async () => { assert.equal(timers.size, 1); const [key, timer] = [...timers][0]; timers.delete(key); now += timer.delay; timer.fn(); await flush(); };
  return { scheduler, timers, fire, errors, state, counts: () => ({ cycles, ones }), setReadFailures: (n: number) => { readFailures = n; }, setJob: (fn: typeof job) => { job = fn; }, setEmergency: (value: boolean) => { emergency = value; }, setLease: (value: boolean) => { lease = value; } };
}
let count = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); console.log(`PASS ${name}`); count++; }
async function main() {
  await test('Repeated Start creates one tracked immediate discovery tick, then configured interval', async () => {
    const f = fixture(); await Promise.all([f.scheduler.start(), f.scheduler.start(), f.scheduler.start()]);
    assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 0);
    await f.fire(); assert.equal(f.counts().cycles, 1); assert.equal([...f.timers.values()][0].delay, 60000);
    await f.scheduler.stop(); assert.equal(f.timers.size, 0);
  });
  await test('Stop cancels the immediate startup callback; repeated Stop remains safe', async () => {
    const f = fixture(); await f.scheduler.start(); await Promise.all([f.scheduler.stop(), f.scheduler.stop()]);
    assert.equal(f.timers.size, 0); assert.equal(f.counts().cycles, 0); assert.equal(f.state.isRunning, false);
  });
  await test('Stop during discovery drains source and prevents queue dispatch or reschedule', async () => {
    const f = fixture(); const gate = deferred(); let dispatched = 0;
    f.setJob(async ctx => { await gate.promise; if (await ctx.allowed()) dispatched++; });
    await f.scheduler.start(); await f.fire(); await f.scheduler.stop(); gate.resolve(); await flush();
    assert.equal(dispatched, 0); assert.equal(f.timers.size, 0);
  });
  await test('Stop immediately followed by Start invalidates old work and begins a fresh cycle after drain', async () => {
    const f = fixture(); const gate = deferred(); let oldAllowed = true;
    f.setJob(async ctx => { await gate.promise; oldAllowed = await ctx.allowed(); });
    await f.scheduler.start(); await f.fire(); await f.scheduler.stop(); await f.scheduler.start();
    assert.equal(f.timers.size, 0); gate.resolve(); await flush(); assert.equal(oldAllowed, false);
    assert.equal(f.timers.size, 1); assert.equal([...f.timers.values()][0].delay, 0);
    await f.scheduler.stop();
  });
  await test('Manual Run Once while stopped never enables scheduling', async () => {
    const f = fixture(); await f.scheduler.runOnce(); assert.equal(f.counts().cycles, 1); assert.equal(f.state.isRunning, false); assert.equal(f.timers.size, 0);
  });
  await test('Manual Run Once while running replaces pending timer and reschedules once', async () => {
    const f = fixture(); await f.scheduler.start(); await f.scheduler.runOnce();
    assert.equal(f.counts().cycles, 1); assert.equal(f.timers.size, 1); await f.scheduler.stop();
  });
  await test('Concurrent manual requests reject overlap including Process Next Gap', async () => {
    const f = fixture(); const gate = deferred(); f.setJob(async () => gate.promise);
    const work = f.scheduler.runOnce(); await assert.rejects(f.scheduler.runOnce(), /already executing/); await assert.rejects(f.scheduler.runOnce(true), /already executing/);
    gate.resolve(); await work; assert.equal(await f.scheduler.runOnce(true), 1); assert.equal(f.counts().ones, 1);
  });
  await test('Interval changes replace waiting timer, and apply after an active tick', async () => {
    const f = fixture(); await f.scheduler.start(); await f.scheduler.interval(120000); assert.equal([...f.timers.values()][0].delay, 120000);
    const gate = deferred(); f.setJob(async () => gate.promise); await f.fire(); await f.scheduler.interval(180000); assert.equal(f.timers.size, 0);
    gate.resolve(); await flush(); assert.equal([...f.timers.values()][0].delay, 180000); await f.scheduler.stop();
  });
  await test('Process shutdown preserves running preference; recovery honors persisted next execution', async () => {
    const f = fixture(); await f.scheduler.start(); await f.scheduler.shutdown(); assert.equal(f.state.isRunning, true); assert.equal(f.timers.size, 0);
    const resumed = fixture(); resumed.state.isRunning = true; resumed.state.nextExecutionAt = new Date(45000); await resumed.scheduler.recover();
    assert.equal([...resumed.timers.values()][0].delay, 45000); await resumed.scheduler.stop();
  });
  await test('An unexpected tick exception reschedules and subsequent discovery executes', async () => {
    const f = fixture(); f.setJob(async () => { throw new Error('controlled failure'); }); await f.scheduler.start(); await f.fire();
    assert.equal(f.errors.length, 1); assert.equal(f.timers.size, 1); f.setJob(async () => true); await f.fire(); assert.equal(f.timers.size, 1); await f.scheduler.stop();
  });
  await test('Repeated database outages keep a cancellable recovery timer until storage returns', async () => {
    const f = fixture();
    f.setJob(async () => { f.setReadFailures(2); return true; });
    await f.scheduler.start(); await f.fire(); assert.equal(f.timers.size, 1);
    await f.fire(); assert.equal(f.timers.size, 1);
    f.setJob(async () => true); await f.fire(); assert.equal(f.timers.size, 1);
    await f.fire(); assert.equal(f.timers.size, 1); await f.scheduler.stop(); assert.equal(f.timers.size, 0);
  });
  await test('Cross-session operation lease prevents duplicate manual work', async () => {
    const f = fixture(); f.setLease(true); await assert.rejects(f.scheduler.runOnce(), /another session/); assert.equal(f.counts().cycles, 0);
  });
  await test('Emergency stop blocks Start and manual execution', async () => {
    const f = fixture(); f.setEmergency(true); await assert.rejects(f.scheduler.start(), /Emergency stop/); await assert.rejects(f.scheduler.runOnce(), /Emergency stop/); assert.equal(f.counts().cycles, 0);
  });
  console.log(`${count} deterministic lifecycle scenarios passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
