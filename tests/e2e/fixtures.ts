import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Page } from '@playwright/test';

const FAKE_IPC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-ipc.js');

interface FakeCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** The app, loaded with the fake backend. Every test also checks that no IPC call went unhandled. */
export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await page.addInitScript({ path: FAKE_IPC });
    await page.goto('/');
    await expect(page.getByRole('toolbar', { name: 'Main toolbar' })).toBeVisible();
    await use(page);
    expect(await unhandledCommands(page), 'IPC commands the fake did not handle').toEqual([]);
  },
});

export { expect };

export function ipcCalls(page: Page, cmd: string): Promise<FakeCall[]> {
  return page.evaluate(
    (name) =>
      (window as unknown as { __fakeIpc: { calls: FakeCall[] } }).__fakeIpc.calls.filter(
        (c) => c.cmd === name,
      ),
    cmd,
  );
}

function unhandledCommands(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __fakeIpc: { unhandled: string[] } }).__fakeIpc.unhandled,
  );
}

/** Creates a data source through the New Data Source dialog. */
export async function createDataSource(
  page: Page,
  name: string,
  options: { password?: string; environment?: string } = {},
): Promise<void> {
  await page.getByRole('button', { name: 'New data source', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New PostgreSQL Data Source' });
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  if (options.password) {
    await dialog.getByLabel('Password', { exact: true }).fill(options.password);
  }
  if (options.environment) {
    await dialog.getByLabel('Environment').selectOption(options.environment);
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('treeitem', { name: new RegExp(`^${name}`) })).toBeVisible();
}

/** Opens a new console bound to `source` and replaces its text with `sql`. */
export async function consoleWith(page: Page, source: string, sql: string): Promise<void> {
  await page.getByRole('button', { name: 'New console', exact: true }).click();
  const toolbar = page.getByRole('toolbar', { name: 'Console toolbar' });
  await toolbar.getByLabel('Data source').selectOption({ label: source });
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(sql);
}

/** Fails on any WCAG 2.1 A/AA violation in the current page state. */
export async function expectNoA11yViolations(page: Page, include?: string): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  if (include) {
    builder = builder.include(include);
  }
  const { violations } = await builder.analyze();
  const report = violations.flatMap((v) =>
    v.nodes.map((n) => `${v.id}: ${n.html.slice(0, 160)}\n    ${n.failureSummary ?? v.help}`),
  );
  expect(report).toEqual([]);
}
