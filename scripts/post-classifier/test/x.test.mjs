import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractPost, mountX } from '../src/platforms/x.js';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
test('X adapter targets outer permalink, waits for UI change, supports virtualized articles',async()=>{
  const dom=new JSDOM(`<article data-testid="tweet"><a href="/outer/status/123"><time>today</time></a><div data-testid="tweetText">Outer</div><a href="/quote/status/999">Quote</a><div role="group"><button data-testid="like">Like</button><button data-testid="bookmark">Bookmark</button></div></article>`,{url:'https://x.com/outer',pretendToBeVisual:true});
  for(const name of ['document','MutationObserver','requestAnimationFrame']) globalThis[name]=name==='requestAnimationFrame'?dom.window[name].bind(dom.window):dom.window[name];
  const calls=[], opened=[];
  const adapter=mountX({label:()=>'+ 分类',async changedAction(...args){calls.push(args);},async openPicker(...args){opened.push(args);},onError:e=>{throw e;}});
  try {
    const article=document.querySelector('article'); assert.equal(extractPost(article).id,'x:123');
    const button=article.querySelector('[data-testid=like]'); button.getBoundingClientRect=()=>({left:100,right:140,top:100,bottom:140}); button.click(); await pause(350); assert.equal(calls.length,0);
    button.dataset.testid='unlike'; await pause(200); assert.equal(calls[0][0].id,'x:123'); assert.equal(calls[0][2],true); assert.equal(opened.length,0);
    document.querySelector('#jingyu-classify-hint').shadowRoot.querySelector('button').click(); await pause(10); assert.equal(opened.length,1);
    button.click(); button.dataset.testid='like'; await pause(300); assert.equal(document.querySelector('#jingyu-classify-hint'),null);
    button.click(); button.dataset.testid='unlike'; await pause(300); assert.ok(document.querySelector('#jingyu-classify-hint'));
    button.click(); assert.equal(document.querySelector('#jingyu-classify-hint'),null); button.dataset.testid='like';
    article.querySelector('a').href='/outer/status/456'; await pause(50);
    article.querySelector('[data-jingyu-post]').shadowRoot.querySelector('button').click(); await pause(10); assert.equal(opened.at(-1)[0].id,'x:456');
    assert.equal(article.querySelectorAll('[data-jingyu-post]').length,1);
  } finally {adapter.destroy();dom.window.close();}
});
