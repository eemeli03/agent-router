import { build } from 'esbuild';
import { mkdir, writeFile, cp } from 'node:fs/promises';

const version = '1.0.0';
const titleByProvider = { codex: 'Codex', claude: 'Claude Code' };
const providers = Object.keys(titleByProvider);
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

for (const provider of providers) {
  const name = `router-${provider}`;
  const title = titleByProvider[provider];
  const root = `plugins/${name}`;
  for (const folder of ['scripts', '.claude-plugin', 'skills/connect']) {
    await mkdir(`${root}/${folder}`, { recursive: true });
  }
  for (const entry of ['setup', 'worker']) {
    await build({
      entryPoints: [`src/${entry === 'setup' ? 'setup-cli' : entry}.mjs`],
      outfile: `${root}/scripts/${entry}.mjs`, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      banner: { js: 'import { createRequire as __routerCreateRequire } from "node:module";const require=__routerCreateRequire(import.meta.url);' },
    });
  }
  const description = `Connect your own ${title} account to Slack through your self-hosted Agent Router.`;
  const author = { name: 'Agent Router' };
  const overlay = {
    onboardingSkill: './skills/connect/SKILL.md',
    interface: { displayName: `Agent Router for ${title}`, shortDescription: 'Your personal coding agent in Slack', category: 'Productivity', capabilities: ['Read', 'Write'] },
  };
  await writeJson(`${root}/plugin.json`, { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name, version, description, author, extensions: { 'com.openai': overlay } });
  await writeJson(`${root}/.claude-plugin/plugin.json`, { name, version, description, author, skills: './skills/' });
  await cp('scripts/plugin-run.sh', `${root}/scripts/run.sh`);
  await writeFile(`${root}/skills/connect/SKILL.md`, `---
name: connect
description: Connect your own ${title} account to Slack through a relay you trust.
---

Use the HTTPS relay origin supplied by the person's workspace operator and the absolute local workspace path the person chose. Ask for either if missing. The connector supports macOS and requires the person's own signed-in ${title} account. It uses the selected workspace for future Slack requests.

Run this plugin's scripts/run.sh with bash, --provider ${provider}, --origin, --workspace and --pair. Resolve scripts/run.sh two directories above this skill. For an existing private setup link supplied by the person, use its relay origin and use --ticket with the link fragment in place of --pair. Keep setup links and tickets private.

The helper checks the signed-in account and sends the Slack Connect request. Keep it running while the person approves. Report a connection only after the helper confirms it. Preserve existing devices, histories and credentials.
`);
}

const entries = providers.map(provider => ({ name: `router-${provider}`, path: `./plugins/router-${provider}` }));
await mkdir('.agents/plugins', { recursive: true });
await mkdir('.claude-plugin', { recursive: true });
await writeJson('.agents/plugins/marketplace.json', {
  name: 'agent-router', interface: { displayName: 'Agent Router' },
  plugins: entries.map(entry => ({ name: entry.name, source: { source: 'local', path: entry.path }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' })),
});
await writeJson('.claude-plugin/marketplace.json', {
  name: 'agent-router', owner: { name: 'Agent Router' },
  plugins: entries.map(entry => ({ name: entry.name, source: entry.path, description: 'Personal coding agent in Slack' })),
});
