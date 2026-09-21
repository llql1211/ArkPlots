// 云同步 shim 的回归测试：在 Node 里模拟浏览器环境跑 web/dist/static-api.js。
//
// 依赖构建产物，所以必须先生成它：
//   cd web && npm run build && node ../scripts/build-static.mjs
// 然后：
//   node scripts/test-static-api-shim.mjs
//
// 合并朋友的 static-api-shim.js 更新之后务必重跑 —— 差异提交和离线队列的语义
// 一旦被改坏，表现为「跨设备覆盖」或「离线标记丢失」，都很难靠肉眼发现。
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../web/dist/static-api.js', import.meta.url), 'utf8')
const plotline = JSON.parse(readFileSync(new URL('../Plotline.json', import.meta.url), 'utf8'))
const ids = plotline.data.map((p) => String(p.id))
const [A, B] = ids // 取两条真实剧情 id 做样本
const TOTAL = ids.length

function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    dump: () => Object.fromEntries(map),
  }
}

/** 模拟一个浏览器窗口：独立的 localStorage，共享同一台「服务器」。 */
function makeWindow(server, storage = makeStorage()) {
  const calls = []
  const win = {
    __ARKPLOTS_PLOTLINE__: null,
    localStorage: storage,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      const method = String((init && init.method) || 'GET').toUpperCase()
      calls.push({ url, method, body: init && init.body })
      if (server.offline) throw new TypeError('Failed to fetch')
      if (server.htmlFallback) {
        // Pages 对未匹配路径会回退成 index.html（HTTP 200）
        return new Response('<!doctype html><html></html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        })
      }
      if (server.failWith) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: server.failWith })
      }
      if (url === '/api/records' && method === 'GET') {
        return new Response(JSON.stringify(server.records), { status: 200 })
      }
      if (url === '/api/records' && method === 'PUT') {
        // 服务端语义：逐键 upsert，不删除未提及的键
        Object.assign(server.records, JSON.parse(init.body))
        return new Response(JSON.stringify(server.records), { status: 200 })
      }
      throw new Error('unexpected request: ' + method + ' ' + url)
    },
  }
  new Function('window', 'Response', 'console', src)(win, Response, console)
  return { win, calls, storage }
}

let failures = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) console.log(`      实际 ${a}\n      期望 ${e}`)
}

const get = (win) => win.fetch('/api/records')
const put = (win, body) =>
  win.fetch('/api/records', { method: 'PUT', body: JSON.stringify(body) })

console.log(`样本 id: ${A}, ${B}（共 ${TOTAL} 条）\n`)

// ---- 场景 1：GET 合并服务端记录，并把未知章节补成 未读 --------------------
{
  const server = { records: { [A]: '已读' } }
  const { win } = makeWindow(server)
  const rec = await (await get(win)).json()
  check('GET 保留服务端已标记的章节', rec[A], '已读')
  check('GET 把其余章节补成 未读', Object.values(rec).filter((v) => v === '未读').length, TOTAL - 1)
  check('GET 覆盖全部章节', Object.keys(rec).length, TOTAL)
}

// ---- 场景 2：PUT 只提交差异键（核心：避免整份覆盖） ------------------------
{
  const server = { records: { [A]: '已读' } }
  const { win, calls } = makeWindow(server)
  await get(win)
  // 前端总是提交整份映射，其中只有 B 变了
  await put(win, Object.fromEntries(ids.map((id) => [id, id === A || id === B ? '已读' : '未读'])))
  const putCall = calls.find((c) => c.method === 'PUT')
  check('PUT 请求体只含改动键（而不是整份映射）', JSON.parse(putCall.body), { [B]: '已读' })
  check('服务端最终状态', server.records, { [A]: '已读', [B]: '已读' })
}

// ---- 场景 3：两台设备各标各的章节，互不覆盖（真同步） ----------------------
{
  const server = { records: {} }
  const { win: pc } = makeWindow(server)
  const { win: phone } = makeWindow(server)
  const allUnread = Object.fromEntries(ids.map((id) => [id, '未读']))

  await get(pc) // 两端各自加载，都看到全 未读
  await get(phone)
  await put(pc, { ...allUnread, [A]: '已读' }) // 电脑标记 A
  await put(phone, { ...allUnread, [B]: '已读' }) // 手机（快照已过期）标记 B

  check('两端各自的标记都保住了', server.records, { [A]: '已读', [B]: '已读' })
  check('电脑刷新后看到手机标的章节', (await (await get(pc)).json())[B], '已读')
}

// ---- 场景 4：断网时标记不丢，恢复后自动补传 -------------------------------
{
  const server = { records: {} }
  const { win, storage, calls } = makeWindow(server)
  const allUnread = Object.fromEntries(ids.map((id) => [id, '未读']))
  await get(win)

  server.offline = true
  await put(win, { ...allUnread, [A]: '已读' }) // 断网标记 A
  check(
    '断网标记已进本地待补传队列',
    JSON.parse(storage.dump()['arkplots.records.pending']),
    { [A]: '已读' }
  )

  server.offline = false
  calls.length = 0
  await get(win) // 恢复联网后的首次加载
  await new Promise((r) => setTimeout(r, 20)) // 等 flushPending 落库
  check('恢复联网后自动补传成功', server.records, { [A]: '已读' })
}

// ---- 场景 5：彻底断网（且未同步过）时如实报错 -----------------------------
{
  const { win } = makeWindow({ records: {}, offline: true })
  check('从未同步过 + 断网 → 503 而不是空记录', (await get(win)).status, 503)
}

// ---- 场景 6：同步过一次后，断网能从镜像读出记录 ---------------------------
{
  const server = { records: { [A]: '已读' } }
  const { win } = makeWindow(server)
  await get(win) // 先同步一次，写下镜像
  server.offline = true
  check('断网读镜像', (await (await get(win)).json())[A], '已读')
}

// ---- 场景 7：服务端真报错时如实透传，而不是假装存上了 ---------------------
{
  const { win } = makeWindow({ records: {}, failWith: 500 })
  check('服务端 500 如实透传', (await put(win, { [A]: '已读' })).status, 500)
}

// ---- 场景 8：Functions 未生效（被 Pages 静态回退成 HTML）时给出可读错误 ----
{
  const server = { records: {}, htmlFallback: true }
  const { win, storage } = makeWindow(server)
  check('GET 拿到 HTML 而不是 JSON → 502', (await get(win)).status, 502)
  check('PUT 同样如实报错而不是假装成功', (await put(win, { [A]: '已读' })).status, 502)
  check(
    '这种情况下改动仍留在本地队列，修好后可补传',
    JSON.parse(storage.dump()['arkplots.records.pending']),
    { [A]: '已读' }
  )
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
