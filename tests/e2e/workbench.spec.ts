import {
  consoleWith,
  createDataSource,
  expect,
  expectNoA11yViolations,
  ipcCalls,
  test,
} from './fixtures';

test('creates a data source, connects, and walks the explorer tree', async ({ app }) => {
  await createDataSource(app, 'Dev', { password: 'e2e-secret-pw' });

  // The password goes to the backend once and is never shown back.
  const [create] = await ipcCalls(app, 'connection_create');
  expect(create?.args).toMatchObject({ draft: { name: 'Dev' }, password: 'e2e-secret-pw' });
  expect(await app.content()).not.toContain('e2e-secret-pw');

  const tree = app.getByRole('tree', { name: 'Data sources' });
  await app.getByRole('treeitem', { name: /^Dev/ }).click();
  await tree.press('ArrowRight'); // expand: connects and loads schemas
  await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();
  expect(await ipcCalls(app, 'connection_connect')).toHaveLength(1);

  await tree.press('ArrowDown');
  await tree.press('ArrowRight');
  await expect(app.getByRole('treeitem', { name: 'Tables, folder, 2' })).toBeVisible();
  await tree.press('ArrowDown');
  await tree.press('ArrowRight');
  await expect(app.getByRole('treeitem', { name: 'customers, table' })).toBeVisible();
  await expect(app.getByRole('treeitem', { name: 'orders, table' })).toBeVisible();
});

test('runs a query, shows the result grid, and exports it', async ({ app }) => {
  await createDataSource(app, 'Dev');
  await app.getByRole('treeitem', { name: /^Dev/ }).click();
  await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
  await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();

  await consoleWith(app, 'Dev', 'select id, email from shop.customers');
  await app.keyboard.press('ControlOrMeta+Enter');

  const grid = app.getByRole('grid', { name: 'Result rows' });
  await expect(grid).toBeVisible();
  await expect(grid).toHaveAttribute('aria-rowcount', '3'); // header + 2 rows
  await expect(grid.getByText('a@example.test')).toBeVisible();
  await expect(grid.getByText('NULL')).toBeVisible();
  const [run] = await ipcCalls(app, 'query_execute');
  expect(run?.args).toMatchObject({
    request: { statements: [{ sql: 'select id, email from shop.customers', offset: 0 }] },
  });

  await app.getByRole('button', { name: /Export/ }).click();
  const dialog = app.getByRole('dialog', { name: 'Export result' });
  await dialog.getByLabel('Format').selectOption('csv');
  await dialog.getByRole('button', { name: 'Export' }).click();
  await expect.poll(() => ipcCalls(app, 'result_export')).toHaveLength(1);
  const [exported] = await ipcCalls(app, 'result_export');
  expect(exported?.args).toMatchObject({
    cursor: 'quarry_c1',
    format: 'csv',
    options: { header: true },
  });
  await expect(app.getByText(/Exported 2 rows/)).toBeVisible();
});

