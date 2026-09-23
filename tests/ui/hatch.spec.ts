import {test,expect} from '@playwright/test';
import {readFileSync} from 'node:fs';
const demo=JSON.parse(readFileSync('private/verification/demo-state.json','utf8'));
for(const reduced of [false,true])test('known result reveal '+(reduced?'reduced motion':'animated'),async({page})=>{
 await page.emulateMedia({reducedMotion:reduced?'reduce':'no-preference'});
 await page.route('https://data.cs2chickens.fun/state.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...demo,updatedAt:Math.floor(Date.now()/1000)})}));
 await page.route('https://rpc.mainnet.chain.robinhood.com/**',route=>route.abort());
 await page.setViewportSize({width:320,height:640});
 await page.goto('/incubator/');
 await expect(page.locator('.nest-chicken img')).toHaveAttribute('alt',demo.incubator.result.variant.split('-').join(' '),{timeout:6000});
 await expect(page.locator('.proof')).toContainText('VERIFIED');
 await page.getByRole('button',{name:'REPLAY HATCH'}).click();
 await expect(page.locator('.nest-chicken img')).toBeVisible({timeout:6000});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('stale data remains visible with warning',async({page})=>{
 await page.route('https://data.cs2chickens.fun/state.json',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({...demo,updatedAt:1})}));
 await page.route('https://rpc.mainnet.chain.robinhood.com/**',route=>route.abort());
 await page.goto('/');await expect(page.getByRole('status')).toContainText('Data delayed');await expect(page.locator('.race')).toContainText('CATALANA');
});
