import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setup, detectBinary } from './setup.mjs';
import { validateWorkspace } from './setup-utils.mjs';
import { providerEmail, requestPluginPairing, completePluginPairing } from './plugin-pairing.mjs';

async function run() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, pair: { type: 'boolean' }, ticket: { type: 'string' },
    provider: { type: 'string' }, origin: { type: 'string' }, workspace: { type: 'string' },
  } });
  if (values.help) {
    console.log('Agent Router setup --origin HTTPS_ORIGIN --workspace ABSOLUTE_PATH [--provider codex|claude --pair | --ticket SLACK_TICKET]');
    return;
  }
  if (!values.origin) throw Error('Provide your operator’s HTTPS relay origin with --origin.');
  const address = new URL(values.origin);
  if (address.protocol !== 'https:' || address.origin !== values.origin) throw Error('An HTTPS origin without a path is required.');
  const workspace = await validateWorkspace(values.workspace);
  const { origin, provider } = values;
  let ticket = values.ticket;
  if (Boolean(values.pair) === Boolean(ticket)) throw Error('Choose exactly one pairing method.');
  if (provider && !['codex', 'claude'].includes(provider)) throw Error('Choose Codex or Claude Code.');

  let pairing;
  if (values.pair) {
    if (!provider) throw Error('Choose Codex or Claude Code with --provider.');
    const email = await providerEmail(provider, await detectBinary(provider), workspace);
    const pair = await requestPluginPairing({ origin, provider, email });
    ticket = pair.ticket;
    pairing = { origin, provider, email, ticket };
    if (pair.status === 'connected') {
      console.log('This account already has an Agent Router connection. Its device and sessions were preserved.');
      return;
    }
  }
  await setup({ origin, ticket, workspace, expectedProvider: provider, runtimeRoot: dirname(fileURLToPath(import.meta.url)) });
  if (pairing) await completePluginPairing(pairing);
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
