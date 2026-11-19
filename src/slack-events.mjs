/** Slack transport acknowledgments are distinct from account/work authorization. */
export function createSlackEventHandler({team,router,store,onboarding,teamOnboarding,pilotOwner,log=console.error}){
 return async({type,body,ack})=>{
  const setupAction=type==='interactive'&&/^ba_team_(codex|claude)$/.test(body?.actions?.[0]?.action_id??'');
  try{
   if(setupAction)await ack();
   if(type==='events_api'){
    const e=body?.event;
    if(body?.team_id!==team||!e?.user||e.bot_id||e.subtype||!['message','app_mention'].includes(e.type)){await ack();return;}
    if(!teamOnboarding&&onboarding&&e.user===pilotOwner&&/^\s*(?:<@[^>]+>\s*)?\/?(?:setup|connect|yhdistä)\s*$/i.test(e.text??'')){
     await ack();await onboarding.handleEvent(body);return;
    }
    if(teamOnboarding&&await teamOnboarding.handleEvent(body)){await ack();return;}
    const binding=store.binding(e.channel,e.thread_ts??e.ts),selected=router.workerFor(e.user,binding);
    if(selected?.endpoint.startsWith('relay:'))await teamOnboarding.checkWorker(selected);
    router.admit(body);
   }
   if(type==='interactive'&&!onboarding?.authorize(body)&&!await teamOnboarding?.authorize(body)){
    const binding=store.binding(body.channel?.id,body.message?.thread_ts??body.message?.ts);
    const selected=binding?router.workers.get(binding.registration):null;
    if(selected?.endpoint.startsWith('relay:'))await teamOnboarding.checkWorker(selected);
    router.admitAction(body);
   }
   if(!setupAction)await ack();
   void router.flush();
  }catch(error){log('Slack envelope not admitted',type,error?.name??'Error',error?.code??error?.data?.error??'');}
 };
}
