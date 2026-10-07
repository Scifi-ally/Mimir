import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from './useStore';

describe('useStore', () => {
  beforeEach(() => {
    // Reset state before each test
    useStore.setState({
      selectedSymbol: 'RELIANCE',
      wsConnected: false,
      events: []
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

  it('should add, remove, and clear events', () => {
    useStore.getState().addEvent({
      type: 'info',
      title: 'Test Event 1',
      message: 'Description 1'
    });
    useStore.getState().addEvent({
      type: 'warning',
      title: 'Test Event 2',
      message: 'Description 2'
    });

    const events = useStore.getState().events;
    expect(events.length).toBe(2);
    expect(events[0].title).toBe('Test Event 2');

    // Remove one event
    const idToRemove = events[0].id;
    useStore.getState().removeEvent(idToRemove);
    expect(useStore.getState().events.length).toBe(1);
    expect(useStore.getState().events[0].title).toBe('Test Event 1');

    // Clear all
    useStore.getState().clearEvents();
    expect(useStore.getState().events.length).toBe(0);
  });
});
