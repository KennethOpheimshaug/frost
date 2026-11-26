// Debug Adapter Protocol client. DAP uses the same Content-Length framing as LSP,
// so it runs over the same Rust process bridge.
import { api } from "../lib/api";

type EventHandler = (body: any) => void;

export class DapClient {
  private seq = 1;
  private pending = new Map<number, { resolve: (b: any) => void; reject: (e: Error) => void; command: string }>();
  private handlers = new Map<string, EventHandler[]>();
  private reverse = new Map<string, (args: any) => any>();
  private unlisten: (() => void)[] = [];
  running = false;
  onExit: (code: number | null) => void = () => {};
  onLog: (line: string) => void = () => {};

  constructor(public readonly id: string) {}

  async start(command: string, args: string[], cwd?: string) {
    this.unlisten.push(
      await api.onLspMessage((id, json) => id === this.id && this.receive(json)),
      await api.onProcExit((id, code) => {
        if (id !== this.id) return;
        this.running = false;
        for (const p of this.pending.values()) p.reject(new Error("Debugger exited"));
        this.pending.clear();
        this.onExit(code);
      }),
      await api.onProcLine((id, _s, line) => id === this.id && this.onLog(line)),
    );
    await api.lspStart(this.id, command, args, cwd);
    this.running = true;
  }

  request<T = any>(command: string, args?: unknown): Promise<T> {
    if (!this.running) return Promise.reject(new Error("Debugger is not running"));
    const seq = this.seq++;
    const p = new Promise<T>((resolve, reject) => this.pending.set(seq, { resolve, reject, command }));
    this.send({ seq, type: "request", command, arguments: args });
    return p;
  }

  on(event: string, handler: EventHandler) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  onReverseRequest(command: string, handler: (args: any) => any) {
    this.reverse.set(command, handler);
  }

  kill() {
    this.running = false;
    api.procKill(this.id).catch(() => {});
    this.unlisten.forEach((u) => u());
    this.unlisten = [];
  }

  private send(msg: object) {
    api.lspSend(this.id, JSON.stringify(msg)).catch((e) => this.onLog(`send failed: ${e}`));
  }

  private async receive(json: string) {
    let msg: any;
    try {
      msg = JSON.parse(json);
    } catch {
      return;
    }
    if (msg.type === "response") {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      if (msg.success) p.resolve(msg.body ?? {});
      else p.reject(new Error(msg.body?.error?.format ?? msg.message ?? `${p.command} failed`));
    } else if (msg.type === "event") {
      for (const h of this.handlers.get(msg.event) ?? []) h(msg.body ?? {});
    } else if (msg.type === "request") {
      const h = this.reverse.get(msg.command);
      try {
        const body = h ? await h(msg.arguments) : undefined;
        this.send({ seq: this.seq++, type: "response", request_seq: msg.seq, command: msg.command, success: !!h, body, message: h ? undefined : "not supported" });
      } catch (e) {
        this.send({ seq: this.seq++, type: "response", request_seq: msg.seq, command: msg.command, success: false, message: String(e) });
      }
    }
  }
}
