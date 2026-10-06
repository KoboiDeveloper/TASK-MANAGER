import { listOnlineNiks, trackOffline, trackOnline } from './chat.presence';

describe('chat presence tracking', () => {
  it('marks online only on first socket, offline only on last socket', () => {
    const online = new Map<string, Set<string>>();

    expect(trackOnline(online, 'A', 's1').becameOnline).toBe(true);
    expect(trackOnline(online, 'A', 's2').becameOnline).toBe(false);
    expect(listOnlineNiks(online)).toEqual(['A']);

    expect(trackOffline(online, 'A', 's1').becameOffline).toBe(false);
    expect(trackOffline(online, 'A', 's2').becameOffline).toBe(true);
    expect(listOnlineNiks(online)).toEqual([]);
  });
});
