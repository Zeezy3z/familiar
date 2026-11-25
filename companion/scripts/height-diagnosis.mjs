import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
const { chromium } = await import(pathToFileURL(process.env.FAMILIAR_QA_MODULE).href);
const browser = await chromium.launch();
try {
  for (const sha of ['5a8baeccc1171c69c095c1ae2c06f9b48936afc8','28510ed60667a52012d26bbe416dd4f4166e2b2d']) {
    const tree = mkdtempSync(join(tmpdir(),'glass-'));
    execFileSync('git',['fetch','--depth=1','origin',sha]);
    execFileSync('git',['worktree','add','--detach',tree,sha]);
    const cwd = join(tree,'companion');
    symlinkSync(resolve('node_modules'),join(cwd,'node_modules'),'dir');
    execFileSync(process.execPath,['scripts/build.mjs'],{cwd,stdio:'inherit'});
    const server=spawn(process.execPath,['scripts/preview.mjs'],{cwd,stdio:['ignore','pipe','inherit']});
    const context=await browser.newContext({viewport:{width:730,height:603},reducedMotion:'reduce'});
    try {
      await Promise.race([once(server.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(Error('server startup')),5000))]);
      await context.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:47812'?route.continue():route.abort());
      const page=await context.newPage();
      await page.goto('http://127.0.0.1:47812/control.html?scenario=linked');
      await page.waitForFunction(()=>window.preview?.state && document.getElementById('journey-title')?.textContent);
      const measure=()=>page.evaluate(()=>({height:document.documentElement.scrollHeight,width:document.documentElement.scrollWidth,
        sections:[...document.querySelectorAll('header,main>.card,main>#status')].filter(e=>e.offsetHeight).map(e=>[e.id,e.offsetHeight]),
        rows:[...document.querySelectorAll('.set')].filter(e=>e.offsetHeight).map(e=>[e.querySelector('label')?.textContent,e.offsetHeight])}));
      const initial=await measure();
      console.log('UNMODIFIED',sha,JSON.stringify(initial));
      // Measure the contribution of vertical card padding without changing any test or source.
      await page.addStyleTag({content:'.card { padding-block: 6px }'});
      console.log('PADDING EXPERIMENT',sha,JSON.stringify(await measure()));
      if(initial.height>603*1.7) process.exitCode=1;
    } finally {
      await context.close(); const stopped=once(server,'exit');server.kill();await stopped;
    }
  }
} finally {await browser.close();}
