import test from 'node:test';
import assert from 'node:assert/strict';
import {identityPostgresUrl} from './fixtures/identity/postgres.ts';

test('native identity fixture refuses production, remote and ambiguous URLs before connecting',()=>{
 const valid='postgresql://weiwu_test:synthetic@127.0.0.1:54321/weiwu_identity_test_'+'a'.repeat(32);
 assert.equal(identityPostgresUrl(valid),valid);
 for(const value of ['',valid.replace('127.0.0.1','db.example'),valid.replace('weiwu_identity_test_','production_'),valid.replace('weiwu_test:synthetic','postgres:synthetic'),valid.replace(':synthetic',''),valid+'?options=-csearch_path%3Dpublic',valid+'#override',valid.replace(':54321',':0')])assert.throws(()=>identityPostgresUrl(value));
});
