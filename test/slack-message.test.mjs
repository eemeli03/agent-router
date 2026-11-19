import test from 'node:test';
import assert from 'node:assert/strict';
import {slackMessage} from '../src/slack-message.mjs';

test('model Markdown reaches Slack native rendering without lossy replacements',()=>{
 const text='## Findings\n\n- **Separate workspace and project rules.** Keep `**literal**` intact.\n- [Guide](https://example.com/guide?id=1&lang=en)\n\n| Status | Count |\n| --- | --- |\n| Ready | 2 |\n\n```js\nconst text = "**unchanged**";\n```';
 const payload=slackMessage(text);
 assert.deepEqual(payload.blocks,[{type:'markdown',text}]);
 assert.equal(payload.text,text);
 assert.equal(payload.reply_broadcast,false);
 assert.equal(payload.unfurl_links,false);
});

test('approval payload remains plain with its original owner-bound buttons',()=>{
 const text='{"command":"echo **literal**"}\nUse the buttons on this approval request.';
 const payload=slackMessage(text,'nonce');
 assert.deepEqual(payload.blocks[0],{type:'section',text:{type:'plain_text',text}});
 assert.deepEqual(payload.blocks[1].elements.map(e=>[e.action_id,e.value]),[['owner_approve','nonce'],['owner_decline','nonce']]);
 assert.equal(payload.blocks.some(b=>b.type==='markdown'),false);
});
