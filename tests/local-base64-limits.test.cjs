const test=require('node:test');
const assert=require('node:assert/strict');
const {decodeFiles}=require('../apps/desktop/local-executor.cjs');
test('a supported five MiB file decodes without recursive-regex overflow',()=>{
 const bytes=Buffer.alloc(5*1024*1024,0x61);
 const decoded=decodeFiles([{path:'large.bin',content:bytes.toString('base64')}]);
 assert.deepEqual(decoded[0].bytes,bytes);
 assert.throws(()=>decodeFiles([{path:'large.bin',content:Buffer.alloc(bytes.length+1).toString('base64')}]),{code:'LOCAL_FILE_LIMIT'});
});
test('canonical base64 rejects hidden padding bits, whitespace and incomplete groups',()=>{
 assert.equal(decodeFiles([{path:'empty.txt',content:''}])[0].bytes.length,0);
 for(const content of ['YR==','YQ=','YQ===','YQ==\n','YQ$='])assert.throws(()=>decodeFiles([{path:'file.txt',content}]),{code:'LOCAL_SCOPE_DENIED'});
 assert.equal(decodeFiles([{path:'file.txt',content:'YQ=='}])[0].bytes.toString(),'a');
});
test('aggregate decoding retains the twenty MiB limit',()=>{
 const content=Buffer.alloc(5*1024*1024).toString('base64');
 const files=Array.from({length:4},(_,n)=>({path:n+'.bin',content}));
 assert.equal(decodeFiles(files).reduce((total,item)=>total+item.bytes.length,0),20*1024*1024);
 assert.throws(()=>decodeFiles([...files,{path:'extra.txt',content:'YQ=='}]),{code:'LOCAL_FILE_LIMIT'});
});
