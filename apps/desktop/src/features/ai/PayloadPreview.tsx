import type { AiOmitted, AiPreview } from '../../ipc/types';
import { LEVEL_LABELS } from './ConsentDialog';

const REASONS: Record<AiOmitted['reason'], string> = {
  ignored: 'on the ignore list',
  size: 'too large to include',
  missing: 'not found',
};

export function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * "What will be sent": a summary of the request and, in a disclosure, its exact text. Send
 * transmits these bytes and nothing else.
 */
export function PayloadPreview({ preview }: { preview: AiPreview }) {
  return (
    <section aria-label="What will be sent" className="space-y-2">
      <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted">Context</dt>
        <dd>{LEVEL_LABELS[preview.level]}</dd>
        <dt className="text-muted">Size</dt>
        <dd>
          {formatBytes(preview.bytes)}, about {preview.estimatedTokens.toLocaleString()} tokens
        </dd>
        <dt className="text-muted">Model</dt>
        <dd className="font-mono">{preview.model}</dd>
        {preview.objects.length > 0 && (
          <>
            <dt className="text-muted">Schema of</dt>
            <dd className="font-mono">{preview.objects.join(', ')}</dd>
          </>
        )}
        {preview.rows.length > 0 && (
          <>
            <dt className="text-muted">Sample rows</dt>
            <dd>{preview.rows.map((r) => `${r.rows} from ${r.table}`).join('; ')}</dd>
          </>
        )}
        {preview.omitted.length > 0 && (
          <>
            <dt className="text-muted">Left out</dt>
            <dd>{preview.omitted.map((o) => `${o.name} (${REASONS[o.reason]})`).join(', ')}</dd>
          </>
        )}
      </dl>
      <details>
        <summary className="cursor-pointer">What will be sent (exact text)</summary>
        <pre
          aria-label="Request text"
          tabIndex={0}
          className="mt-1 max-h-72 overflow-auto rounded border border-border bg-bg p-2 font-mono text-[12px] whitespace-pre-wrap"
        >
          {preview.body}
        </pre>
      </details>
    </section>
  );
}
