import { WebSocket } from 'ws';

export class WsBroadcaster {
  private clients = new Set<WebSocket>();

  addClient(socket: WebSocket) {
    this.clients.add(socket);
    socket.on('close', () => {
      this.clients.delete(socket);
    });
    socket.on('error', () => {
      this.clients.delete(socket);
    });
  }

  broadcast(msg: { type: 'changed'; seq: number }) {
    const payload = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(payload);
        } catch {
          this.clients.delete(client);
        }
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }
}
