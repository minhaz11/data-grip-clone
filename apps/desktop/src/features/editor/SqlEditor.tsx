import { lazy, Suspense, useState } from 'react';
import { ErrorBoundary } from '../../components/ui/ErrorBoundary';
import type { SqlEditorProps } from './editorHandle';

// Monaco is large; load it on first use so startup stays fast.
const load = () => import('./MonacoSqlEditor');

export function SqlEditor(props: SqlEditorProps) {
  // React.lazy caches a failed import; Retry swaps in a fresh lazy() so it really reloads.
  const [Editor, setEditor] = useState(() => lazy(load));
  return (
    <ErrorBoundary what="the SQL editor" onRetry={() => setEditor(() => lazy(load))}>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-muted">Loading editor…</div>
        }
      >
        <Editor {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
