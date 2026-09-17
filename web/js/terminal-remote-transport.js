import { DirectAppSocket } from '../../bridge/terminal-direct-protocol.mjs';

export class RemoteTerminalSocket extends EventTarget {
  readyState = WebSocket.CONNECTING;
  socket = null;
  clientSeq = 0;
  eventSeq = 1;
  outputSeq = 0;
  pending = new Map();
  pendingBytes = 0;
  unacked = new Map();
  terminalId = crypto.randomUUID();

  constructor(device, { profile = false, direct = false, projectHash = null } = {}) {
    super();
    this.device = device;
    this.profile = profile;
    this.direct = direct;
    this.projectHash = projectHash;
    Promise.resolve().then(() => this.connect()).catch(() => this.fail('远程连接初始化失败：请确认已登录主页面及网络正常'));
  }

  get bufferedAmount() {
    return (this.socket?.bufferedAmount || 0) + [...this.unacked.values()].reduce((sum, size) => sum + size, 0);
  }

  async connect() {
    const key = atob(localStorage.getItem('_ak') || '');
    if (!key || !this.device) return this.fail('请先在主页面登录，并选择在线设备');
    const server = (localStorage.getItem('_as') || location.origin).replace(/\/$/, '');
    const config = await fetch(`${server}/api/bridge/config`, {
      headers: { 'x-api-key': key }, signal: AbortSignal.timeout(15000),
    });
    if (!config.ok) return this.fail(`读取远程配置失败：HTTP ${config.status}`);
    const { wsUrl } = await config.json();
    if (!wsUrl?.startsWith('wss://')) return this.fail('服务器没有返回有效的 WSS 地址');
    const endpoint = new URL(wsUrl);
    endpoint.search = new URLSearchParams({ apiKey: key, role: 'app' });
    if (this.readyState !== WebSocket.CONNECTING) return;
    this.socket = this.direct
      ? new DirectAppSocket({ endpoint: wsUrl, key, terminalId: this.terminalId, device: this.device, projectHash: this.projectHash })
      : new WebSocket(endpoint);
    this.socket.addEventListener('open', () => {
      this.readyState = WebSocket.OPEN;
      this.readyTimeout = setTimeout(() => this.fail('等待远程 PTY 超时：请确认该设备的 Bridge 在线且已更新'), 15000);
      this.dispatchEvent(new Event('open'));
    });
    this.socket.addEventListener('message', event => this.receive(event.data));
    this.socket.addEventListener('error', event => this.fail(event.data || '远程 WSS 连接失败，请检查网络和登录状态'));
    this.socket.addEventListener('close', event => {
      this.cleanup();
      this.readyState = WebSocket.CLOSED;
      this.dispatchEvent(new CloseEvent('close', { code: event.code, reason: event.reason }));
    });
  }

  send(payload) {
    if (this.readyState !== WebSocket.OPEN) return;
    const message = JSON.parse(payload);
    const clientSeq = message.type === 'open' ? 0 : ++this.clientSeq;
    const frame = JSON.stringify({
      ...message, action: this.projectHash ? 'terminal_shared' : 'terminal_poc', v: 1, device: this.device,
      terminalId: this.terminalId, clientSeq,
      ...(this.projectHash ? { projectHash: this.projectHash } : {}),
      ...(this.profile ? { profile: true } : {}),
    });
    if (new TextEncoder().encode(frame).length > 28 * 1024 || this.bufferedAmount + frame.length > 256 * 1024) {
      return this.fail('远程输入队列超限，会话已停止，不会重放输入');
    }
    if (clientSeq) this.unacked.set(clientSeq, frame.length);
    this.socket.send(frame);
  }

  receive(payload) {
    try {
      if (typeof payload !== 'string' || new TextEncoder().encode(payload).length > 28 * 1024) throw new Error('远程消息过大');
      const message = JSON.parse(payload);
      if (message.action !== (this.projectHash ? 'terminal_shared' : 'terminal_poc')) return;
      if (this.projectHash && message.projectHash !== this.projectHash) return;
      if (message.terminalId !== this.terminalId || message.device !== this.device) return;
      if (message.v !== 1) throw new Error('远程协议版本不兼容');
      if (message.type === 'ack' && message.eventSeq === 0) {
        if (!Number.isSafeInteger(message.clientSeq) || message.clientSeq < 1) throw new Error('无效输入确认');
        return this.deliver(message);
      }
      if (message.type === 'error' && message.eventSeq === 0) return this.deliver(message);
      if (!Number.isSafeInteger(message.eventSeq) || message.eventSeq < 1) throw new Error('无效输出序号');
      if (message.eventSeq < this.eventSeq || this.pending.has(message.eventSeq)) return;
      this.pending.set(message.eventSeq, message);
      this.pendingBytes += JSON.stringify(message).length;
      if (message.eventSeq - this.eventSeq > 256 || this.pendingBytes > 1024 * 1024) throw new Error('输出排序队列超限');
      while (this.pending.has(this.eventSeq)) {
        const next = this.pending.get(this.eventSeq);
        this.pending.delete(this.eventSeq++);
        this.pendingBytes -= JSON.stringify(next).length;
        this.deliver(next);
      }
      if (!this.pending.size) { clearTimeout(this.gapTimeout); this.gapTimeout = null; }
      else if (!this.gapTimeout) this.gapTimeout = setTimeout(() => this.fail('远程输出缺失，已停止；刷新创建新会话'), 10000);
    } catch (error) {
      this.fail(error.message);
    }
  }

  deliver(message) {
    if (message.type === 'ack') {
      this.lastAckAt = Date.now();
      for (const sequence of this.unacked.keys()) if (sequence <= message.clientSeq) this.unacked.delete(sequence);
      return;
    }
    if (message.type === 'ready') {
      clearTimeout(this.readyTimeout);
      clearInterval(this.heartbeat);
      this.lastAckAt = Date.now();
      this.heartbeat = setInterval(() => {
        if (Date.now() - this.lastAckAt > 30000) return this.fail('远程 Bridge 长时间未确认消息，会话已停止');
        this.send(JSON.stringify({ type: 'heartbeat' }));
      }, 10000);
    }
    if (message.type === 'output') message = { ...message, seq: ++this.outputSeq };
    if (message.type === 'closed') return this.close();
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  cleanup() {
    clearTimeout(this.readyTimeout);
    clearTimeout(this.gapTimeout);
    clearInterval(this.heartbeat);
    this.pending.clear();
    this.unacked.clear();
  }

  fail(message) {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.dispatchEvent(new MessageEvent('error', { data: message }));
    this.close();
  }

  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    if (this.socket?.readyState === WebSocket.OPEN && this.socket.bufferedAmount < 256 * 1024) {
      this.socket.send(JSON.stringify({
        action: this.projectHash ? 'terminal_shared' : 'terminal_poc', v: 1,
        type: this.projectHash ? 'detach' : 'close', terminalId: this.terminalId,
        device: this.device, clientSeq: ++this.clientSeq,
        ...(this.projectHash ? { projectHash: this.projectHash } : {}),
      }));
    }
    this.cleanup();
    if (this.socket) this.socket.close(1000, 'POC page closed');
    else this.readyState = WebSocket.CLOSED;
  }
}
