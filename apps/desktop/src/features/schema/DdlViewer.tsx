import { Copy, FileDown, RefreshCw, SquarePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { askPasswordAndConnect } from '../../app/dialogs';
import { useSettings } from '../../app/settingsStore';
import { useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type { DdlObject, DdlOptions } from '../../ipc/types';
import { toAppError } from '../../lib/errors';
import { useConnections } from '../connections/connectionsStore';
import { useSessions } from '../connections/sessionsStore';
import { SqlEditor } from '../editor/SqlEditor';

const DEFAULT_OPTIONS: DdlOptions = { qualify: true, owner: false, grants: false };

/** Generated, read-only DDL for one or more objects, with copy, open-in-console and save (M4.4). */
export function DdlViewer({
  tabId,
  sourceId,
  objects,
  title,
  theme,
}: {
  tabId: string;
  sourceId: string;
  objects: DdlObject[];
  title: string;
  theme: 'light' | 'dark';
}) {
  const source = useConnections((s) => s.items.find((c) => c.id === sourceId));
  const connected = useSessions((s) => s.byId[sourceId]?.state === 'connected');
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const [options, setOptions] = useState<DdlOptions>(DEFAULT_OPTIONS);
  const [token, setToken] = useState(0);
  const key = `${JSON.stringify(objects)}|${JSON.stringify(options)}|${token}`;
  const [result, setResult] = useState<{ key: string; script?: string; error?: string } | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) {
      return;
    }
    let cancelled = false;
    backend
      .ddlGenerate(sourceId, objects, options)
      .then((script) => !cancelled && setResult({ key, script }))
      .catch((e: unknown) => !cancelled && setResult({ key, error: toAppError(e).message }));
    return () => {
      cancelled = true;
    };
    // `key` covers the objects, the options and the reload token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected]);

  const current = result?.key === key ? result : undefined;
  const script = current?.script;

  async function run(f: () => Promise<string | null>) {
    setNotice(null);
    try {
      const message = await f();
      if (message) {
        setNotice(message);
      }
    } catch (e) {
      setNotice(toAppError(e).message);
    }
  }

  const copy = () =>
    run(async () => {
      await navigator.clipboard?.writeText(script ?? '');
      return 'Copied to the clipboard.';
    });
  const openInConsole = () =>
    run(async () => {
      const ws = useWorkspace.getState();
      const id = await ws.newConsole(sourceId);
      ws.updateText(id, script ?? '');
      return null;
    });
  const save = () =>
    run(async () => {
      const path = await backend.ddlSave(sourceId, objects, options, title);
      return path ? `Saved to ${path}` : null;
    });
  const connect = () =>
    run(async () => {
      if (!source) {
        return null;
      }
      const error = await useSessions.getState().connect(source.id);
      if (error?.connectKind === 'password_required') {
        await askPasswordAndConnect(source);
        return null;
      }
      return error ? error.message : null;
    });

  const toggle = (name: keyof DdlOptions) => (
    <label className="flex items-center gap-1">
      <input
        type="checkbox"
        checked={options[name]}
        onChange={(e) => setOptions({ ...options, [name]: e.target.checked })}
      />
      {name === 'qualify' ? 'Qualified names' : name === 'owner' ? 'Owner' : 'Grants'}
    </label>
  );
  const button = 'flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover disabled:opacity-40';

  return (
    <div
      id="editor-tabpanel"
      role="tabpanel"
      aria-labelledby={`tab-${tabId}`}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div
        role="toolbar"
        aria-label="DDL toolbar"
        className="flex min-h-8 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-2 py-1 text-[12px] whitespace-nowrap"
      >
        <span className="font-mono text-muted">{title}</span>
        {toggle('qualify')}
        {toggle('owner')}
        {toggle('grants')}
        <span className="mx-1 h-4 w-px bg-border" aria-hidden />
        <button type="button" className={button} onClick={() => void copy()} disabled={!script}>
          <Copy size={13} aria-hidden /> Copy
        </button>
        <button
          type="button"
          className={button}
          onClick={() => void openInConsole()}
          disabled={!script}
        >
          <SquarePlus size={13} aria-hidden /> Open in console
        </button>
        <button type="button" className={button} onClick={() => void save()} disabled={!connected}>
          <FileDown size={13} aria-hidden /> Save…
        </button>
        <button
          type="button"
          className={button}
          onClick={() => setToken((t) => t + 1)}
          disabled={!connected}
        >
          <RefreshCw size={13} aria-hidden /> Refresh
        </button>
        {notice && (
          <span role="status" className="min-w-0 truncate text-muted" title={notice}>
            {notice}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {!source ? (
          <p className="m-4 text-muted">This data source no longer exists.</p>
        ) : !connected ? (
          <div className="m-4 space-y-2">
            <p className="text-muted">Connect to {source.name} to generate the DDL.</p>
            <button
              type="button"
              onClick={() => void connect()}
              className="rounded border border-border px-3 py-1 hover:bg-hover"
            >
              Connect
            </button>
          </div>
        ) : current?.error ? (
          <p role="alert" className="m-4 text-danger">
            Could not generate the DDL: {current.error}
          </p>
        ) : script === undefined ? (
          <p role="status" className="m-4 text-muted">
            Generating…
          </p>
        ) : (
          <SqlEditor
            tabId={tabId}
            name={`${title} DDL`}
            value={script}
            fontSize={fontSize}
            theme={theme}
            readOnly
            onChange={() => {}}
            onCaret={() => {}}
            onFormatError={() => {}}
          />
        )}
      </div>
    </div>
  );
}
