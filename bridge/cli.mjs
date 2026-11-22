// Informational flags answered before the Bridge touches config, the instance lock or the network.

export const USAGE = [
  'Usage: node bridge.mjs [options]',
  '',
  'Options:',
  '  --server URL        Baton server URL; saved to config.json together with --key',
  '  --key API_KEY       Baton API key; saved to config.json together with --server',
  '  --name DEVICE_NAME  Device name used when no config.json exists yet',
  '  --skip-init         Sync session metadata on startup without uploading message history',
  '  --version           Print the Bridge version and exit',
  '  --help              Print this help and exit',
  '',
].join('\n');

// --help wins over --version; any other argument is ignored.
export function cliInfoOutput(args, version) {
  if (args.includes('--help')) return USAGE;
  if (args.includes('--version')) return `${version}\n`;
  return null;
}
