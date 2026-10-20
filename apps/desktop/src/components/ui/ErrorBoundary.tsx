import { Component, type ReactNode } from 'react';

interface Props {
  /** What failed, for the message ("the SQL editor"). */
  what: string;
  /** Runs before the boundary re-renders its children (e.g. to re-create a failed lazy import). */
  onRetry?(): void;
  children: ReactNode;
}

/** Contains a render/load failure to one area and offers a retry instead of a blank window. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center"
      >
        <p className="text-danger">Could not load {this.props.what}.</p>
        <p className="max-w-md break-words text-[12px] text-muted select-text">{error.message}</p>
        <button
          type="button"
          onClick={() => {
            this.props.onRetry?.();
            this.setState({ error: null });
          }}
          className="rounded border border-border px-3 py-1 hover:bg-hover"
        >
          Retry
        </button>
      </div>
    );
  }
}
