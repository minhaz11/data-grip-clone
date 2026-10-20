import type { ReactNode } from 'react';
import { create } from 'zustand';
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

interface DialogState {
  confirm: ConfirmRequest | null;
  password: { profile: ConnectionProfile; resolve(connected: boolean): void } | null;
}

const useDialogs = create<DialogState>(() => ({ confirm: null, password: null }));

/** Resolves true when the user confirms, false when they cancel or close the dialog. */
export function askConfirm(request: Omit<ConfirmRequest, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => useDialogs.setState({ confirm: { ...request, resolve } }));
}

/** Prompts for a password and connects; resolves true once connected. */
export function askPasswordAndConnect(profile: ConnectionProfile): Promise<boolean> {
  return new Promise((resolve) => useDialogs.setState({ password: { profile, resolve } }));
}

/** Renders whichever app-level dialog is pending. Mounted once in App. */
export function DialogHost() {
  const { confirm, password } = useDialogs();
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
