import clsx from 'clsx';
import {
  Eye,
  FileCode,
  ListOrdered,
  LoaderCircle,
  Rows3,
  SquareFunction,
  Table2,
  Zap,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useKeymap } from '../../app/keymapStore';
import { useWorkspace } from '../../app/workspaceStore';
import { Modal } from '../../components/ui/Modal';
import { backend } from '../../ipc/client';
import { ACTIONS, type ActionId } from '../../lib/actions';
import { shortcutLabel } from '../../lib/keymap';
import { useConnections } from '../connections/connectionsStore';
import { useSessions } from '../connections/sessionsStore';
import { catalogObjects } from '../editor/catalog';
import {
  fromCatalogNode,
  isRelation,
  openData,
  openDefault,
  revealInTree,
  showDdl,
  type CatalogObject,
} from '../navigation/objects';
import { prefixesFor, rank, type ItemType, type Rankable } from './rank';

export interface PaletteItem extends Rankable {
  key: string;
  object?: CatalogObject;
  sourceName?: string;
  action?: ActionId;
}

/** What a quick action does to the selected item. */
type Quick = 'open' | 'data' | 'ddl' | 'reveal';

const TYPE_LABEL: Record<ItemType, string> = {
  table: 'table',
  view: 'view',
  routine: 'routine',
  sequence: 'sequence',
  console: 'console',
  action: 'action',
};

function typeOf(o: CatalogObject): ItemType {
  switch (o.kind) {
    case 'view':
    case 'materialized_view':
      return 'view';
    case 'routine':
      return 'routine';
    case 'sequence':
      return 'sequence';
    default:
      return 'table';
  }
}

function Icon({ item }: { item: PaletteItem }) {
  const props = { size: 13, 'aria-hidden': true, className: 'shrink-0 text-accent' } as const;
  switch (item.object?.kind) {
    case 'view':
      return <Eye {...props} />;
    case 'materialized_view':
      return <Rows3 {...props} />;
    case 'routine':
      return <SquareFunction {...props} />;
    case 'sequence':
      return <ListOrdered {...props} />;
    case undefined:
      return item.type === 'console' ? <FileCode {...props} /> : <Zap {...props} />;
    default:
      return <Table2 {...props} />;
  }
}

/**
 * Search everywhere: database objects of connected data sources, console files and actions.
 * Type prefixes (`/tables`, `/views`, `/routines`, `/sequences`, `/consoles`, `/actions`) narrow
 * the search. Enter opens; Ctrl+Enter opens data, Shift+Enter shows DDL, Alt+Enter reveals the
 * object in the explorer.
 */
