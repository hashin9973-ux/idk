'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const tools=require('../desktop/tool-runner');
const gitAvailable=!spawnSync('git',['--version'],{encoding:'utf8'}).error;
test('git_worktree lists, adds, and removes linked worktrees without force',{skip:!gitAvailable},async()=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-worktree-'));try{execFileSync('git',['init'],{cwd:root,stdio:'ignore'});execFileSync('git',['config','user.name','Bridge Test'],{cwd:root,stdio:'ignore'});execFileSync('git',['config','user.email','bridge-test@example.invalid'],{cwd:root,stdio:'ignore'});fs.writeFileSync(path.join(root,'README.md'),'baseline\n');execFileSync('git',['add','README.md'],{cwd:root,stdio:'ignore'});execFileSync('git',['commit','-m','baseline'],{cwd:root,stdio:'ignore'});execFileSync('git',['branch','-M','main'],{cwd:root,stdio:'ignore'});assert.equal(tools.getToolPolicy('git_worktree',{operation:'list'}).requiresApproval,false);assert.equal(tools.getToolPolicy('git_worktree',{operation:'add'}).requiresApproval,true);const added=await tools.executeTool(root,'git_worktree',{operation:'add',path:'.bridge-worktrees/agent-001',branch:'feature/agent-001',createBranch:true});assert.equal(added.added,true);assert.ok(fs.existsSync(path.join(root,'.bridge-worktrees','agent-001','README.md')));const listed=await tools.executeTool(root,'git_worktree',{operation:'list'});assert.equal(listed.worktrees.length,2);assert.ok(listed.worktrees.some(x=>x.branch==='feature/agent-001'));const removed=await tools.executeTool(root,'git_worktree',{operation:'remove',path:'.bridge-worktrees/agent-001'});assert.equal(removed.removed,true);assert.equal(fs.existsSync(path.join(root,'.bridge-worktrees','agent-001')),false);}finally{fs.rmSync(root,{recursive:true,force:true});}});


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
