import test from 'node:test';
import assert from 'node:assert/strict';
import {payoutBatches} from '../src/batches';
import type {Address} from 'viem';
test('multisend splits at 200 unique wallets and conserves categories',()=>{
 const rows=Array.from({length:401},(_,i)=>({wallet:('0x'+(i+1).toString(16).padStart(40,'0')) as Address,amountWei:'10'}));
 rows.push({...rows[0],amountWei:'5'});
 const batches=payoutBatches(rows);assert.deepEqual(batches.map(b=>b.to.length),[200,200,1]);assert.equal(batches.reduce((s,b)=>s+b.value,0n),4015n);assert.equal(batches[0].hash,payoutBatches([...rows].reverse())[0].hash);
});
