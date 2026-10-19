import { useRef, useState } from 'react';
import { trpc } from '../lib/trpc';

/** Synchronous request guards close the double-click window before React rerenders. */
export function useRuntimeControls() {
  const startLoop = trpc.coreLoop.start.useMutation();
  const stopLoop = trpc.coreLoop.stop.useMutation();
  const runOnce = trpc.coreLoop.runOnce.useMutation();
  const processNext = trpc.coreLoop.processNext.useMutation();
  const runAudit = trpc.coreLoop.runAudit.useMutation();
  const utils = trpc.useUtils();
  const lock = useRef(false);
  const stopLock = useRef(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  async function perform(action: 'start' | 'stop' | 'runOnce' | 'processNext' | 'audit') {
    const guard = action === 'stop' ? stopLock : lock;
    if (guard.current) return;
    guard.current = true;
    if (action === 'stop') setStopping(true); else setBusy(true);
    setFailed(false);
    setMessage(action === 'stop' ? 'Stopping further dispatch…' : 'Executing request…');
    try {
      if (action === 'start') { await startLoop.mutateAsync(); setMessage('Scheduler started. Discovery outcome will appear below.'); }
      if (action === 'stop') { const result = await stopLoop.mutateAsync(); setMessage(result.runtimeState === 'stopping' ? 'Stopping: dispatched work is finishing safely.' : 'Loop stopped.'); }
      if (action === 'runOnce') {
        const result = await runOnce.mutateAsync();
        const status = result?.discovery?.status;
        setFailed(status === 'unavailable' || status === 'partial');
        const queueErrors = result?.outcomes?.filter((o: any) => o.error).map((o: any) => `${o.status}: ${o.error}`) || [];
        if (queueErrors.length) setFailed(true);
        setMessage(queueErrors.length ? queueErrors.join('; ') : result?.stopped ? 'Cycle stopped; no further work dispatched.' : status === 'unavailable' ? 'Discovery failed; inspect diagnostics. Existing queue processing was attempted.' : status === 'partial' ? 'Cycle partially successful; inspect source and persistence errors.' : `Cycle completed: ${result?.discovery?.validated ?? 0} validated, ${result?.discovery?.queued ?? 0} queued, ${result?.processed ?? 0} processed.`);
      }
      if (action === 'processNext') {
        const result = await processNext.mutateAsync();
        const errors = result.outcomes?.filter((o: any) => o.error).map((o: any) => `${o.status}: ${o.error}`) || [];
        setFailed(errors.length > 0); setMessage(errors.join('; ') || result.message);
      }
      if (action === 'audit') { await runAudit.mutateAsync(); setMessage('Safety audit completed.'); }
    } catch (error: any) { setFailed(true); setMessage(error?.message || 'Runtime request failed.'); }
    finally {
      try { await utils.invalidate(); }
      catch (error: any) { setFailed(true); setMessage(`Status refresh failed: ${error?.message || 'Backend unavailable'}`); }
      finally { guard.current = false; if (action === 'stop') setStopping(false); else setBusy(false); }
    }
  }
  return { perform, message, failed, busy, stopping };
}
