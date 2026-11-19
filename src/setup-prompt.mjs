export function setupPrompt({ marketplace, origin }) {
  return `Connect my account to Agent Router in Slack. Install the matching plugin from ${marketplace} and run its connect skill with relay ${origin}. Ask me which local workspace to use. Keep setup running while I approve Connect in Slack, preserve my history and confirm when the connector is ready.`;
}
