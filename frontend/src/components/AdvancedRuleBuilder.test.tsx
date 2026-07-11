import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AdvancedRuleBuilder } from './AdvancedRuleBuilder';
import { describe, it, expect, vi } from 'vitest';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const queryClient = new QueryClient();

describe('AdvancedRuleBuilder', () => {
  const renderWithClient = (ui: React.ReactElement) => {
    return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
  };

  it('renders the rule builder', () => {
    renderWithClient(<AdvancedRuleBuilder onComplete={vi.fn()} />);
    expect(screen.getByText(/All of the following are true/i)).toBeInTheDocument();
  });

  it('can click to add a new condition group', () => {
    renderWithClient(<AdvancedRuleBuilder onComplete={vi.fn()} />);
    const addBtn = screen.getByText(/Group/i);
    fireEvent.click(addBtn);
    // There should now be multiple conditions/groups in the UI
    const groups = screen.getAllByText(/Condition/i);
    expect(groups.length).toBeGreaterThan(1);
  });
});
