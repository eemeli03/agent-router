# Agent Router

Use your own Codex or Claude Code account from Slack. Each Slack thread has its own session.

## Run your own instance

1. Create a Slack app from [`manifest.json`](manifest.json), install it in your workspace, and enable Socket Mode. Get the bot token from **OAuth & Permissions** and create an app-level token with `connections:write` under **Basic Information**. Get the workspace ID and the bot's **user ID** from Slack's `auth.test` response using your bot token.
2. On your router host, install Node.js 26 and run `npm ci` and `npm run build:relay`. In your own Cloudflare account, deploy the relay and add a secret generated with `openssl rand -hex 32`. Use your chosen Worker name in both commands.

   ```sh
   npx wrangler deploy --config relay/wrangler.jsonc --name '<your-worker>'
   npx wrangler secret put ROUTER_SECRET --config relay/wrangler.jsonc --name '<your-worker>'
   ```

3. Create a router JSON file outside the repository with permissions `0600`. Replace every angle-bracket placeholder with your own value. The relay origin must be HTTPS with no trailing slash. List only email domains you intend to let enroll in your Slack workspace. Use the GitHub `owner/repo` that provides your plugin marketplace.

   ```json
   {
     "team": "<slack-workspace-id>",
     "bot": "<slack-bot-user-id>",
     "botToken": "<slack-bot-token>",
     "appToken": "<slack-app-level-token>",
     "socket": "<absolute-private-socket-path>",
     "state": "<absolute-private-sqlite-path>",
     "workers": [],
     "relay": {
       "origin": "<your-https-relay-origin>",
       "secret": "<same-value-as-ROUTER_SECRET>",
       "domains": ["<allowed-email-domain>"],
       "marketplace": "<owner/repo>"
     }
   }
   ```

4. Start the router with `npm run start:router -- /absolute/path/to/router.json`. Keep the router and the connector's Mac running.

## Connect your Mac

Sign in to Codex or Claude Code with the same email you use in Slack. Send `setup` to your Slack app and paste its reply into your agent. It will ask for the local folder to work in, run the plugin's `connect` skill and wait for you to approve **Connect** in Slack.

To install the matching plugin manually, add the same marketplace you configured above.

- **Codex** `codex plugin marketplace add <owner/repo>` followed by `codex plugin add router-codex@agent-router`.
- **Claude Code** `/plugin marketplace add <owner/repo>` followed by `/plugin install router-claude@agent-router`.

Run `npm run build:plugins` to rebuild the checked-in plugins before distributing modified source. Run `npm test` to check the router, relay and pairing flow locally. Keep tokens, private configuration and connector state out of Git.
