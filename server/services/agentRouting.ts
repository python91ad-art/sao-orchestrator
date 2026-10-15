import { AsyncLocalStorage } from 'node:async_hooks';

type Routing = { model?: string; level: 'standard' | 'high' | 'extended' };
const routing = new AsyncLocalStorage<Routing>();
export function currentAgentRouting() { return routing.getStore(); }
export function withAgentRouting<T>(assignment: Routing | undefined, operation: () => Promise<T>) { return assignment ? routing.run(assignment, operation) : operation(); }
