import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../../app/workspaceStore';
import { backend } from '../../ipc/client';
import type {
  DroppedFile,
  ImportEvent,
  ImportFile,
  ImportPreview,
  TableModel,
} from '../../ipc/types';
import { registerExplorerHarness, setup } from '../explorer/explorerTestKit';
import { useNotifications } from '../notifications/notifications';
import { columnName, initialMapping, mappingProblem } from './model';

registerExplorerHarness();

const FILE: ImportFile = {
  id: 'file-1',
  name: 'people.csv',
  size: 2048,
  detected: {
    encoding: 'UTF-8',
    format: {
      kind: 'delimited',
      encoding: null,
      delimiter: ',',
      quote: '"',
      escape: null,
      header: true,
      trim: false,
      nullToken: null,
      emptyIsNull: true,
    },
  },
};

const PREVIEW: ImportPreview = {
  columns: ['ID', 'Full Name', 'Born On'],
  inferred: ['integer', 'text', 'date'],
  rows: [
    ['1', 'Ann', '1990-01-02'],
    ['2', null, '1991-03-04'],
  ],
  lines: [2, 3],
  estimatedRows: 1200,
};

const PEOPLE: TableModel = {
  schema: 'shop',
  name: 'customers',
  comment: null,
  columns: [
    {
      name: 'id',
      original: 'id',
      typeName: 'bigint',
      notNull: true,
      default: null,
      identity: null,
      comment: null,
    },
    {
      name: 'full_name',
      original: 'full_name',
      typeName: 'text',
      notNull: true,
      default: null,
      identity: null,
      comment: null,
    },
  ],
  primaryKey: null,
  uniques: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
};

let dropped: (e: DroppedFile) => void = () => {};

/** Drops the file on `el` (jsdom has no layout, so the hit test is stubbed). */
function dropOn(el: Element) {
  const hit = document.elementFromPoint;
  document.elementFromPoint = () => el;
  try {
    act(() => dropped({ file: FILE, x: 10, y: 10 }));
  } finally {
    document.elementFromPoint = hit;
  }
}

beforeEach(() => {
  useWorkspace.setState({ importPresets: [] });
  useNotifications.setState({ items: [] });
  vi.spyOn(backend, 'importPick').mockResolvedValue(FILE);
  vi.spyOn(backend, 'importPreview').mockResolvedValue(PREVIEW);
  vi.spyOn(backend, 'tableModel').mockResolvedValue(PEOPLE);
  vi.spyOn(backend, 'schemaPreview').mockResolvedValue([
    'CREATE TABLE shop.people (id integer, full_name text, born_on date)',
  ]);
  vi.spyOn(backend, 'onFileDropped').mockImplementation(async (cb) => {
    dropped = cb;
    return () => {};
  });
});

async function openSchemaMenu(user: Awaited<ReturnType<typeof setup>>['user'], tree: HTMLElement) {
  tree.focus();
  await user.keyboard('{ArrowDown}{ArrowRight}');
  const schema = await screen.findByRole('treeitem', { name: 'shop, schema' });
  await user.pointer({ keys: '[MouseRight]', target: schema });
}

describe('import model', () => {
  it('names columns and maps existing ones by name', () => {
    expect(columnName('Full Name', 0)).toBe('full_name');
    expect(columnName('2024 total', 1)).toBe('c_2024_total');
    expect(columnName('***', 2)).toBe('column_3');
    const mapped = initialMapping(PREVIEW, PEOPLE.columns);
    expect(mapped.map((m) => [m.include, m.target, m.type])).toEqual([
      [true, 'id', 'bigint'],
      [true, 'full_name', 'text'],
      [false, '', 'text'],
    ]);
    expect(mappingProblem(mapped)).toBeNull();
    expect(mappingProblem(mapped.map((m) => ({ ...m, include: false })))).toMatch(/at least one/);
    expect(
      mappingProblem([
        { source: 0, include: true, target: 'a', type: 'text' },
        { source: 1, include: true, target: 'A', type: 'text' },
      ]),
    ).toMatch(/used twice/);
  });
});

