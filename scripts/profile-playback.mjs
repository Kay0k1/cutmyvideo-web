// Run against an already served release build: PROBE_URL=http://127.0.0.1:4173 node scripts/profile-playback.mjs
// This controlled player measures editor work only, not video decoding.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({headless: true});
const page = await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',error=>console.error(error.message));
await page.clock.install();
await page.addInitScript(() => {
  const counts = { app:0, timeline:0, player:0, writes:0, keydownAdds:0, polls:0 };
  window.__perfCounts = counts;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(), inject:()=>1, onScheduleFiberRoot:()=>{},
    onCommitFiberRoot: (_, root) => {
      const visit = fiber => {
        if (!fiber) return;
        const name = fiber.type?.name ?? fiber.type?.render?.name;
        if ((fiber.flags & 1) && name === 'App') counts.app++;
        if ((fiber.flags & 1) && name === 'Timeline') counts.timeline++;
        visit(fiber.child); visit(fiber.sibling);
      }; visit(root.current);
    }, onCommitFiberUnmount:()=>{},
  };
  const write = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key,value) { if(key === 'cutmy.workbench.v1') counts.writes++; return write.call(this,key,value); };
  const add = window.addEventListener;
  window.addEventListener = function(type,...args) { if(type === 'keydown') counts.keydownAdds++; return add.call(this,type,...args); };
  window.YT = { Player: class {
    time = 0; state = 1;
    constructor(element, options) { this.options=options; queueMicrotask(()=>options.events.onReady({target:this})); }
    seekTo(time) {this.time=time;}
    playVideo() {this.state=1;}
    pauseVideo() {this.state=2;}
    getCurrentTime() {counts.polls++; if(this.state===1) this.time+=.15; return this.time;}
    getPlayerState() {return this.state;}
    destroy() {}
  }};
});
await page.route('**/api/v1/session', r=>r.fulfill({json:{ok:true}}));
await page.route('**/api/v1/sources', r=>r.fulfill({status:201,json:{id:'source_perf',title:'Performance fixture',kind:'youtube',provider:'youtube',duration_ms:1200000,preview_url:null,embed_url:'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',thumbnail_url:null}}));
await page.goto(process.env.PROBE_URL || 'http://127.0.0.1:5173');
await page.getByLabel('Ссылка на видео',{exact:true}).fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
await page.getByRole('button',{name:'Открыть видео',exact:true}).click();
await page.getByRole('button',{name:'Посмотреть фрагмент',exact:true}).waitFor();
await page.clock.runFor(1200);
await page.evaluate(()=>{for(const key of Object.keys(window.__perfCounts)) window.__perfCounts[key]=0;});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.collectGarbage');
await cdp.send('HeapProfiler.startSampling', {samplingInterval:16384,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
const before = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
await page.clock.runFor(15000);
const counts = await page.evaluate(()=>window.__perfCounts);
const after = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
const {profile} = await cdp.send('HeapProfiler.stopSampling');
const allocated = node=>node.selfSize+node.children.reduce((total,child)=>total+allocated(child),0);
await cdp.send('HeapProfiler.collectGarbage');
const retained = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
// Component names are minified in production; app/timeline counters only apply to development builds.
console.log(JSON.stringify({...counts,cpuTaskMs:(after.TaskDuration-before.TaskDuration)*1000,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,sampledAllocationBytes:allocated(profile.head),retainedHeapBytes:retained.JSHeapUsedSize,retainedHeapDelta:retained.JSHeapUsedSize-before.JSHeapUsedSize}));
await browser.close();
