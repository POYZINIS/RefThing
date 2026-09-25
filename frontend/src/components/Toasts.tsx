import type { ReactNode } from 'react';
import { Icon } from '@/ui/Icon';
import { enter } from '@/ui/motion';

export type Toast = {
  id: string;
  kind: 'error' | 'info';
  title: string;
  message?: ReactNode;
  action?: { label: string; run: () => void };
  onDismiss: () => void;
};

/**
 * Recoverable problems and quiet confirmations, bottom right. Each names what
 * happened and how to recover, and can be dismissed — nothing blocks the
 * board.
 */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          ref={(element) => {
            if (element && !element.dataset.shown) {
              element.dataset.shown = 'true';
              enter(element, 'rise');
            }
          }}
        >
          <Icon name={toast.kind === 'error' ? 'alert' : 'check'} />
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.message && <span>{toast.message}</span>}
            {toast.action && (
              <button
                className="button small toast-action"
                type="button"
                onClick={toast.action.run}
              >
                {toast.action.label}
              </button>
            )}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Dismiss message"
            title="Dismiss"
            onClick={toast.onDismiss}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The one obvious next step on an empty workspace or an empty board. The
 *  whole rectangle is the button; dropping files onto the frame does the
 *  same thing. */
export function OpenTarget({
  label,
  dropLabel,
  hint,
  dragging,
  onActivate,
}: {
  label: string;
  dropLabel: string;
  hint: string;
  dragging: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      className={`open-target ${dragging ? 'dragging' : ''}`}
      type="button"
      onClick={onActivate}
    >
      <Icon name="plus" size={44} />
      <span>{dragging ? dropLabel : label}</span>
      <small>{hint}</small>
    </button>
  );
}