export function Palette({
  initial = '',
  actions,
  onRunAction,
  onClose,
}: {
  initial?: string;
  /** Actions the palette can run (those with a handler right now). */
  actions: ActionId[];
  onRunAction(id: ActionId): void;
  onClose(): void;
}) {
  const keymap = useKeymap();
  const [input, setInput] = useState(initial);
  const [active, setActive] = useState(0);
  // Objects per connected data source, from the cached catalog, as each arrives.
  const [loaded, setLoaded] = useState<Record<string, PaletteItem[]>>({});
  const [consoles, setConsoles] = useState<PaletteItem[]>([]);
  const sources = useConnections((s) => s.items);
  const sessions = useSessions((s) => s.byId);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const connected = useMemo(
    () => sources.filter((s) => sessions[s.id]?.state === 'connected'),
    [sources, sessions],
  );
  const loading = connected.filter((s) => !(s.id in loaded)).map((s) => s.name);
  const objects = useMemo(() => connected.flatMap((s) => loaded[s.id] ?? []), [connected, loaded]);

  useEffect(() => {
    let cancelled = false;
    for (const source of connected) {
      void catalogObjects(source.id).then((nodes) => {
        if (cancelled) {
          return;
        }
        const items = nodes.map((n): PaletteItem => {
          const object = fromCatalogNode(source.id, n);
          return {
            key: `${source.id}\u001f${n.key}`,
            type: typeOf(object),
            name: object.name,
            detail: object.schema,
            object,
            sourceName: source.name,
          };
        });
        setLoaded((l) => ({ ...l, [source.id]: items }));
      });
    }
    return () => {
      cancelled = true;
    };
  }, [connected]);

  useEffect(() => {
    let cancelled = false;
    void backend
      .consoleList()
      .catch(() => [] as string[])
      .then((names) => {
        if (!cancelled) {
          setConsoles(
            names.map((name) => ({ key: `console\u001f${name}`, type: 'console', name })),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const actionItems = useMemo(
    () =>
      ACTIONS.filter((a) => actions.includes(a.id)).map((a): PaletteItem => ({
        key: `action\u001f${a.id}`,
        type: 'action',
        name: a.title,
        action: a.id,
      })),
    [actions],
  );

  const results = useMemo(
    () => rank([...objects, ...consoles, ...actionItems], input, 100),
    [objects, consoles, actionItems, input],
  );
  const suggestions = prefixesFor(input);
  const selected = results[Math.min(active, results.length - 1)];

  useEffect(() => {
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [active, results]);

  function run(item: PaletteItem | undefined, quick: Quick = 'open') {
    if (!item) {
      return;
    }
    onClose();
    if (item.object) {
      const o = item.object;
      if (quick === 'data' && openData(o)) {
        return;
      }
      if (quick === 'ddl') {
        showDdl(o);
      } else if (quick === 'reveal') {
        revealInTree(o);
      } else {
        openDefault(o);
      }
    } else if (item.type === 'console') {
      void useWorkspace.getState().openConsole(item.name);
    } else if (item.action) {
      const id = item.action;
      // After the palette is gone, so the action sees the focus it expects.
      setTimeout(() => onRunAction(id), 0);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.max(0, Math.min(results.length - 1, i + delta)));
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const delta = e.key === 'PageDown' ? 10 : -10;
      setActive((i) => Math.max(0, Math.min(results.length - 1, i + delta)));
    } else if (e.key === 'Tab' && suggestions[0] && !e.shiftKey) {
      e.preventDefault();
      setInput(`${suggestions[0]} `);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const quick: Quick =
        e.ctrlKey || e.metaKey ? 'data' : e.shiftKey ? 'ddl' : e.altKey ? 'reveal' : 'open';
      run(selected, quick);
    }
  }

  const objectSelected = selected?.object;
  return (
    <Modal title="Search Everywhere" onClose={onClose} width={640}>
      <div className="space-y-2">
        <input
          type="text"
          role="combobox"
          aria-label="Search objects, consoles and actions"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={selected ? `${listId}-${selected.key}` : undefined}
          spellCheck={false}
          value={input}
          placeholder="Name, schema.name, or /tables /views /routines /consoles /actions"
          onChange={(e) => {
            setInput(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="w-full rounded border border-border bg-bg px-2 py-1.5"
        />
        {suggestions.length > 0 && (
          <p className="text-[12px] text-muted">Tab completes {suggestions.join(', ')}</p>
        )}
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="max-h-80 overflow-auto rounded border border-border bg-bg py-1"
        >
          {results.map((item, i) => (
            <li
              key={item.key}
              id={`${listId}-${item.key}`}
              role="option"
              aria-selected={item === selected}
              onMouseMove={() => setActive(i)}
              onClick={() => run(item)}
              className={clsx(
                'flex cursor-default items-center gap-2 px-2 py-1',
                item === selected && 'bg-selected',
              )}
            >
              <Icon item={item} />
              <span className="min-w-0 truncate">
                {item.object?.kind === 'routine'
                  ? `${item.name}(${item.object.args ?? ''})`
                  : item.name}
              </span>
              <span className="shrink-0 text-[11px] text-muted">
                {item.object
                  ? `${item.object.kind.replace('_', ' ')} in ${item.detail}`
                  : TYPE_LABEL[item.type]}
              </span>
              <span className="ml-auto shrink-0 truncate text-[11px] text-muted">
                {item.sourceName ??
                  (item.action
                    ? shortcutLabel(item.action, keymap)
                    : item.type === 'console'
                      ? '.sql'
                      : '')}
              </span>
            </li>
          ))}
          {results.length === 0 && (
            <li className="px-2 py-1 text-muted" role="presentation">
              {loading.length > 0 ? 'Loading…' : 'Nothing found.'}
            </li>
          )}
        </ul>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
          {loading.length > 0 && (
            <span className="flex items-center gap-1" role="status">
              <LoaderCircle size={12} className="animate-spin" aria-hidden /> Loading objects of{' '}
              {loading.join(', ')}
            </span>
          )}
          {objectSelected && (
            <>
              <button type="button" className="underline" onClick={() => run(selected, 'open')}>
                {isRelation(objectSelected) ? 'Open viewer' : 'Show DDL'} (Enter)
              </button>
              {isRelation(objectSelected) && (
                <button type="button" className="underline" onClick={() => run(selected, 'data')}>
                  Open data (Ctrl+Enter)
                </button>
              )}
              {isRelation(objectSelected) && (
                <button type="button" className="underline" onClick={() => run(selected, 'ddl')}>
                  Show DDL (Shift+Enter)
                </button>
              )}
              <button type="button" className="underline" onClick={() => run(selected, 'reveal')}>
                Reveal in explorer (Alt+Enter)
              </button>
            </>
          )}
          {!objectSelected && selected && <span>Enter to {selected.action ? 'run' : 'open'}</span>}
        </div>
      </div>
    </Modal>
  );
}
