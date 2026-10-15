import { Component, ErrorInfo, ReactNode, useEffect, useId, useRef } from 'react';
import { AlertCircle, X } from 'lucide-react';

export function LoadingState({ label = 'Loading workspace…' }: { label?: string }) {
  return <div role="status" className="loading-state"><span className="spinner" aria-hidden="true" /><span>{label}</span><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
}

export function ErrorState({ message, retry }: { message: string; retry?: () => void }) {
  return <section role="alert" className="error-state"><AlertCircle size={20} aria-hidden="true" /><div><h3>Action needs attention</h3><p>{message}</p>{retry && <button type="button" className="btn-secondary" onClick={retry}>Try again</button>}</div></section>;
}

export function StatusBadge({ tone = 'neutral', children }: { tone?: 'success' | 'warning' | 'danger' | 'neutral' | 'intelligence'; children: ReactNode }) {
  return <span className={`status-badge tone-${tone}`}><span aria-hidden="true" className="status-dot" />{children}</span>;
}

export function Dialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element?.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} className={`sao-dialog ${className}`} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === dialog.current) { const bounds = dialog.current.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose(); } }}><header className="dialog-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label={`Close ${title}`} className="icon-button" onClick={onClose}><X size={18} /></button></header>{children}</dialog>;
}

export class WorkspaceBoundary extends Component<{ children: ReactNode; page: string }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { }
  render() { return this.state.error ? <ErrorState message={`The ${this.props.page} workspace could not render. Other workspaces remain available. Reload to retry; no operation is marked successful.`} retry={() => window.location.reload()} /> : this.props.children; }
}
