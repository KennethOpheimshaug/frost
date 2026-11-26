// A small JSON-RPC / Language Server Protocol client over the Rust process bridge.
import { api } from "../lib/api";

type Handler = (params: any) => any;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: any) => void;
  method: string;
}

export class LspError extends Error {
  constructor(
    message: string,
    public code: number,
  ) {
    super(message);
  }
}

const clients = new Map<string, LspClient>();
let listening = false;

function listenOnce() {
  if (listening) return;
  listening = true;
  api.onLspMessage((id, json) => clients.get(id)?.receive(json));
  api.onProcExit((id, code) => clients.get(id)?.exited(code));
  api.onProcLine((id, stream, line) => {
    if (stream === "stderr") clients.get(id)?.log(line);
  });
}

export class LspClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private requestHandlers = new Map<string, Handler>();
  private notificationHandlers = new Map<string, Handler[]>();
  running = false;
  onExit: (code: number | null) => void = () => {};
  onLog: (line: string) => void = () => {};

  constructor(public readonly id: string) {
    listenOnce();
    clients.set(id, this);
  }

  async start(command: string, args: string[], cwd?: string): Promise<string> {
    const exe = await api.lspStart(this.id, command, args, cwd);
    this.running = true;
    return exe;
  }

  request<T = any>(method: string, params?: unknown, signal?: { onCancellationRequested?: (cb: () => void) => void }): Promise<T> {
    if (!this.running) return Promise.reject(new LspError("Language server is not running", -32099));
    const id = this.nextId++;
    const p = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
    this.send({ jsonrpc: "2.0", id, method, params });
    signal?.onCancellationRequested?.(() => {
      if (this.pending.has(id)) this.notify("$/cancelRequest", { id });
    });
    return p;
  }

  notify(method: string, params?: unknown) {
    if (this.running) this.send({ jsonrpc: "2.0", method, params });
  }

  onRequest(method: string, handler: Handler) {
    this.requestHandlers.set(method, handler);
  }

  onNotification(method: string, handler: Handler) {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
  }

  async stop() {
    if (!this.running) return;
    try {
      await Promise.race([this.request("shutdown"), new Promise((r) => setTimeout(r, 2000))]);
      this.notify("exit");
    } catch {
      /* ignore */
    }
    setTimeout(() => api.procKill(this.id), 500);
    this.running = false;
  }

  dispose() {
    clients.delete(this.id);
  }

  // --- internals ---

  private send(msg: object) {
    api.lspSend(this.id, JSON.stringify(msg)).catch((e) => this.log(`send failed: ${e}`));
  }

  log(line: string) {
    this.onLog(line);
  }

  exited(code: number | null) {
    this.running = false;
    for (const p of this.pending.values()) p.reject(new LspError("Language server exited", -32099));
    this.pending.clear();
    this.onExit(code);
  }

  async receive(json: string) {
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch {
      return this.log(`bad message: ${json.slice(0, 200)}`);
    }
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new LspError(msg.error.message, msg.error.code));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      // Request from the server: always answer, or it may wait forever.
      const handler = this.requestHandlers.get(msg.method);
      try {
        const result = handler ? await handler(msg.params) : null;
        if (!handler) this.log(`(unhandled server request ${msg.method})`);
        this.send({ jsonrpc: "2.0", id: msg.id, result: result ?? null });
      } catch (e) {
        this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: String(e) } });
      }
    } else {
      for (const h of this.notificationHandlers.get(msg.method) ?? []) {
        try {
          h(msg.params);
        } catch (e) {
          this.log(`notification handler for ${msg.method} failed: ${e}`);
        }
      }
    }
  }
}