describe('import wizard', () => {
  it('imports a file into a new table with the chosen mapping and policy', async () => {
    const { p, user, tree } = await setup();
    const run = vi
      .spyOn(backend, 'importRun')
      .mockImplementation(async (_f, _s, _plan, onEvent) => {
        queueMicrotask(() => {
          onEvent({ event: 'progress', rows: 600, rejected: 0, bytes: 1024, totalBytes: 2048 });
          onEvent({
            event: 'done',
            rows: 1199,
            rejected: [{ line: 7, column: 'born_on', message: '"x" is not a date', nulled: false }],
            rejectedCount: 1,
            nulled: 0,
            elapsedMs: 900,
            cancelled: false,
          } as ImportEvent);
        });
        return 'job-1';
      });
    await openSchemaMenu(user, tree);
    await user.click(screen.getByRole('menuitem', { name: 'Import data from file…' }));
    const dialog = screen.getByRole('dialog', { name: 'Import Data into Dev' });

    await user.click(within(dialog).getByRole('button', { name: 'Choose File…' }));
    expect(await within(dialog).findByRole('table', { name: 'File preview' })).toHaveTextContent(
      'Ann',
    );
    // Save the format as a preset.
    await user.type(within(dialog).getByLabelText('Preset name'), 'people csv');
    await user.click(within(dialog).getByRole('button', { name: 'Save Preset' }));
    expect(useWorkspace.getState().importPresets.map((x) => x.name)).toEqual(['people csv']);

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    await user.type(within(dialog).getByLabelText('Table name'), 'people');
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    const grid = within(dialog).getByRole('table', { name: 'Column mapping' });
    expect(within(grid).getByLabelText('Type for Born On')).toHaveValue('date');
    await user.click(within(grid).getByLabelText('Import Full Name'));
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));

    expect(await within(dialog).findByLabelText('Generated statements')).toHaveTextContent(
      'CREATE TABLE shop.people',
    );
    await user.click(within(dialog).getByLabelText(/Skip bad rows/));
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));

    expect(await within(dialog).findByRole('status')).toHaveTextContent('Imported 1,199 rows');
    expect(within(dialog).getByRole('table', { name: 'Rejected rows' })).toHaveTextContent(
      'is not a date',
    );
    expect(run).toHaveBeenCalledWith(
      'file-1',
      p.id,
      expect.objectContaining({
        sourceColumns: ['ID', 'Full Name', 'Born On'],
        mapping: [
          { source: 0, target: 'id', typeName: 'integer' },
          { source: 2, target: 'born_on', typeName: 'date' },
        ],
        table: { schema: 'shop', name: 'people' },
        setup: ['CREATE TABLE shop.people (id integer, full_name text, born_on date)'],
        policy: 'skip',
      }),
      expect.any(Function),
    );
    expect(within(dialog).getByRole('button', { name: 'Save Error Log…' })).toBeVisible();
  });

  it('asks before importing into production and can cancel a running import', async () => {
    const { user, tree } = await setup(['customers'], { environment: 'production' });
    vi.spyOn(backend, 'importRun').mockResolvedValue('job-2');
    const cancel = vi.spyOn(backend, 'importCancel').mockResolvedValue(null);
    tree.focus();
    await user.keyboard('{ArrowDown}{ArrowRight}');
    await screen.findByRole('treeitem', { name: 'shop, schema' });
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}');
    await user.pointer({
      keys: '[MouseRight]',
      target: await screen.findByRole('treeitem', { name: 'customers, table' }),
    });
    await user.click(screen.getByRole('menuitem', { name: 'Import data from file…' }));
    const dialog = screen.getByRole('dialog', { name: 'Import Data into Dev' });
    await user.click(within(dialog).getByRole('button', { name: 'Choose File…' }));
    await within(dialog).findByRole('table', { name: 'File preview' });
    for (let i = 0; i < 3; i++) {
      await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    }
    await user.click(within(dialog).getByRole('button', { name: 'Import' }));
    const confirm = screen.getByRole('dialog', { name: 'Import Into Production' });
    expect(confirm).toHaveTextContent('about 1,200 rows into shop.customers');
    await user.click(within(confirm).getByRole('button', { name: 'Import' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Cancel Import' }));
    expect(cancel).toHaveBeenCalledWith('job-2');
  });

  it('refuses read-only sources and opens the wizard for a file dropped on a table', async () => {
    const { user, tree } = await setup(['customers'], { readOnly: true });
    await openSchemaMenu(user, tree);
    expect(screen.queryByRole('menuitem', { name: 'Import data from file…' })).toBeNull();
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}');
    const table = await screen.findByRole('treeitem', { name: 'customers, table' });

    // A drop on the read-only source's table is refused with a notification.
    dropOn(table);
    expect(useNotifications.getState().items.at(-1)?.text).toMatch(/read-only/);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the wizard on the table a file was dropped on', async () => {
    const { user, tree } = await setup(['customers']);
    tree.focus();
    await user.keyboard('{ArrowDown}{ArrowRight}');
    await screen.findByRole('treeitem', { name: 'shop, schema' });
    await user.keyboard('{ArrowDown}{ArrowRight}{ArrowDown}{ArrowRight}');
    const table = await screen.findByRole('treeitem', { name: 'customers, table' });
    dropOn(table);
    const dialog = await screen.findByRole('dialog', { name: 'Import Data into Dev' });
    expect(within(dialog).getByText('people.csv')).toBeVisible();
    await within(dialog).findByRole('table', { name: 'File preview' });
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByLabelText('An existing table')).toBeChecked();
    expect(within(dialog).getByLabelText('Table')).toHaveValue('customers');
    await waitFor(() => expect(backend.tableModel).toHaveBeenCalled());
  });
});
