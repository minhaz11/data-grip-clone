import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { backend } from '../../ipc/client';
import { useConnections } from './connectionsStore';

async function clearAll() {
  for (const c of await backend.connectionsList()) await backend.connectionDelete(c.id);
  useConnections.setState({ items: [], selectedId: null, error: null });
}

async function openNewDialog(user: ReturnType<typeof userEvent.setup>) {
  render(<App />);
  await screen.findByRole('toolbar');
  await user.keyboard('{Alt>}{Insert}{/Alt}');
  return screen.getByRole('dialog', { name: 'New PostgreSQL Data Source' });
}

describe('connection manager UI', () => {
  beforeEach(clearAll);

  it('validates, creates, and lists a data source without exposing the password', async () => {
    const user = userEvent.setup();
    const create = vi.spyOn(backend, 'connectionCreate');
    const dialog = await openNewDialog(user);

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByText('Name is required.')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText('Name'), 'Orders local');
    await user.selectOptions(within(dialog).getByLabelText('Environment'), 'production');
    await user.click(within(dialog).getByLabelText(/Read-only/));
    await user.type(within(dialog).getByLabelText('Password'), 'pa55word');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Orders local', environment: 'production', readOnly: true }),
      'pa55word',
    );
    const item = await screen.findByRole('treeitem', {
      name: 'Orders local, read-only, Production',
    });
    expect(item).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Selected data source')).toHaveTextContent(
      'Orders local (read-only)',
    );
    expect(document.body.innerHTML).not.toContain('pa55word');
  });

  it('shows a saved password as write-only and sends explicit change actions', async () => {
    const user = userEvent.setup();
    await backend.connectionCreate(
      { ...(await import('./model')).NEW_DRAFT, name: 'Analytics' },
      'old-secret',
    );
    const update = vi.spyOn(backend, 'connectionUpdate');
    render(<App />);

    await user.dblClick(await screen.findByRole('treeitem', { name: /Analytics/ }));
    let dialog = screen.getByRole('dialog', { name: 'Data Source: Analytics' });
    expect(within(dialog).getByText('Saved')).toBeInTheDocument();
    expect(dialog.querySelector('input[type="password"]')).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), {
      action: 'keep',
    });

    await user.dblClick(screen.getByRole('treeitem', { name: /Analytics/ }));
    dialog = screen.getByRole('dialog', { name: 'Data Source: Analytics' });
    await user.click(within(dialog).getByRole('button', { name: 'Clear' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(update).toHaveBeenLastCalledWith(expect.any(String), expect.anything(), {
      action: 'clear',
    });
    expect((await backend.connectionsList())[0]?.passwordSaved).toBe(false);
  });

  it('surfaces backend errors such as duplicate names inline', async () => {
    const user = userEvent.setup();
    await backend.connectionCreate({ ...(await import('./model')).NEW_DRAFT, name: 'Main' }, null);
    const dialog = await openNewDialog(user);
    await user.type(within(dialog).getByLabelText('Name'), 'main');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('duplicates with Ctrl+D and deletes only after confirmation (Cancel focused)', async () => {
    const user = userEvent.setup();
    await backend.connectionCreate(
      { ...(await import('./model')).NEW_DRAFT, name: 'Billing' },
      'pw',
    );
    render(<App />);
    const tree = await screen.findByRole('tree', { name: 'Data sources' });
    await user.click(screen.getByRole('treeitem', { name: /Billing/ }));
    tree.focus();

    await user.keyboard('{Control>}d{/Control}');
    expect(await screen.findByRole('treeitem', { name: /Billing \(copy\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    await user.keyboard('{Delete}');
    const confirm = screen.getByRole('dialog', { name: 'Delete Data Source' });
    expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(confirm).toHaveTextContent('Its saved password will also be removed.');
    await user.keyboard('{Escape}');
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);

    await user.keyboard('{Delete}');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(1));
    expect(screen.getByRole('treeitem', { name: /Billing/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});
