// server.ts
import { serve } from "https://deno.land/std@0.175.0/http/server.ts";

const TCP_PORT = 8001;
const WS_PORT = 8002;

const wsClients = new Map<string, WebSocket>();
const tcpClients = new Map<string, Deno.Conn>();

type ClientHelloDetails = { clientId: number, clientTime: number };
function parseClientHello(data: Uint8Array) : ClientHelloDetails {
  const clientId =
    (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
  const clientTime =
    (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
  return { clientId, clientTime };
}

function createServerAckBuffer(utcTimeInSeconds: number): ArrayBuffer {
    /** Milliseconds since beginning of the month */
    function getMsSinceMonthStart(utcTimeInSeconds: number): number {
      // Beginning of the month (UTC)
      const startOfMonth = Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        1, 0, 0, 0, 0
      );
      return utcTimeInSeconds - startOfMonth;
    }
    const msSinceMonthStart = getMsSinceMonthStart(utcTimeInSeconds);

    // Create a 4-byte array buffer
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    const littleEndian = false; // bigendian is network order 
    view.setUint32(0, msSinceMonthStart, littleEndian);

    return buffer;
}
// Broadcast from TCP to TCP clients
function broadcastTCP(msg: Uint8Array) {
  for (const [id, client] of tcpClients) {
    try {
      client.write(msg);
    } catch {
      tcpClients.delete(id);
      client.close();
    }
  }
}

// Broadcast from TCP to WS clients
function broadcastWS(msg: Uint8Array) {
  for (const [id, ws] of wsClients) {
    try {
      ws.send(msg);
    } catch {
      wsClients.delete(id);
    }
  }
}

// TCP server
async function startTCP() {
  const listener = Deno.listen({ port: TCP_PORT });
  console.log(`TCP server running on ${TCP_PORT}`);
  for await (const conn of listener) {
    const id = crypto.randomUUID();
    tcpClients.set(id, conn);
    try {
      const buf = new Uint8Array(1024);
      let offset = 0;

      // --- Receive 4 bytes as client ID ---
      while (offset < 8) {
        const n = await conn.read(buf.subarray(offset));
        if (n === null) throw new Error("Connection closed before ID");
        offset += n;
      }
      const idBuf = buf.subarray(0, 8);
      const { clientId, clientTime } = parseClientHello(idBuf);

      console.log(`[${id}] Client ID: ${clientId}`);
      console.log(`[${id}] Client time since month start (ms): ${clientTime}`);

      // Server ACK
      const serverAckBuffer = createServerAckBuffer(Date.now());
      const timeUint32 = new Uint8Array(serverAckBuffer);
      const bytesWritten = await conn.write(timeUint32);
      if (bytesWritten != 4) { throw new Error("Cannot write server ACK to client socket")}

      while (true) {
        const n = await conn.read(buf);
        // TODO ensure it only full messages, read exact size of the messsage
        // (for that you will to parse the header)
        if (n === null) break;
        broadcastTCP(buf.subarray(0, n));
        broadcastWS(buf.subarray(0, n));
      }
    } catch {
      // ignore
      console.warn("error with client ", { conn })
    } finally {
      tcpClients.delete(id);
      conn.close();
    }
  }
}

async function startWS() {
  console.log(`WebSocket server running on ws://localhost:${WS_PORT}/ws`);

  await serve((req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const { socket, response } = Deno.upgradeWebSocket(req);
      const id = crypto.randomUUID();
      wsClients.set(id, socket);

      socket.binaryType = "arraybuffer";
      let handshakeDone = false;

      socket.onmessage = (e) => {
        const data = new Uint8Array(e.data);

        if (!handshakeDone) {
          // Expecting first message = 8 bytes (client ID + time)
          if (data.length != 8) {
            console.warn("WS connection close because bad client hello length", data.length);
            socket.close();
            return;
          }

          const { clientId, clientTime } = parseClientHello(data);

          console.log(`[WS ${id}] Client ID: ${clientId}`);
          console.log(`[WS ${id}] Client time since month start (ms): ${clientTime}`);

          // --- Prepare and send 4-byte handshake reply ---
          const serverAckBuffer = createServerAckBuffer(Date.now());

          socket.send(serverAckBuffer);

          handshakeDone = true;
          return;
        } else {
          // --- Normal message after handshake ---
          const buf: Uint8Array = new Uint8Array(e.data);
          broadcastTCP(buf);
          broadcastWS(buf);
        }
      };

      socket.onclose = () => {
        console.log(`[WS ${id}] Connection closed`);
        wsClients.delete(id);
      };

      socket.onerror = (err) => {
        console.log(`[WS ${id}] Error:`, err);
        wsClients.delete(id);
      };

      return response;
    }

    return new Response("WebSocket server. Connect at /ws", { status: 200 });
  }, { port: WS_PORT });
}

startTCP();
startWS();