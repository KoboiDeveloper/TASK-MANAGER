/** Multi-tab safe presence bookkeeping for ChatGateway. */

export function trackOnline(
  online: Map<string, Set<string>>,
  nik: string,
  socketId: string,
): { becameOnline: boolean } {
  let sockets = online.get(nik);
  if (!sockets) {
    sockets = new Set();
    online.set(nik, sockets);
  }
  const becameOnline = sockets.size === 0;
  sockets.add(socketId);
  return { becameOnline };
}

export function trackOffline(
  online: Map<string, Set<string>>,
  nik: string,
  socketId: string,
): { becameOffline: boolean } {
  const sockets = online.get(nik);
  if (!sockets) return { becameOffline: false };
  sockets.delete(socketId);
  if (sockets.size === 0) {
    online.delete(nik);
    return { becameOffline: true };
  }
  return { becameOffline: false };
}

export function listOnlineNiks(online: Map<string, Set<string>>): string[] {
  return [...online.keys()];
}
