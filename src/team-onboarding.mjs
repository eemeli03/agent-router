import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { setupPrompt } from './setup-prompt.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const token=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
const providerTitle=p=>p==='codex'?'Codex':'Claude Code';
const slotHash=e=>e.type==='connected'?e.hash:hash(e.value);
const slotProvider=e=>e.type==='connected'?e.provider:e.action_id.replace('ba_team_','');
const slotShape=elements=>elements.map(e=>`${slotProvider(e)}:${e.type==='connected'?'connected':'button'}`);

/** Slack authenticates the person; native login authenticates their provider. */
export class TeamOnboarding {
  cardWork=new Map();
  constructor({store,router,web,team,bot,origin,domains,marketplace,codexPluginUrls}){Object.assign(this,{store,router,web,team,bot,origin,domains,marketplace,codexPluginUrls});}
  async withCard(owner,work){
    const previous=this.cardWork.get(owner)??Promise.resolve();
    const next=previous.catch(()=>{}).then(work);this.cardWork.set(owner,next);
    try{return await next;}finally{if(this.cardWork.get(owner)===next)this.cardWork.delete(owner);}
  }
  async ensurePrompt(member,id,{repeat=false}={}){
    const text='Hi! Give this to your Codex or Claude Code agent👇\n\n```\n'+setupPrompt({marketplace:this.marketplace,origin:this.origin})+'\n```',digest=hash(text),existing=this.store.setupPrompt(id);
    if(!existing&&!repeat){
      const latest=this.store.latestSetupPrompt(member.owner);
      if(latest?.digest===digest&&latest.state==='sent')return latest;
      if(latest&&['sending','unknown'].includes(latest.state))throw Error('Setup prompt delivery is unresolved');
    }
    this.store.reserveSetupPrompt(id,member.owner,digest);
    const saved=this.store.setupPrompt(id);if(saved.state==='sent')return saved;
    if(!this.store.beginSetupPrompt(id))throw Error('Setup prompt delivery is unresolved');
    let sending=false;
    try{
      const dm=await this.web.conversations.open({users:member.owner});
      sending=true;
      const result=await this.web.chat.postMessage({channel:dm.channel.id,text,mrkdwn:true,unfurl_links:false,unfurl_media:false});
      if(!result.ts)throw Error('Setup prompt delivery unconfirmed');
      this.store.finishSetupPrompt(id,'sent',dm.channel.id,result.ts);
    }catch(error){
      const rejected=error.data?.ok===false&&typeof error.data?.error==='string';
      this.store.finishSetupPrompt(id,!sending||rejected?'failed':'unknown');throw error;
    }
    return this.store.setupPrompt(id);
  }
  // Compatibility for already-issued cards; new onboarding uses ensurePrompt.
  cardBlocks(elements){
    const blocks=[{type:'section',text:{type:'mrkdwn',text:'*Set up Agent Router in Codex*\nInstall the plugin, then select Setup to connect your account.'}}];
    const buttons=elements.filter(e=>e.type!=='connected');
    if(buttons.length)blocks.push({type:'actions',elements:buttons});
    for(const e of elements.filter(e=>e.type==='connected'))blocks.push({type:'context',block_id:`ba_connected_${e.provider}_${e.hash}`,elements:[{type:'mrkdwn',text:`:white_check_mark: ${providerTitle(e.provider)} connected`}]});
    return blocks;
  }
  async readCardElements(card){
    const history=await this.web.conversations.history({channel:card.channel,oldest:card.ts,latest:card.ts,inclusive:true,limit:1});
    const message=history.messages?.find(m=>m.ts===card.ts);
    if(message?.user!==this.bot)throw Error('Original setup message is unavailable');
    const elements=message.blocks?.filter(b=>b.type==='actions').flatMap(b=>b.elements)??[];
    for(const b of message.blocks??[]){
      const match=b.type==='context'&&/^ba_connected_(codex|claude)_([a-f0-9]{64})$/.exec(b.block_id??'');
      if(match)elements.push({type:'connected',provider:match[1],hash:match[2]});
    }
    if(elements.length!==2||!['codex','claude'].every(p=>elements.filter(e=>slotProvider(e)===p).length===1))throw Error('Original setup message is unavailable');
    return ['codex','claude'].map(p=>elements.find(e=>slotProvider(e)===p));
  }
  async reconcileCard(card){
    const pending=this.store.teamCardUpdate(card.owner);if(!pending)return card;
    const elements=await this.readCardElements(card);
    const matches=(state,shape)=>['codex','claude'].every(p=>slotHash(elements.find(e=>slotProvider(e)===p))===state[p])&&(!shape||JSON.stringify(slotShape(elements))===JSON.stringify(shape));
    if(matches(pending.after,pending.afterShape))this.store.finishTeamCardUpdate(card.owner,true);
    else if(matches(pending.before,pending.beforeShape))this.store.finishTeamCardUpdate(card.owner,false);
    else throw Error('Setup message update is unresolved');
    return this.store.teamCard(card.owner);
  }
  async cardElements(card){
    const elements=await this.readCardElements(card);
    for(const provider of ['codex','claude']){
      const element=elements.find(e=>slotProvider(e)===provider);
      if(!element||slotHash(element)!==card[`${provider}Hash`])throw Error('Setup message changed');
    }
    return elements;
  }
  async updateCard(card,elements,pairHash){
    const before={},after={};
    const beforeElements=await this.cardElements(card);
    for(const p of ['codex','claude']){before[p]=card[`${p}Hash`];after[p]=slotHash(elements.find(e=>slotProvider(e)===p));}
    this.store.beginTeamCardUpdate(card.owner,{before,after,pairHash,beforeShape:slotShape(beforeElements),afterShape:slotShape(elements)});
    try{
      const result=await this.web.chat.update({channel:card.channel,ts:card.ts,text:'Set up Agent Router in Codex',blocks:this.cardBlocks(elements)});
      if(!result.ts)throw Error('Setup message delivery unconfirmed');
      this.store.finishTeamCardUpdate(card.owner,true);
    }catch(error){
      if(error.data?.ok===false)this.store.finishTeamCardUpdate(card.owner,false);
      throw error;
    }
  }
  async refreshCard(member,card){
    const expired=['codex','claude'].filter(p=>{const t=this.store.teamTicket(card[`${p}Hash`]);return t?.status!=='connected'&&(t?.status==='revoked'||t?.expires<=Date.now());});
    if(!expired.length)return card;
    const elements=await this.cardElements(card);
    for(const provider of expired){
      const index=elements.findIndex(e=>slotProvider(e)===provider),value=randomBytes(32).toString('hex');
      let button=elements[index];
      if(button.type==='connected'){
        button={type:'button',text:{type:'plain_text',text:providerTitle(provider)},action_id:`ba_team_${provider}`,visible_to_user_ids:[member.owner],url:provider==='codex'?(this.codexPluginUrls?.[member.owner]??'codex://plugins'):`${this.origin}/connect#${value}`};
        elements[index]=button;
      }
      this.store.teamIssue({hash:hash(value),...member,provider,expires:Date.now()+30*60_000});
      button.value=value;delete button.confirm;
      if(provider==='claude')button.url=`${this.origin}/connect#${value}`;
    }
    await this.updateCard(card,elements);
    return this.store.teamCard(member.owner);
  }
  async ensureCard(member){
    let card=this.store.teamCard(member.owner);
    if(card?.state==='live')return this.refreshCard(member,await this.reconcileCard(card));
    if(card&&!this.store.retryTeamCard(member.owner))throw Error('Setup message delivery is unresolved');
    if(!card){
      const dm=await this.web.conversations.open({users:member.owner});
      if(!this.store.beginTeamCard(member.owner,dm.channel.id))throw Error('Setup message already being created');
      card=this.store.teamCard(member.owner);
    }
    const elements=['codex','claude'].map(provider=>{
      const value=randomBytes(32).toString('hex');
      this.store.teamIssue({hash:hash(value),...member,provider,expires:Date.now()+30*60_000});
      return{type:'button',text:{type:'plain_text',text:provider==='codex'?'Codex':'Claude Code'},action_id:`ba_team_${provider}`,value,url:provider==='codex'?(this.codexPluginUrls?.[member.owner]??'codex://plugins'):`${this.origin}/connect#${value}`,visible_to_user_ids:[member.owner]};
    });
    try{
      const result=await this.web.chat.postMessage({channel:card.channel,text:'Set up Agent Router in Codex',blocks:this.cardBlocks(elements),unfurl_links:false,unfurl_media:false});
      if(!result.ts)throw Error('Setup message delivery unconfirmed');
      this.store.finishTeamCard(member.owner,{ts:result.ts,codexHash:hash(elements[0].value),claudeHash:hash(elements[1].value)});
    }catch(error){
      this.store.failTeamCard(member.owner,error.data?.ok===false?'failed':'unknown');throw error;
    }
    return this.store.teamCard(member.owner);
  }
  async connectedCard(owner,provider,registration){
    for(const message of this.store.connectedPairMessages(owner,provider,registration)){
      const text=[
        `:white_check_mark: ${providerTitle(provider)} connected`,
        '',
        'Hi! Here are a few things you can ask me to do.',
        '• Summarize a document',
        '• Investigate a problem',
        '• Help with a code change',
        '',
        `Send me a message by tagging me (<@${this.bot}>)!`,
      ].join('\n');
      const result=await this.web.chat.update({channel:message.channel,ts:message.ts,text,blocks:[{type:'section',text:{type:'mrkdwn',text}}]});
      if(result.ts!==message.ts)throw Error('Connection confirmation update unconfirmed');
      this.store.finishPairMessage(message.hash);
    }
    let card=this.store.teamCard(owner);if(!card||card.state!=='live')return;
    card=await this.reconcileCard(card);
    const key=card[`${provider}Hash`],ticket=this.store.teamTicket(key);
    if(ticket?.status!=='connected'||ticket.registration!==registration)return;
    const elements=await this.cardElements(card),index=elements.findIndex(e=>slotProvider(e)===provider);
    if(elements[index].type==='connected')return;
    elements[index]={type:'connected',provider,hash:key};
    await this.updateCard(card,elements);
  }
  async flushConnectedCards(){
    if(this.flushingCards||Date.now()<(this.nextCardAttempt??0))return;
    this.flushingCards=true;
    try{
      for(const item of this.store.pendingCardStatuses()){
        try{
          await this.withCard(item.owner,()=>this.connectedCard(item.owner,item.provider,item.registration));
          this.store.finishCardStatus(item.owner,item.provider,item.registration);
        }catch{this.nextCardAttempt=Date.now()+30_000;}
      }
    }finally{this.flushingCards=false;}
  }
  async eligible(owner){
    const {user}=await this.web.users.info({user:owner});
    const email=user?.profile?.email?.toLowerCase();
    if(!user||user.deleted||user.is_bot||user.is_restricted||user.is_ultra_restricted||!email||!this.domains.includes(email.split('@')[1]))throw Error('Not an eligible workspace member');
    return{owner,email};
  }
  async checkWorker(worker){
    if(!worker?.endpoint.startsWith('relay:'))return true;
    let member;
    try{member=await this.eligible(worker.owner);}catch(error){
      // A network error is not revocation, but no work is admitted without a fresh check.
      if(error.message!=='Not an eligible workspace member')throw error;
      this.router.disableWorker(worker.registration);throw error;
    }
    if(member.email!==worker.email){this.router.disableWorker(worker.registration);throw Error('Membership changed');}
    if(worker.enabled===false)throw Error('Worker disabled');
    return true;
  }
  async requestPluginPair({email,provider,token:value}){
    if(!token(value)||!['codex','claude'].includes(provider)||typeof email!=='string'||email!==email.toLowerCase()||!this.domains.includes(email.split('@')[1]))throw Error('Invalid pairing request');
    const lookup=await this.web.users.lookupByEmail({email});
    const member=await this.eligible(lookup.user?.id);if(member.email!==email)throw Error('Account mismatch');
    const key=hash(value);
    this.store.reservePluginPairing({hash:key,...member,provider,expires:Date.now()+10*60_000});
    const previous=this.store.teamTicket(key);
    if(previous.status==='connected'&&previous.expires>Date.now()){
      const worker=this.router.workers.get(previous.registration);
      if(worker?.owner!==member.owner||worker?.provider!==provider||worker?.enabled===false||worker?.acceptingNew===false)throw Error('Previous connection is no longer active');
      await this.checkWorker(worker);
      return{accepted:true};
    }
    await this.withCard(member.owner,async()=>{
      if(this.store.latestPluginPairing(member.owner,provider)!==key)throw Error('Pairing request was superseded');
      const legacyCard=this.store.teamCard(member.owner);
      if(this.store.teamCardUpdate(member.owner)?.pairHash===key&&legacyCard)await this.reconcileCard(legacyCard);
      if(this.store.pluginPairDelivery(key)==='sent'){
        // Preserve approvals already offered by older plugin versions.
        if(!this.store.pluginPairMessage(key)){
          const card=this.store.teamCard(member.owner);
          if(card?.[`${provider}Hash`]!==key)throw Error('Pairing request was superseded');
        }
        return;
      }
      if(!this.store.beginPluginPairDelivery(key))throw Error('Slack confirmation delivery is unresolved');
      let sending=false;
      try{
        const dm=await this.web.conversations.open({users:member.owner});
        const title=providerTitle(provider);
        const button={type:'button',text:{type:'plain_text',text:'Connect'},action_id:`ba_team_${provider}`,value,visible_to_user_ids:[member.owner],confirm:{title:{type:'plain_text',text:`Connect ${title}`},text:{type:'plain_text',text:`Connect your ${title} account to Agent Router?`},confirm:{type:'plain_text',text:'Connect'},deny:{type:'plain_text',text:'Cancel'}}};
        sending=true;
        const result=await this.web.chat.postMessage({channel:dm.channel.id,text:`Connect your ${title} account to Agent Router`,blocks:[{type:'section',text:{type:'mrkdwn',text:`Connect your *${title}* account to Agent Router?`}},{type:'actions',block_id:`ba_pair_${key}`,elements:[button]}],unfurl_links:false,unfurl_media:false});
        if(!result.ts)throw Error('Slack confirmation delivery unconfirmed');
        this.store.savePluginPairMessage(key,dm.channel.id,result.ts);
        this.store.finishPluginPairDelivery(key,'sent');
      }catch(error){
        const rejected=error.data?.ok===false&&typeof error.data?.error==='string';
        this.store.finishPluginPairDelivery(key,!sending||rejected?'failed':'unknown');
        throw error;
      }
    });
    return{accepted:true};
  }
  async handleEvent(body){
    const e=body?.event;if(body?.team_id!==this.team||!e?.user||e.bot_id||e.subtype||!['message','app_mention'].includes(e.type))return false;
    const text=e.text?.replace(new RegExp(`<@${this.bot}(?:\\|[^>]+)?>`,'g'),'').trim();
    const setup=/^\/?(?:setup|connect|yhdistä)$/i.test(text??'');
    const binding=this.store.binding(e.channel,e.thread_ts??e.ts);
    if(binding&&binding.owner!==e.user)return true;
    if(!setup){
      if(binding||this.router.workerFor(e.user))return false;
      if(e.channel_type!=='im'&&!new RegExp(`<@${this.bot}(?:\\|[^>]+)?>`).test(e.text??''))return false;
    }
    let member;try{member=await this.eligible(e.user);}catch{return true;}
    await this.withCard(member.owner,()=>this.ensurePrompt(member,`${this.team}:${e.channel}:${e.ts}`,{repeat:setup}));
    return true;
  }
  async authorize(body){
    if(body?.team?.id!==this.team)return false;
    const a=body.actions?.[0];if(!token(a?.value))return false;
    const ticket=this.store.teamTicket(hash(a.value));
    if(!ticket||ticket.status==='revoked'||ticket.owner!==body?.user?.id||ticket.expires<=Date.now()||a.action_id!==`ba_team_${ticket.provider}`)return false;
    return this.withCard(ticket.owner,async()=>{
      const message=this.store.pluginPairMessage(ticket.hash);
      if(message){
        if(this.store.pluginPairDelivery(ticket.hash)!=='sent'||this.store.latestPluginPairing(ticket.owner,ticket.provider)!==ticket.hash||body.channel?.id!==message.channel||body.message?.ts!==message.ts)return false;
      }else{
        const latest=this.store.teamTicket(this.store.latestPluginPairing(ticket.owner,ticket.provider)??'');
        if(latest&&latest.status!=='revoked'&&latest.hash!==ticket.hash&&latest.expires>Date.now())return false;
        let card=this.store.teamCard(ticket.owner);
        if(card)card=await this.reconcileCard(card);
        if(!card||card.state!=='live'||card[`${ticket.provider}Hash`]!==ticket.hash||body.channel?.id!==card.channel||body.message?.ts!==card.ts)return false;
      }
      const member=await this.eligible(ticket.owner);if(member.email!==ticket.email||ticket.expires<=Date.now())return false;
      if(ticket.status==='offered')this.store.teamStatus(ticket.hash,'offered','authorized');
      const worker=[...this.router.workers.values()].find(w=>w.owner===ticket.owner&&w.provider===ticket.provider&&w.enabled!==false&&w.acceptingNew!==false);
      // Opening the plugin page is not a completed Setup attempt.
      // Reuse an existing connection only after the native helper requested pairing.
      if(worker&&this.store.pluginPairDelivery(ticket.hash)==='sent'){
        await this.checkWorker(worker);this.router.selectProvider(ticket.owner,ticket.provider);
        this.store.teamSelect(ticket.hash,worker.registration);
        this.store.queueCardStatus(ticket.owner,ticket.provider,worker.registration);
      }
      return true;
    });
  }
  ticket(value){
    if(!token(value))throw Error('Invalid ticket');
    const t=this.store.teamTicket(hash(value));
    if(!t||t.expires<=Date.now()||!['authorized','claimed','connected'].includes(t.status))throw Error('Expired or unapproved ticket');
    return t;
  }
  status({token:value}){const t=this.ticket(value);return{provider:t.provider,status:t.status};}
  async claim({token:value,deviceSecret}){
    if(!token(deviceSecret))throw Error('Invalid device secret');
    let t=this.ticket(value);const member=await this.eligible(t.owner);
    t=this.ticket(value);if(member.email!==t.email)throw Error('Membership changed');
    if(t.registration){if(t.secretHash!==hash(deviceSecret))throw Error('Already claimed');return this.claimResponse(t);}
    // Existing conversations never migrate to a new device silently.
    if(this.router.workerFor(t.owner)&&[...this.router.workers.values()].some(w=>w.owner===t.owner&&w.provider===t.provider&&w.acceptingNew!==false))throw Error('Provider already connected. Contact the workspace owner to add another device.');
    const previous=this.store.teamEnrollment(t.owner,t.provider);
    if(previous&&previous.hash!==t.hash)throw Error('A setup is already in progress for this account');
    const registration=randomUUID();
    this.store.teamClaim(t.hash,registration,hash(deviceSecret));
    return this.claimResponse({...t,registration});
  }
  claimResponse(t){return{team:this.team,bot:this.bot,owner:t.owner,email:t.email,provider:t.provider,registration:t.registration};}
  async ready(registration,body){
    const t=this.store.teamRegistration(registration);
    if(!t||!['claimed','connected'].includes(t.status)||(t.status==='claimed'&&t.expires<=Date.now()))throw Error('Enrollment not available');
    const member=await this.eligible(t.owner);
    if(member.email!==t.email||body?.email!==t.email||body?.provider!==t.provider)throw Error('Provider account mismatch');
    if(t.status==='connected'){
      const existing=this.router.workers.get(registration);
      if(!existing?.enabled)throw Error('Worker disabled');
      this.store.queueCardStatus(t.owner,t.provider,registration);
      return{ready:true};
    }
    const found=this.router.workers.get(registration);
    if(found){this.store.teamStatus(t.hash,'claimed','connected');this.router.selectProvider(t.owner,t.provider);this.store.queueCardStatus(t.owner,t.provider,registration);return{ready:true};}
    const worker={owner:t.owner,email:t.email,provider:t.provider,registration,endpoint:`relay:${registration}`,secret:randomBytes(32).toString('hex'),enabled:true};
    this.router.addWorker(worker);this.store.teamStatus(t.hash,'claimed','connected');this.router.selectProvider(t.owner,t.provider);
    this.store.queueCardStatus(t.owner,t.provider,registration);
    return{ready:true};
  }
}
