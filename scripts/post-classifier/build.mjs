import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const header = `// ==UserScript==
// @name         Jingyu 帖子分类
// @namespace    https://tools.jingyu.dev/post-classifier
// @version      0.1.2
// @description  点赞和收藏共享多分类，本地保存，可登录 tools 同步
// @homepageURL  https://github.com/zhuyuy/jingyu-scripts/tree/master/scripts/post-classifier
// @updateURL    https://raw.githubusercontent.com/zhuyuy/jingyu-scripts/master/scripts/post-classifier/dist/post-classifier.user.js
// @downloadURL  https://raw.githubusercontent.com/zhuyuy/jingyu-scripts/master/scripts/post-classifier/dist/post-classifier.user.js
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_registerMenuCommand
// @connect      tools.jingyu.dev
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==`;
await mkdir('dist', { recursive: true });
const result = await build({ entryPoints: ['src/main.js'], bundle: true, format: 'iife', target: ['chrome109', 'firefox115'], write: false });
await writeFile('dist/post-classifier.user.js', header + '\n' + result.outputFiles[0].text);
await writeFile('dist/preview.js', result.outputFiles[0].text);
console.log('Built dist/post-classifier.user.js and dist/preview.js');
