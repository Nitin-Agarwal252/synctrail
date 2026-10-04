import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import 'fake-indexeddb/auto';
import { App } from './App';

describe('App Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders top bar, title, connection pill, and empty state', async () => {
    render(<App />);

    expect(screen.getByText('SyncTrail · Survey')).toBeDefined();
    expect(screen.getByTestId('connection-pill')).toBeDefined();
    expect(screen.getByTestId('search-input')).toBeDefined();
    expect(screen.getByTestId('new-household-btn')).toBeDefined();

    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeDefined();
      expect(screen.getByText('Start your first household')).toBeDefined();
    });
  });

  it('renders filter chips', () => {
    render(<App />);

    expect(screen.getByTestId('filter-all')).toBeDefined();
    expect(screen.getByTestId('filter-pending')).toBeDefined();
    expect(screen.getByTestId('filter-conflicts')).toBeDefined();
    expect(screen.getByTestId('filter-deleted')).toBeDefined();
  });
});
