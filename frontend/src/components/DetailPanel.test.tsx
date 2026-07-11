import { render, screen } from '@testing-library/react';
import { DetailPanel } from './DetailPanel';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';

// Mock dependencies
vi.mock('@/providers/MarketDataProvider', () => ({
  useSymbolData: () => ({ ltp: 100, pc: -1, prevClose: 101, volume: 1000 })
}));

vi.mock('@/components/Sparkline', () => ({
  Sparkline: () => <div data-testid="sparkline" />
}));

vi.mock('@/components/SupportResistancePanel', () => ({
  SupportResistancePanel: () => <div data-testid="sr-panel" />
}));

vi.mock('@/components/mimir/tooltip', () => ({
  Tooltip: ({ children, content }: any) => <div data-testid="tooltip" title={content}>{children}</div>,
  TooltipProvider: ({ children }: any) => <>{children}</>
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    useQuery: () => ({
      data: { history: [], indicators: {}, scan: {}, ai: {} },
      isPending: false,
      isError: false,
    }),
  };
});

describe('DetailPanel', () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });

  const renderComponent = (props = {}) => {
    return render(
      <QueryClientProvider client={queryClient}>
        <DetailPanel 
          suggestions={[]}
          selectedSymbol="RELIANCE"
          session={undefined}
          {...props}
        />
      </QueryClientProvider>
    );
  };

  it('renders the selected symbol name', () => {
    renderComponent();
    expect(screen.getByText('RELIANCE')).toBeInTheDocument();
  });
});
