/** Slack translates standard model Markdown into native rich-text blocks. */
export function slackMessage(text,prompt=null){
  const blocks=prompt?[
    {type:'section',text:{type:'plain_text',text:text.slice(0,2900)}},
    {type:'actions',elements:[
      {type:'button',text:{type:'plain_text',text:'Approve'},action_id:'owner_approve',value:prompt},
      {type:'button',text:{type:'plain_text',text:'Decline'},action_id:'owner_decline',value:prompt},
    ]},
  ]:[{type:'markdown',text}];
  return{text,blocks,reply_broadcast:false,unfurl_links:false,unfurl_media:false};
}
