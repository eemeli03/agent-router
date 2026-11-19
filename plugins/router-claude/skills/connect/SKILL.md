---
name: connect
description: Connect your own Claude Code account to Slack through a relay you trust.
---

Use the HTTPS relay origin supplied by the person's workspace operator and the absolute local workspace path the person chose. Ask for either if missing. The connector supports macOS and requires the person's own signed-in Claude Code account. It uses the selected workspace for future Slack requests.

Run this plugin's scripts/run.sh with bash, --provider claude, --origin, --workspace and --pair. Resolve scripts/run.sh two directories above this skill. For an existing private setup link supplied by the person, use its relay origin and use --ticket with the link fragment in place of --pair. Keep setup links and tickets private.

The helper checks the signed-in account and sends the Slack Connect request. Keep it running while the person approves. Report a connection only after the helper confirms it. Preserve existing devices, histories and credentials.
