/**
 * ArkPlots 阅读记录 API —— Cloudflare Pages Function + D1
 *
 * 这个是整个云端版唯一的后端。前端的 GET /api/plots 仍由 static-api-shim.js
 * 在页面内用内联的 Plotline.json 应答，不走网络。
 *
 *   GET /api/records → { [plot_id]: status }
 *   PUT /api/records → 请求体只含「本次改动的键」，逐键 upsert，返回合并后的完整记录
 *
 * 为什么 PUT 只接受差异键：前端每次保存都会提交整份映射，若照单全收，一台设备上
 * 可能已过期的快照会把另一台设备的改动覆盖掉。只写差异键之后，手机和电脑各标各的
 * 章节互不影响。
 */

interface Env {
  DB: D1Database
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  })
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readAll(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    'SELECT plot_id, status FROM records'
  ).all<{ plot_id: string; status: string }>()

  const records: Record<string, string> = {}
  for (const row of results ?? []) {
    records[String(row.plot_id)] = String(row.status)
  }
  return records
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  try {
    return json(await readAll(env))
  } catch (err) {
    return json({ error: errorMessage(err) }, 500)
  }
}

export const onRequestPut: PagesFunction<Env> = async ({ request, env }) => {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'invalid JSON' }, 400)
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'body must be a JSON object' }, 400)
  }

  const entries = Object.entries(body as Record<string, unknown>)
    .map(([key, value]) => [String(key), String(value)] as const)

  try {
    if (entries.length > 0) {
      const upsert = env.DB.prepare(
        'INSERT INTO records (plot_id, status) VALUES (?, ?) ' +
          'ON CONFLICT(plot_id) DO UPDATE SET status = excluded.status'
      )
      // D1 的 batch 是一个事务：要么全部落库，要么整体回滚。
      await env.DB.batch(entries.map(([key, value]) => upsert.bind(key, value)))
    }
    return json(await readAll(env))
  } catch (err) {
    return json({ error: errorMessage(err) }, 500)
  }
}
