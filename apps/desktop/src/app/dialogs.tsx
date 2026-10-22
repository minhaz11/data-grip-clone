import type { ReactNode } from 'react';
import { create } from 'zustand';
import { ChoiceDialog, type Choice } from '../components/ui/ChoiceDialog';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import type { ConnectionProfile } from '../ipc/types';
import { PasswordPrompt } from '../features/connections/PasswordPrompt';

interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  resolve(ok: boolean): void;
}

interface ChoiceRequest {
  title: string;
  body: ReactNode;
  choices: Choice[];
  resolve(chosen: boolean): void;
}

interface CustomRequest {
  render(done: (value: unknown) => void): ReactNode;
  resolve(value: unknown): void;
}

interface DialogState {
  confirm: ConfirmRequest | null;
  choice: ChoiceRequest | null;
  password: { profile: ConnectionProfile; resolve(connected: boolean): void } | null;
  custom: CustomRequest | null;
}

const useDialogs = create<DialogState>(() => ({
  confirm: null,
  choice: null,
  password: null,
  custom: null,
}));

/** Resolves true when the user confirms, false when they cancel or close the dialog. */
export function askConfirm(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useDialogs.setState({ confirm: { ...request, resolve } }));
}

/** Resolves true once one of `choices` has run successfully, false on Cancel. */
export function askChoice(request: Omit<ChoiceRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useDialogs.setState({ choice: { ...request, resolve } }));
}

/** Prompts for a password and connects; resolves true once connected. */
export function askPasswordAndConnect(profile: ConnectionProfile): Promise<boolean> {
  return new Promise((resolve) => useDialogs.setState({ password: { profile, resolve } }));
}

/**
 * Shows a dialog rendered by `render`; resolves with what it passes to `done` (`null` when it
 * was cancelled).
 */
export function askCustom<T>(
  render: (done: (value: T | null) => void) => ReactNode,
): Promise<T | null> {
  return new Promise((resolve) =>
    useDialogs.setState({
      custom: {
        render: (done) => render((value) => done(value)),
        resolve: (value) => resolve(value as T | null),
      },
    }),
  );
}

/** Renders whichever app-level dialog is pending. Mounted once in App. */
export function DialogHost() {
  const { confirm, choice, password, custom } = useDialogs();
  return (
    <>
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          danger={confirm.danger}
          onConfirm={async () => {
            confirm.resolve(true);
          }}
          onClose={() => {
            confirm.resolve(false); // no-op if already resolved by onConfirm
            useDialogs.setState({ confirm: null });
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
      {choice && (
        <ChoiceDialog
          title={choice.title}
          choices={choice.choices}
          onDone={() => {
            choice.resolve(true);
            useDialogs.setState({ choice: null });
          }}
          onCancel={() => {
            choice.resolve(false);
            useDialogs.setState({ choice: null });
          }}
        >
          {choice.body}
        </ChoiceDialog>
      )}
      {custom?.render((value) => {
        custom.resolve(value);
        useDialogs.setState({ custom: null });
      })}
      {password && (
        <PasswordPrompt
          profile={password.profile}
          onConnected={() => password.resolve(true)}
          onClose={() => {
            password.resolve(false);
            useDialogs.setState({ password: null });
          }}
        />
      )}
    </>
  );
}
