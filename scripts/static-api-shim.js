;(function () {
  'use strict'

  var PLOTLINE = window.__ARKPLOTS_PLOTLINE__
  var STORAGE_KEY = 'arkplots.records' // offline mirror of the last known cloud state
  var PENDING_KEY = 'arkplots.records.pending' // local edits not yet acknowledged by the cloud
  var DEFAULT_STATUS = '未读'
  var RECORDS_ENDPOINT = '/api/records'

  if (
    !PLOTLINE ||
    typeof window.fetch !== 'function' ||
    typeof Response === 'undefined' ||
    typeof Promise === 'undefined'
  ) {
    // Missing build data or unsupported browser: leave fetch untouched.
    if (typeof console !== 'undefined' && console.error) {
      console.error('[ArkPlots] static API shim disabled: build data or browser support missing')
    }
    return
  }

  var plots = Array.isArray(PLOTLINE.data) ? PLOTLINE.data : []

  // Records live in the cloud (a Pages Function backed by D1) so that every
  // device shares one state. localStorage is downgraded to (a) a read cache used
  // when the network is unreachable and (b) a queue for edits made offline, which
  // is flushed on the next successful load.
  var lastKnown = null // full map we believe the cloud has, incl. backfilled 未读
  var pending = coerceStrings(readStored(PENDING_KEY))

  function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
      status: status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  function readStored(key) {
    try {
      var raw = window.localStorage.getItem(key)
      if (!raw) return null
      var parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
      return parsed
    } catch (err) {
      return null // unreadable or corrupt storage behaves like "nothing stored"
    }
  }

  function writeStored(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch (err) {
      // Quota exceeded / private mode: keep the session working instead of
      // surfacing an error banner on every status change.
    }
  }

  function coerceStrings(source) {
    var out = Object.create(null)
    if (!source || typeof source !== 'object') return out
    Object.keys(source).forEach(function (key) {
      out[String(key)] = String(source[key])
    })
    return out
  }

  /** Coerce whatever the cloud returned, then seed every plot id we know about. */
  function seed(records) {
    var out = Object.create(null)
    if (records) {
      Object.keys(records).forEach(function (key) {
        out[String(key)] = String(records[key])
      })
    }
    plots.forEach(function (plot) {
      if (!plot || plot.id === null || plot.id === undefined) return
      var key = String(plot.id)
      if (!(key in out)) out[key] = DEFAULT_STATUS
    })
    return out
  }

  /** Cloud state with any not-yet-uploaded local edits applied on top. */
  function compose(records) {
    var merged = seed(records)
    Object.keys(pending).forEach(function (key) {
      merged[key] = String(pending[key])
    })
    return merged
  }

  function remember(records) {
    lastKnown = records
    writeStored(STORAGE_KEY, records)
  }

  function rememberPending() {
    writeStored(PENDING_KEY, pending)
  }

  function fetchRemoteRecords() {
    return originalFetch(RECORDS_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  }

  /**
   * Parse a JSON body, tolerating "not JSON at all" (returns null).
   *
   * Cloudflare Pages auto-falls-back to index.html for unmatched paths, so a
   * missing/broken Function answers 200 with HTML. Without this guard the app
   * would surface a cryptic JSON parse error instead of an actionable one.
   */
  function readJson(res) {
    return res.json().then(
      function (value) {
        return value
      },
      function () {
        return null
      }
    )
  }

  function notJsonResponse() {
    return jsonResponse(502, {
      error: 'records API did not return JSON',
      hint: 'Functions 未生效（可能被 Pages 静态回退成了 index.html）；本地队列里的改动会在修好后自动补传',
    })
  }

  /**
   * Upload `diff` only. The app always PUTs the whole map, but sending the whole
   * map would let a stale device overwrite chapters changed on another device —
   * so the caller diffs first and the backend upserts key by key.
   */
  function putRemoteRecords(diff) {
    return originalFetch(RECORDS_ENDPOINT, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diff),
    }).then(function (res) {
      if (!res.ok) return res // server-side failure: surface it, keep the diff queued
      return readJson(res).then(function (serverRecords) {
        if (!serverRecords) return notJsonResponse() // diff stays queued for a retry
        // Drop the keys we just landed; a key edited again mid-flight keeps its
        // newer value and stays queued.
        Object.keys(diff).forEach(function (key) {
          if (pending[key] === diff[key]) delete pending[key]
        })
        rememberPending()
        remember(compose(serverRecords))
        return jsonResponse(200, lastKnown)
      })
    })
  }

  /** Retry queued offline edits. Failures are silently kept for the next load. */
  function flushPending() {
    var diff = coerceStrings(pending)
    if (Object.keys(diff).length === 0) return
    putRemoteRecords(diff).then(
      function () {},
      function () {}
    )
  }

  function loadRecords() {
    return fetchRemoteRecords().then(
      function (res) {
        if (!res.ok) return res // explicit server error: pass it through untouched
        return readJson(res).then(function (serverRecords) {
          if (!serverRecords) return notJsonResponse()
          remember(compose(serverRecords))
          flushPending()
          return jsonResponse(200, lastKnown)
        })
      },
      function () {
        // Network unreachable: fall back to the mirror so the app still reads.
        var mirror = readStored(STORAGE_KEY)
        if (!mirror) {
          return jsonResponse(503, {
            error: 'records unavailable offline',
            hint: '尚未同步过记录，且当前无法连接服务端',
          })
        }
        lastKnown = compose(mirror)
        return jsonResponse(200, lastKnown)
      }
    )
  }

  function saveRecords(body) {
    var clean = coerceStrings(body)

    var diff = Object.create(null)
    Object.keys(clean).forEach(function (key) {
      if (!lastKnown || lastKnown[key] !== clean[key]) diff[key] = clean[key]
    })

    if (Object.keys(diff).length === 0) {
      return Promise.resolve(jsonResponse(200, compose(clean)))
    }

    // Persist locally first so an offline edit survives a reload.
    if (!lastKnown) lastKnown = Object.create(null)
    Object.keys(clean).forEach(function (key) {
      lastKnown[key] = clean[key]
    })
    Object.keys(diff).forEach(function (key) {
      pending[key] = diff[key]
    })
    remember(lastKnown)
    rememberPending()

    return putRemoteRecords(diff).then(
      function (res) {
        return res
      },
      function () {
        // Offline: the edit is already queued locally, so the UI stays clean.
        return jsonResponse(200, lastKnown)
      }
    )
  }

  function requestPath(input) {
    var url = ''
    if (typeof input === 'string') url = input
    else if (input && typeof input.url === 'string') url = input.url // Request objects
    if (!url) return ''
    var path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    return path.split('?')[0].split('#')[0]
  }

  function requestMethod(input, init) {
    var method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET'
    return String(method).toUpperCase()
  }

  var originalFetch = window.fetch.bind(window)

  window.fetch = function (input, init) {
    var path = requestPath(input)
    var method = requestMethod(input, init)

    if (path === '/api/plots' && method === 'GET') {
      return Promise.resolve(jsonResponse(200, PLOTLINE))
    }

    if (path === RECORDS_ENDPOINT) {
      if (method === 'GET') return loadRecords()
      if (method === 'PUT') {
        var body = null
        try {
          var raw = init && init.body
          body = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch (err) {
          body = null
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return Promise.resolve(jsonResponse(400, { error: 'body must be a JSON object' }))
        }
        return saveRecords(body)
      }
    }

    return originalFetch(input, init)
  }
})()
