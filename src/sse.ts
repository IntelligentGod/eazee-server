import type { Response } from "express";

type Client = {
  id: string;
  res: Response;
};

function writeEvent(res: Response, event: string, data: unknown) {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  res.write(`event: ${event}\n`);
  res.write(`data: ${payload}\n\n`);
}

function writeComment(res: Response, comment: string) {
  res.write(`: ${comment}\n\n`);
}

export function createSSEHub({ heartbeatMs = 15000 }: { heartbeatMs?: number } = {}) {
  const clients = new Map<string, Client>();
  let nextId = 1;

  const interval = setInterval(() => {
    const timestamp = Date.now();
    for (const client of clients.values()) {
      try {
        writeComment(client.res, `heartbeat ${timestamp}`);
      } catch (_err) {
        // Drop dead client
        clients.delete(client.id);
      }
    }
  }, heartbeatMs);

  function addClient(res: Response): string {
    const id = String(nextId++);
    clients.set(id, { id, res });
    // Initial ready event for clients to detect connection establishment
    try {
      writeEvent(res, "ready", { ok: true, clientId: id });
    } catch (_err) {
      // If write fails immediately, drop the client
      clients.delete(id);
    }
    return id;
  }

  function removeClient(id: string) {
    clients.delete(id);
  }

  function broadcast(event: string, data: unknown) {
    for (const client of clients.values()) {
      try {
        writeEvent(client.res, event, data);
      } catch (_err) {
        clients.delete(client.id);
      }
    }
  }

  function sendTo(clientId: string, event: string, data: unknown) {
    const client = clients.get(clientId);
    if (!client) return false;
    try {
      writeEvent(client.res, event, data);
      return true;
    } catch (_err) {
      clients.delete(clientId);
      return false;
    }
  }

  function clientCount() {
    return clients.size;
  }

  function close() {
    clearInterval(interval);
    for (const client of clients.values()) {
      try {
        writeComment(client.res, "server closing");
        client.res.end();
      } catch (_err) {
        // ignore
      }
    }
    clients.clear();
  }

  return { addClient, removeClient, broadcast, sendTo, clientCount, close };
}


