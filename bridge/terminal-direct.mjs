import { DirectDataChannel } from './terminal-direct-protocol.mjs';
import { createTerminalRemote } from './terminal-remote.mjs';

export function createTerminalDirect(options) {
  let active = null;
  const manager = createTerminalRemote({ ...options, send(message) {
    return active?.channel.readyState === 1 && active.channel.send(message);
  } });

  function clear(notify = true) {
    if (!active) return;
    const previous = active;
    active = null;
    manager.closeAll();
    previous.channel.close();
    if (notify) options.sendControl({ action: 'terminal_direct', v: 1, op: 'close', terminalId: previous.id });
  }

  return {
    handle(message) {
      if (message.action !== 'terminal_direct' || message.v !== 1) return;
      if (message.type === 'offer') {
        if (active || message.device !== options.device || message.side !== 'bridge') return;
        const channel = new DirectDataChannel({ endpoint: options.endpoint, key: options.key,
          offer: message, socketFactory: options.socketFactory });
        active = { id: message.terminalId, channel };
        channel.addEventListener('message', event => manager.handle(JSON.parse(event.data)));
        channel.addEventListener('error', () => clear());
        channel.addEventListener('close', () => clear());
      } else if (active?.id === message.terminalId) {
        if (message.type === 'ready') active.channel.authorize(message);
        else if (message.type === 'error' || message.type === 'closed') clear(false);
      }
    },
    closeAll() { clear(false); },
    dispose() { clear(); manager.dispose(); },
  };
}
