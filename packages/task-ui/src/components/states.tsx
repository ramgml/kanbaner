import type { ReactNode } from "react";

export interface LoadingStateProps {
  readonly label?: string;
}

export function LoadingState({ label = "Загрузка…" }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="task-ui-loading"
      className="flex items-center gap-2 rounded-lg border bg-card p-4 text-sm text-muted-foreground"
    >
      <span
        aria-hidden="true"
        className="size-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground"
      />
      {label}
    </div>
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <div
      data-testid="task-ui-empty"
      className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-card p-6 text-center"
    >
      <p className="text-base font-medium">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
      )}
      {action}
    </div>
  );
}

export interface ErrorStateProps {
  readonly message: string;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
}

export function ErrorState({ message, onRetry, retryLabel = "Повторить" }: ErrorStateProps) {
  return (
    <div
      role="alert"
      data-testid="task-ui-error"
      className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
    >
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <button
          type="button"
          onClick={onRetry}
          className="w-fit rounded-md border border-destructive/40 px-3 py-1.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive focus-visible:ring-offset-2"
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
