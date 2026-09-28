import { fork } from 'node:child_process'

// Keep the original launch environment. Each new worker reads .env afresh.
let child
let stopping = false
let restarting = false
let stopTimer
function start() {
  restarting = false
  child = fork(new URL('./index.mjs', import.meta.url), [], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true })
  child.on('message', (message) => {
    if (message?.type === 'restart' && !stopping) restarting = true
  })
  child.once('error', (error) => { console.error('Unable to start Pulseboard:', error.message); process.exitCode = 1 })
  child.once('exit', (code) => {
    clearTimeout(stopTimer)
    if (restarting && !stopping) start()
    else process.exit(code ?? 1)
  })
}
function stop() {
  if (stopping) return
  stopping = true
  if (child?.connected) child.send({ type: 'shutdown' })
  else child?.kill()
  stopTimer = setTimeout(() => child?.kill('SIGKILL'), 15000)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('message', (message) => { if (message?.type === 'shutdown') stop() })
start()
