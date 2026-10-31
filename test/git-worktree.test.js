'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const tools=require('../desktop/tool-runner');
const gitAvailable=!spawnSync('git',['--version'],{encoding:'utf8'}).error;
async function createIntegrationFixture(changedPath){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-worktree-integrate-'));
 try{
  execFileSync('git',['init'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['config','user.name','Bridge Test'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['config','user.email','bridge-test@example.invalid'],{cwd:root,stdio:'ignore'});
  fs.mkdirSync(path.join(root,'Source','Game'),{recursive:true});
  fs.writeFileSync(path.join(root,'Source','Game','Base.cpp'),'baseline\n');
  execFileSync('git',['add','Source/Game/Base.cpp'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['commit','-m','baseline'],{cwd:root,stdio:'ignore'});
  execFileSync('git',['branch','-M','main'],{cwd:root,stdio:'ignore'});
  await tools.executeTool(root,'git_worktree',{operation:'add',path:'.bridge-worktrees/integration',branch:'feature/integration',createBranch:true});
  const linked=path.join(root,'.bridge-worktrees','integration');
  const file=path.join(linked,...changedPath.split('/'));
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,'implementation\n');
  execFileSync('git',['add','--',changedPath],{cwd:linked,stdio:'ignore'});
  execFileSync('git',['commit','-m','implementation'],{cwd:linked,stdio:'ignore'});
  const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:linked,encoding:'utf8'}).trim();
  const targetSha=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  return{root,linked,changedPath,sourceSha,targetSha,cleanup(){fs.rmSync(root,{recursive:true,force:true});}};
 }catch(error){fs.rmSync(root,{recursive:true,force:true});throw error;}
}
function integrationArgs(fixture,overrides={}){
 return{
  operation:'integrate',path:'.bridge-worktrees/integration',branch:'feature/integration',targetBranch:'main',
  submittedCommitSha:fixture.sourceSha,scopePaths:['Source/Game'],expectedChangedPaths:[fixture.changedPath],
  ...overrides
 };
}
async function assertTargetUnchanged(fixture){
 assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:fixture.root,encoding:'utf8'}).trim(),fixture.targetSha);
}
test('git_worktree lists, adds, and removes linked worktrees without force',{skip:!gitAvailable},async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-worktree-'));try{execFileSync('git',['init'],{cwd:root,stdio:'ignore'});execFileSync('git',['config','user.name','Bridge Test'],{cwd:root,stdio:'ignore'});execFileSync('git',['config','user.email','bridge-test@example.invalid'],{cwd:root,stdio:'ignore'});fs.writeFileSync(path.join(root,'README.md'),'baseline\n');execFileSync('git',['add','README.md'],{cwd:root,stdio:'ignore'});execFileSync('git',['commit','-m','baseline'],{cwd:root,stdio:'ignore'});execFileSync('git',['branch','-M','main'],{cwd:root,stdio:'ignore'});assert.equal(tools.getToolPolicy('git_worktree',{operation:'list'}).requiresApproval,false);assert.equal(tools.getToolPolicy('git_worktree',{operation:'add'}).requiresApproval,true);const added=await tools.executeTool(root,'git_worktree',{operation:'add',path:'.bridge-worktrees/agent-001',branch:'feature/agent-001',createBranch:true});assert.equal(added.added,true);assert.ok(fs.existsSync(path.join(root,'.bridge-worktrees','agent-001','README.md')));const listed=await tools.executeTool(root,'git_worktree',{operation:'list'});assert.equal(listed.worktrees.length,2);assert.ok(listed.worktrees.some(x=>x.branch==='feature/agent-001'));const removed=await tools.executeTool(root,'git_worktree',{operation:'remove',path:'.bridge-worktrees/agent-001'});assert.equal(removed.removed,true);assert.equal(fs.existsSync(path.join(root,'.bridge-worktrees','agent-001')),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});


test('git_worktree integration verifies the submitted commit and records the exact merge parents',{skip:!gitAvailable},async()=>{
 const fixture=await createIntegrationFixture('Source/Game/Player.cpp');
 try{
  const result=await tools.executeTool(fixture.root,'git_worktree',integrationArgs(fixture));
  assert.equal(result.integrated,true);
  assert.equal(result.source_commit,fixture.sourceSha);
  assert.equal(result.target_before,fixture.targetSha);
  assert.deepEqual(result.changed_paths,['Source/Game/Player.cpp']);
  const parents=execFileSync('git',['rev-list','--parents','-n','1',result.merge_commit],{cwd:fixture.root,encoding:'utf8'}).trim().split(/\s+/).slice(1);
  assert.ok(parents.includes(fixture.targetSha));
  assert.ok(parents.includes(fixture.sourceSha));
 }finally{fixture.cleanup();}
});

test('git_worktree integration rejects a stale submitted SHA without changing the target',{skip:!gitAvailable},async()=>{
 const fixture=await createIntegrationFixture('Source/Game/Player.cpp');
 try{
  await assert.rejects(tools.executeTool(fixture.root,'git_worktree',integrationArgs(fixture,{submittedCommitSha:'f'.repeat(40)})),/TASK_SUBMISSION_STALE/);
  await assertTargetUnchanged(fixture);
 }finally{fixture.cleanup();}
});

test('git_worktree integration rejects actual changes outside the declared path scope',{skip:!gitAvailable},async()=>{
 const fixture=await createIntegrationFixture('Source/Network/Socket.cpp');
 try{
  await assert.rejects(tools.executeTool(fixture.root,'git_worktree',integrationArgs(fixture,{scopePaths:['Source/UI']})),/SUBMISSION_OUT_OF_SCOPE/);
  await assertTargetUnchanged(fixture);
 }finally{fixture.cleanup();}
});

test('git_worktree integration rejects a caller-supplied changed-path list that differs from Git',{skip:!gitAvailable},async()=>{
 const fixture=await createIntegrationFixture('Source/Game/Player.cpp');
 try{
  await assert.rejects(tools.executeTool(fixture.root,'git_worktree',integrationArgs(fixture,{expectedChangedPaths:['Source/Game/README.md']})),/SUBMISSION_CHANGED_PATHS_MISMATCH/);
  await assertTargetUnchanged(fixture);
 }finally{fixture.cleanup();}
});

test('git_worktree integration still rejects unrelated dirty files in the primary worktree',{skip:!gitAvailable},async()=>{
 const fixture=await createIntegrationFixture('Source/Game/Player.cpp');
 try{
  fs.writeFileSync(path.join(fixture.root,'unrelated-local-change.txt'),'must not be ignored\n');
  await assert.rejects(tools.executeTool(fixture.root,'git_worktree',integrationArgs(fixture)),/primary worktree must be clean.*unrelated-local-change\.txt/i);
  await assertTargetUnchanged(fixture);
 }finally{fixture.cleanup();}
});

test('git_worktree refuses to remove a dirty worktree without force', { skip: !gitAvailable }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-worktree-dirty-'));
  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Bridge Test'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'bridge-test@example.invalid'], { cwd: root, stdio: 'ignore' });
    fs.writeFileSync(path.join(root, 'README.md'), 'baseline\n');
    execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: root, stdio: 'ignore' });

    const linked = path.join(root, '.bridge-worktrees', 'dirty-agent');
    await tools.executeTool(root, 'git_worktree', {
      operation: 'add', path: '.bridge-worktrees/dirty-agent',
      branch: 'feature/dirty-agent', createBranch: true
    });
    assert.equal(tools.getToolPolicy('git_worktree', { operation: 'remove', path: '.bridge-worktrees/dirty-agent' }).requiresApproval, true);
    fs.writeFileSync(path.join(linked, 'README.md'), 'uncommitted change\n');
    await assert.rejects(
      tools.executeTool(root, 'git_worktree', { operation: 'remove', path: '.bridge-worktrees/dirty-agent' }),
      /modified|untracked|force|cannot remove/i
    );
    assert.equal(fs.existsSync(linked), true);
    const listed = await tools.executeTool(root, 'git_worktree', { operation: 'list' });
    assert.ok(listed.worktrees.some(item => path.join(path.basename(path.dirname(item.path)), path.basename(item.path)).toLowerCase() === path.join('.bridge-worktrees', 'dirty-agent').toLowerCase()), JSON.stringify(listed.worktrees));

    execFileSync('git', ['checkout', '--', 'README.md'], { cwd: linked, stdio: 'ignore' });
    const removed = await tools.executeTool(root, 'git_worktree', { operation: 'remove', path: '.bridge-worktrees/dirty-agent' });
    assert.equal(removed.removed, true);
    assert.equal(fs.existsSync(linked), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
