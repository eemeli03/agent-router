/** The relay must be available for reconciliation, but admission stays closed until it succeeds. */
export async function initializeWorker({codex,agent,waitForTransport=async()=>{},announce=async()=>{},setInitialized=()=>{}}){
  await codex.start();
  await waitForTransport();
  await agent.ready();
  setInitialized();
  await announce();
}
