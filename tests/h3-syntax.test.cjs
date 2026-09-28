const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../src/h3-syntax.js');
test('source catalog retains all five categories and 46 commands',()=>{
 assert.deepEqual(H.categories.map(x=>x.id),['structure','shot','dialogue','retention','task']);
 const cmds=H.commands();assert.equal(cmds.length,46);
 for(const [cat,count] of [['structure',7],['shot',3],['dialogue',3],['retention',7],['task',6],['camera',20]])assert.equal(cmds.filter(x=>x.category===cat).length,count);
});
test('all twenty camera phrases are recognized and labels do not replace raw syntax',()=>{
 assert.equal(H.cameras.length,20);
 for(const [zh,en,detail,raw] of H.cameras){assert.equal(H.tokenType(raw),'camera');assert.equal(H.label(raw),zh);assert.match(raw,/^(The camera |POV,)/);assert.equal([...raw.matchAll(H.pattern())].length,1);}
 assert.equal(H.cameras.find(x=>x[0]==='轻微晃动')[3],'The camera shakes slightly ');
});
test('dynamic shot and speaker indices use existing prompt maxima',()=>{
 const list=H.commands('[Shot 2] [Shot 9] (S3) (S7)');
 assert.equal(list.find(x=>x.kind==='shot-label').raw,'[Shot 10]');
 assert.equal(list.find(x=>x.kind==='speaker').raw,'(S8)');
});
test('music default is separate from its structural token',()=>{
 const c=H.commands().find(x=>x.label==='non_diegetic_music');assert.equal(c.raw,'non_diegetic_music:');assert.equal(c.defaultBody,'N/A');
});
test('dialogue language choices and H3 atomic categories retained',()=>{
 assert.equal(H.languages.length,20);
 for(const [raw,type] of [['<Picture 1>','picture'],['<Video 2>','video'],['<Audio 3>','audio'],['<Subject 4>','subject'],['[Shot 9]','shot'],['(S2)','speaker'],['[01:23]','time'],['<d>[Chinese] 出发。</d>','dialogue'],['<scenetrans>','transition'],['fully_copy','retention'],['[video continuation]','task']])assert.equal(H.tokenType(raw),type);
});
