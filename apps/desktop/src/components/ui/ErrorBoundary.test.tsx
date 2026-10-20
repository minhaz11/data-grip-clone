import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

describe('ErrorBoundary', () => {
  it('contains a failure, shows it, and retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {}); // React logs caught errors
    let fail = true;
    function Flaky() {
      if (fail) throw new Error('chunk failed to load');
      return <p>loaded</p>;
    }
    const onRetry = vi.fn(() => {
      fail = false;
    });
    render(
      <div>
        <p>rest of app</p>
        <ErrorBoundary what="the SQL editor" onRetry={onRetry}>
          <Flaky />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not load the SQL editor.chunk failed to load',
    );
    expect(screen.getByText('rest of app')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByText('loaded')).toBeInTheDocument();
  });
});
