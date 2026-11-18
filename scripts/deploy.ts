import * as ChildProcess from 'node:child_process'
import { readFileSync } from 'node:fs'

const project = 'prj_gWqROjU2ByCKjShSLkA8th3vxLzu'
const repository = 'nanocodexyz/durable-vercel'
const lock = 'heads/deploy-lock'
const scripts = {"deploy": "deploy"}
const target = process.argv[2] ?? 'deploy'
const deploy = scripts[target as keyof typeof scripts]

function run(command: string, args: readonly string[], env = process.env) {
  const result = ChildProcess.spawnSync(command, args, { env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`)
  return result.stdout.trim()
}

if (!deploy) throw new Error(`Unknown deployment target: ${target}`)
const link = JSON.parse(readFileSync('.vercel/project.json', 'utf8'))
if (link.projectId !== project || typeof link.orgId !== 'string' || !link.orgId) throw new Error('Link this checkout to tempoxyz/nanocode-vercel-durable before deployment')
if (run('git', ['branch', '--show-current']) !== 'master') throw new Error('Deploy from master')
if (run('git', ['status', '--porcelain'])) throw new Error('Commit and push changes before deployment')

run('git', ['fetch', 'origin', 'master'])
run('git', ['rebase', 'origin/master'])
const sha = run('git', ['rev-parse', 'HEAD'])
if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error('HEAD must be a full 40-character commit')
if (sha !== run('git', ['rev-parse', 'origin/master'])) throw new Error('Push master before deployment')

run('gh', ['api', `repos/${repository}/git/refs`, '-f', `ref=refs/${lock}`, '-f', `sha=${sha}`])
let failure: unknown
try {
  run('npm', ['run', 'check'])
  run('git', ['fetch', 'origin', 'master'])
  if (sha !== run('git', ['rev-parse', 'origin/master'])) throw new Error('Master changed during build. Restart deployment')
  run('npx', ['vercel@latest', 'deploy', '--prod', '--scope', 'tempoxyz', '--yes', '--meta', `nanocodeCommit=${sha}`, '--build-env', `NANOCODE_COMMIT=${sha}`], { ...process.env, VERCEL_PROJECT_ID: project, VERCEL_ORG_ID: link.orgId })
} catch (error) {
  failure = error
} finally {
  run('gh', ['api', '--method', 'DELETE', `repos/${repository}/git/refs/${lock}`])
}
if (failure) throw failure