test('asks before running a destructive statement, with Cancel focused', async ({ app }) => {
  await createDataSource(app, 'Dev');
  await app.getByRole('treeitem', { name: /^Dev/ }).click();
  await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
  await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();

  await consoleWith(app, 'Dev', 'delete from shop.customers');
  await app.keyboard.press('ControlOrMeta+Enter');

  const dialog = app.getByRole('dialog', { name: 'Run destructive statement?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await app.keyboard.press('Enter'); // Enter on the focused Cancel must not run it
  await expect(dialog).toBeHidden();
  expect(await ipcCalls(app, 'query_execute')).toEqual([]);
});

test('manual transactions stay open until Commit', async ({ app }) => {
  await createDataSource(app, 'Dev');
  await app.getByRole('treeitem', { name: /^Dev/ }).click();
  await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
  await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();

  await consoleWith(app, 'Dev', "insert into shop.customers values (3, 'c@example.test')");
  const toolbar = app.getByRole('toolbar', { name: 'Console toolbar' });
  await toolbar.getByLabel('Tx').selectOption('manual');
  await expect(toolbar.getByLabel('Isolation level')).toBeVisible();
  await app.locator('.monaco-editor').first().click();
  await app.keyboard.press('ControlOrMeta+Enter');

  await expect(toolbar.getByRole('status')).toHaveText('Transaction open');
  await expect(app.getByLabel('transaction open')).toHaveText('TX');
  await expect(app.getByLabel('Transaction state')).toHaveText('Transaction open');
  // Controls wrap instead of scrolling sideways: nothing in the toolbar is hidden.
  expect(await toolbar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await toolbar.getByRole('button', { name: 'Commit' }).click();
  await expect.poll(() => ipcCalls(app, 'tx_commit')).toHaveLength(1);
  await expect(toolbar.getByRole('status')).toBeHidden();
  await expect(app.getByLabel('transaction open')).toBeHidden();
  const [commit] = await ipcCalls(app, 'tx_commit');
  expect(commit?.args).toMatchObject({ session: { sourceId: 'fake-1' } });
});

test('query history records runs and reopens them in a new console', async ({ app }) => {
  await createDataSource(app, 'Dev');
  await app.getByRole('treeitem', { name: /^Dev/ }).click();
  await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
  await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();

  await consoleWith(app, 'Dev', 'select id, email from shop.customers');
  await app.keyboard.press('ControlOrMeta+Enter');
  await expect(app.getByRole('grid', { name: 'Result rows' })).toBeVisible();

  await app.keyboard.press('ControlOrMeta+Alt+E');
  const dialog = app.getByRole('dialog', { name: 'Query History' });
  await expect(dialog).toBeVisible();
  const list = dialog.getByRole('listbox', { name: 'History entries' });
  await expect(list.getByRole('option')).toHaveCount(1);
  await expect(list.getByRole('option').first()).toContainText('select id, email');
  await expect(list.getByRole('img', { name: 'Succeeded' })).toBeVisible();
  await expectNoA11yViolations(app, '[role="dialog"]');

  await dialog.getByLabel('Search history').fill('orders');
  await expect(dialog.getByText('No statements match.')).toBeVisible();
  await dialog.getByLabel('Search history').fill('customers');
  await expect(list.getByRole('option')).toHaveCount(1);

  await dialog.getByRole('button', { name: 'Open in new console' }).click();
  await expect(dialog).toBeHidden();
  const tabs = app.getByRole('tablist', { name: 'Open editors' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(app.locator('.monaco-editor').last()).toContainText('select id, email');
});

test.describe('accessibility', () => {
  test('main workbench has no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('button', { name: 'New console', exact: true }).click();
    await expect(app.locator('.monaco-editor').first()).toBeVisible();
    await expectNoA11yViolations(app);
  });

  test('dark theme workbench, with a production source, has no WCAG A/AA violations', async ({
    app,
  }) => {
    await app.getByRole('button', { name: /^Settings/ }).click();
    const settings = app.getByRole('dialog');
    await settings.getByLabel('Theme').selectOption('dark');
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
    await createDataSource(app, 'Prod', { environment: 'production' });
    await app.getByRole('button', { name: 'New console', exact: true }).click();
    await expect(app.locator('.monaco-editor').first()).toBeVisible();
    await expectNoA11yViolations(app);
  });

  test('table viewer has no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('treeitem', { name: /^Dev/ }).click();
    const tree = app.getByRole('tree', { name: 'Data sources' });
    await tree.press('ArrowRight');
    await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();
    await tree.press('ArrowDown');
    await tree.press('ArrowRight');
    await tree.press('ArrowDown');
    await tree.press('ArrowRight');
    await tree.press('ArrowDown');
    await tree.press('Enter'); // customers: open the table viewer
    await expect(app.getByRole('tab', { name: 'customers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(app.getByRole('region', { name: 'Columns' })).toBeVisible();
    await expectNoA11yViolations(app);
  });

  test('DDL tab is read-only and has no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('treeitem', { name: /^Dev/ }).click();
    const tree = app.getByRole('tree', { name: 'Data sources' });
    await tree.press('ArrowRight');
    await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();
    await tree.press('ArrowDown');
    await tree.press('ArrowRight');
    await tree.press('ArrowDown');
    await tree.press('ArrowRight');
    await app.getByRole('treeitem', { name: 'customers, table' }).click({ button: 'right' });
    await app.getByRole('menuitem', { name: 'Show DDL' }).click();
    await expect(app.getByRole('tab', { name: 'DDL: shop.customers' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const editor = app.locator('.monaco-editor').first();
    await expect(editor).toContainText('CREATE TABLE shop.customers');
    // Typing does not change generated DDL.
    await editor.click();
    await app.keyboard.type('xyz');
    await expect(editor).not.toContainText('xyz');
    // Monaco fades in a "read-only editor" message; scanning mid-fade measures blended colors.
    await app.keyboard.press('Escape');
    await expect(app.locator('.monaco-editor-overlaymessage')).toHaveCount(0);
    await expectNoA11yViolations(app);
  });

  test('SQL syntax colors meet contrast in both themes', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await consoleWith(
      app,
      'Dev',
      "-- comment\nselect id, 'text', 42, now() from t where a is not null and b <> 1;",
    );
    await expectNoA11yViolations(app, '.monaco-editor');
    await app.getByRole('button', { name: /^Settings/ }).click();
    const settings = app.getByRole('dialog');
    await settings.getByLabel('Theme').selectOption('dark');
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectNoA11yViolations(app, '.monaco-editor');
  });

  test('table dialog previews statements and has no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('treeitem', { name: /^Dev/ }).click();
    await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
    await app.getByRole('treeitem', { name: 'shop, schema' }).click({ button: 'right' });
    await app.getByRole('menuitem', { name: 'New table…' }).click();
    const dialog = app.getByRole('dialog', { name: 'New table in shop' });
    await dialog.getByLabel('Name', { exact: true }).fill('events');
    await expect(dialog.getByLabel('Statements to run')).toHaveText(
      'CREATE TABLE shop.events (...);',
    );
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).toBeHidden();
    const [applied] = await ipcCalls(app, 'schema_apply');
    expect(applied?.args).toMatchObject({ statements: ['CREATE TABLE shop.events (...)'] });
  });

  test('Open data grid, selection summary and copy dialog have no WCAG A/AA violations', async ({
    app,
  }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('treeitem', { name: /^Dev/ }).click();
    const tree = app.getByRole('tree', { name: 'Data sources' });
    await tree.press('ArrowRight');
    await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();
    await tree.press('ArrowDown');
    await tree.press('ArrowRight');
    await tree.press('ArrowDown');
    await tree.press('ArrowRight');
    await app.getByRole('treeitem', { name: 'customers, table' }).click({ button: 'right' });
    await app.getByRole('menuitem', { name: 'Open data' }).click();
    await expect(app.getByRole('tab', { name: 'customers (data)' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const grid = app.getByRole('grid', { name: 'Result rows' });
    await expect(grid.getByText('a@example.test')).toBeVisible();
    const [run] = await ipcCalls(app, 'query_execute');
    expect(run?.args).toMatchObject({
      request: { statements: [{ sql: 'SELECT * FROM shop.customers', offset: 0 }] },
    });
    await grid.focus();
    await app.keyboard.press('ControlOrMeta+a');
    await expect(app.getByRole('status', { name: 'Selection summary' })).toContainText('Count');
    await expectNoA11yViolations(app);

    await app.getByRole('button', { name: /Copy/ }).click();
    const dialog = app.getByRole('dialog', { name: 'Copy rows' });
    await dialog.getByLabel('Format').selectOption('markdown');
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Copy' }).click();
    await expect.poll(() => ipcCalls(app, 'result_format')).toHaveLength(1);
    const [formatted] = await ipcCalls(app, 'result_format');
    expect(formatted?.args).toMatchObject({ format: 'markdown' });
  });

  test('parameter prompt binds values and notices reach the output', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await consoleWith(app, 'Dev', 'select * from shop.customers where id = :id');
    await app.keyboard.press('ControlOrMeta+Enter');
    const dialog = app.getByRole('dialog', { name: 'Statement parameters' });
    await dialog.getByLabel(':id', { exact: true }).fill('42');
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Run' }).click();
    await expect.poll(() => ipcCalls(app, 'query_execute')).toHaveLength(1);
    const [run] = await ipcCalls(app, 'query_execute');
    expect(run?.args).toMatchObject({
      request: {
        statements: [{ sql: 'select * from shop.customers where id = $1 ', params: ['42'] }],
      },
    });

    await consoleWith(app, 'Dev', "do $$ begin raise notice 'hello there'; end $$");
    await app.keyboard.press('ControlOrMeta+Enter');
    const output = app.getByLabel('Statement output');
    await expect(output).toContainText('NOTICE: hello there');
    await expectNoA11yViolations(app);
  });

  test('connection dialog has no WCAG A/AA violations', async ({ app }) => {
    await app.getByRole('button', { name: 'New data source', exact: true }).click();
    await expect(app.getByRole('dialog', { name: 'New PostgreSQL Data Source' })).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
  });

  test('every connection dialog tab has no WCAG A/AA violations', async ({ app }) => {
    await app.getByRole('button', { name: 'New data source', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: 'New PostgreSQL Data Source' });
    await dialog.getByRole('tab', { name: 'SSH' }).click();
    await dialog.getByLabel('Connect through an SSH tunnel').check();
    await expect(dialog.getByLabel('SSH host')).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
    for (const name of ['TLS', 'Options', 'Schemas']) {
      await dialog.getByRole('tab', { name }).click();
      await expect(dialog.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
      await expectNoA11yViolations(app, '[role="dialog"]');
    }
  });

  test('explorer folders rename inline and have no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('button', { name: 'New folder' }).click();
    const input = app.getByRole('textbox', { name: 'New name' });
    await expect(input).toBeFocused();
    await input.fill('Production');
    await input.press('Enter');
    const folder = app.getByRole('treeitem', { name: /^Production, folder, 0/ });
    await expect(folder).toBeVisible();
    await expectNoA11yViolations(app);

    // Drag the data source into the folder.
    await app.getByRole('treeitem', { name: /^Dev/ }).dragTo(folder);
    await expect(app.getByRole('treeitem', { name: /^Production, folder, 1/ })).toBeVisible();
    await expect(app.getByRole('treeitem', { name: /^Dev/ })).toHaveAttribute('aria-level', '2');
    const [move] = await ipcCalls(app, 'connection_move');
    expect(move?.args).toMatchObject({ folderId: expect.stringMatching(/^folder-/) });
  });

  test('search palette finds objects and has no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('treeitem', { name: /^Dev/ }).click();
    await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
    await expect(app.getByRole('treeitem', { name: 'shop, schema' })).toBeVisible();

    await app.keyboard.press('ControlOrMeta+Shift+A');
    const dialog = app.getByRole('dialog', { name: 'Search Everywhere' });
    await dialog.getByRole('combobox').fill('cust');
    await expect(dialog.getByRole('option', { name: /customers/ })).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
    await app.keyboard.press('Enter');
    await expect(app.getByRole('tab', { name: /customers/ })).toBeVisible();
  });

  test('import wizard walks to a finished import with no WCAG A/AA violations', async ({ app }) => {
    await createDataSource(app, 'Dev');
    await app.getByRole('treeitem', { name: /^Dev/ }).click();
    await app.getByRole('tree', { name: 'Data sources' }).press('ArrowRight');
    const schema = app.getByRole('treeitem', { name: 'shop, schema' });
    await schema.click({ button: 'right' });
    await app.getByRole('menuitem', { name: 'Import data from file…' }).click();
    const dialog = app.getByRole('dialog', { name: 'Import Data into Dev' });
    await dialog.getByRole('button', { name: 'Choose File…' }).click();
    await expect(dialog.getByRole('table', { name: 'File preview' })).toContainText('Ann');
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await dialog.getByLabel('Table name').fill('people');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByRole('table', { name: 'Column mapping' })).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByLabel('Generated statements')).toContainText('CREATE TABLE');
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Import' }).click();
    await expect(dialog.getByRole('status')).toContainText('Imported 2 rows');
    await expectNoA11yViolations(app, '[role="dialog"]');
  });

  test('settings dialog has no WCAG A/AA violations', async ({ app }) => {
    await app.getByRole('button', { name: /^Settings/ }).click();
    await expect(app.getByRole('dialog')).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
  });

  test('keymap settings rebind a shortcut and have no WCAG A/AA violations', async ({ app }) => {
    await app.getByRole('button', { name: /^Settings/ }).click();
    const dialog = app.getByRole('dialog', { name: 'Settings' });
    await dialog.getByRole('tab', { name: 'Keymap' }).click();
    await dialog.getByRole('button', { name: 'Add shortcut to Query history' }).click();
    await app.keyboard.press('ControlOrMeta+Alt+J');
    await dialog.getByRole('button', { name: 'Add shortcut to Stop the running query' }).click();
    await app.keyboard.press('ControlOrMeta+Enter');
    await expect(dialog.getByText(/only one of them can run/).first()).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
    await dialog
      .getByRole('button', { name: /^Remove .* from Stop the running query$/ })
      .last()
      .click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    // The new shortcut works in the real browser key path (Cmd on macOS, Ctrl elsewhere).
    await app.keyboard.press('ControlOrMeta+Alt+J');
    await expect(app.getByRole('dialog', { name: 'Query History' })).toBeVisible();
    const [saved] = (await ipcCalls(app, 'settings_set')).slice(-1);
    expect(saved?.args).toMatchObject({
      settings: { keymap: { 'history.open': ['Ctrl+Alt+E', 'Ctrl+Alt+J'] } },
    });
  });
});
