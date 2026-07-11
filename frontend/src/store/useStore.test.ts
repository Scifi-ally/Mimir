import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './useStore';

describe('useStore', () => {
  beforeEach(() => {
    // Reset state before each test
    useStore.setState({
      selectedSymbol: 'RELIANCE',
      wsConnected: false
    });
  });

  it('should initialize with default values', () => {
    const state = useStore.getState();
    expect(state.selectedSymbol).toBe('RELIANCE');
    expect(state.wsConnected).toBe(false);
  });

  it('should update selectedSymbol', () => {
    useStore.getState().setSelectedSymbol('TCS');
    expect(useStore.getState().selectedSymbol).toBe('TCS');
  });

  it('should update wsConnected', () => {
    useStore.getState().setWsConnected(true);
    expect(useStore.getState().wsConnected).toBe(true);
  });
});
