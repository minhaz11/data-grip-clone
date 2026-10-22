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

  await app.getByRole('button', { name: 'CSV' }).click();
  await expect.poll(() => ipcCalls(app, 'result_export')).toHaveLength(1);
  const [exported] = await ipcCalls(app, 'result_export');
  expect(exported?.args).toMatchObject({ cursor: 'quarry_c1', format: 'csv' });
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

  test('connection dialog has no WCAG A/AA violations', async ({ app }) => {
    await app.getByRole('button', { name: 'New data source', exact: true }).click();
    await expect(app.getByRole('dialog', { name: 'New PostgreSQL Data Source' })).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
  });

  test('settings dialog has no WCAG A/AA violations', async ({ app }) => {
    await app.getByRole('button', { name: /^Settings/ }).click();
    await expect(app.getByRole('dialog')).toBeVisible();
    await expectNoA11yViolations(app, '[role="dialog"]');
  });
});
