import { useEffect } from 'react';

const dirtyForms = new Set<object>();
let listenersInstalled = false;

export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!listenersInstalled) {
      window.addEventListener('sao:before-navigation', event => { if (dirtyForms.size && !window.confirm('Discard unsaved changes before navigating?')) event.preventDefault(); });
      window.addEventListener('beforeunload', event => { if (dirtyForms.size) { event.preventDefault(); event.returnValue = ''; } });
      listenersInstalled = true;
    }
    const form = {};
    if (dirty) dirtyForms.add(form);
    return () => { dirtyForms.delete(form); };
  }, [dirty]);
}
