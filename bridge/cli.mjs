import fs from 'fs';
import { BRIDGE_VERSION } from './version.mjs';

export const USAGE = [
  'Usage: node bridge.mjs [options]',
  '',
  'Options:',
  '  --server URL        Server API URL; saved to the Bridge config together with --key',
  '  --key API_KEY       API key for the server; saved to the Bridge config together with --server',
  '  --name DEVICE_NAME  Device name used the first time the config is created (default: host name)',
  '  --skip-init         Sync session metadata on startup but skip uploading historical messages',
  '  --version           Print the Bridge version and exit',
  '  --help              Print this help and exit',
  '',
].join('\n');

export function cliInfoOutput(args) {
  if (args.includes('--help')) return USAGE;
  if (args.includes('--version')) return `${BRIDGE_VERSION}\n`;
  return null;
}

// Runs before any other Bridge module is evaluated, so these flags never touch config or network.
export function handleInfoFlags(args = process.argv.slice(2)) {
  const output = cliInfoOutput(args);
  if (output === null) return;
  fs.writeSync(1, output);
  process.exit(0);
}
