/**
 * Keep a harness credential reference filled with a short-lived Databricks
 * OAuth access token.
 *
 * The Databricks CLI already owns the OAuth grant: `databricks auth token`
 * returns a fresh bearer token, refreshing the cached refresh token when the
 * access token has aged out. This plugin moves that token into the credential
 * seam, which the LLM adapter resolves on every request, so an AI Gateway
 * route authenticates by OAuth instead of a personal access token.
 *
 * @module @local/dsh-databricks-oauth
 */

import { execFile } from 'node:child_process'

/** Registered plugin name, also the prefix of every log line. */
export const name = 'dsh-databricks-oauth'

/**
 * The credential service must exist before this plugin can store anything, and
 * the timer service owns the refresh schedule; touching `ctx.interval` without
 * declaring `timer` throws rather than returning undefined.
 */
export const inject = ['credentials', 'timer']

/** Defaults overridden by the row's `config` in the bundle patch. */
const DEFAULTS = {
  cliPath: '/opt/homebrew/bin/databricks',
  profile: 'fevm-workshop-guy',
  ref: 'DATABRICKS_API_KEY',
  refreshSkewMs: 5 * 60 * 1000,
  checkIntervalMs: 60 * 1000,
  timeoutMs: 20 * 1000,
}

/**
 * Prefer the Cordis logger, which writes to the application log, and fall back
 * to the console when the plugin is mounted without one.
 * @param {object} ctx - the plugin context.
 * @returns {object} something with `info` and `warn` methods.
 */
function pickLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') {
      const logger = ctx.logger(name)
      if (logger !== undefined && logger !== null) return logger
    }
  } catch {
    // A composition without a logger still gets its warnings on stdout.
  }
  return console
}

/**
 * Run the CLI and resolve its stdout.
 * @param {string} cliPath - absolute path to the Databricks CLI.
 * @param {string[]} args - command arguments.
 * @param {number} timeoutMs - kill the child after this long.
 * @returns {Promise<string>} standard output.
 */
function runCli(cliPath, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr ?? '').trim() || error.message
        reject(new Error(detail))
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Read the token and its expiry out of the CLI's JSON.
 *
 * `expiry` is an absolute timestamp and is preferred; `expires_in` covers CLI
 * releases that print only a lifetime; the last resort keeps the value out of
 * an immediate refresh loop without claiming more than a short life.
 * @param {string} raw - standard output of `databricks auth token -o json`.
 * @returns {{token: string, expiresAt: number}} the token and its deadline.
 */
function readToken(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('`databricks auth token` did not print JSON')
  }
  const token = parsed?.access_token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('`databricks auth token` printed no access_token')
  }
  const expiry = typeof parsed.expiry === 'string' ? Date.parse(parsed.expiry) : Number.NaN
  const expiresAt = Number.isFinite(expiry)
    ? expiry
    : Number(parsed.expires_in) > 0
      ? Date.now() + Number(parsed.expires_in) * 1000
      : Date.now() + 30 * 60 * 1000
  return { token, expiresAt }
}

/**
 * Mint tokens on a timer and store each new one in the credential seam.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row's config, overriding {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const log = pickLogger(ctx)
  const label = `databricks-oauth[${options.profile}]`

  /** @type {{token: string, expiresAt: number} | undefined} */
  let cached
  /** @type {Promise<void> | undefined} */
  let pending
  let stopped = false
  let failures = 0

  /**
   * Ask the CLI for a token. The CLI owns the refresh token, so this is the
   * only place that knows how to obtain one.
   *
   * Inside the refresh window the cached token is still valid, and a plain
   * call would hand it back unchanged; `--force-refresh` performs the actual
   * refresh-token grant, which is what keeps the stored credential ahead of
   * its expiry instead of a poll interval behind it.
   * @param {boolean} force - bypass the CLI's own expiry check.
   * @returns {Promise<{token: string, expiresAt: number}>} a fresh token.
   */
  async function mint(force) {
    const args = ['auth', 'token', '-p', options.profile, '-o', 'json']
    if (force) args.push('--force-refresh')
    const raw = await runCli(options.cliPath, args, options.timeoutMs)
    return readToken(raw)
  }

  /**
   * Store a token when the current one is missing or close to expiry.
   *
   * A failed mint leaves whatever the store already holds untouched: an
   * expired token fails the next request, whereas removing the reference
   * would turn a recoverable outage into `MISSING_CREDENTIAL`.
   * @returns {Promise<void>} resolves once the store matches the CLI.
   */
  async function refresh() {
    if (stopped) return
    if (cached !== undefined && cached.expiresAt - Date.now() > options.refreshSkewMs) return
    if (pending !== undefined) {
      await pending
      return
    }
    pending = (async () => {
      const fresh = await mint(true)
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        throw new Error('no credentials service is mounted, so the token cannot be stored')
      }
      if (cached === undefined || cached.token !== fresh.token) {
        await credentials.set(options.ref, fresh.token)
        log.info?.(`${label}: stored a fresh token in ${options.ref}, valid until ${new Date(fresh.expiresAt).toISOString()}`)
      }
      cached = fresh
    })()
    try {
      await pending
    } finally {
      pending = undefined
    }
  }

  /**
   * One scheduled attempt; failures are reported without stopping the timer so
   * a CLI that is briefly unavailable recovers on its own.
   * @returns {void}
   */
  function tick() {
    if (stopped) return
    void refresh().then(() => {
      failures = 0
    }, (error) => {
      failures += 1
      if (failures === 1 || failures === 2 || failures % 10 === 0) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn?.(`${label}: ${message} (attempt ${failures}; keeping the stored credential as it is)`)
      }
    })
  }

  ctx.on('dispose', () => { stopped = true })

  tick()
  ctx.interval(tick, options.checkIntervalMs)
}
