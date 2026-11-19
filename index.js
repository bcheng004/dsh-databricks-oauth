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

/**
 * Defaults overridden by the row's `config`.
 *
 * `cliPath` and `profile` are empty on purpose. An empty path resolves
 * `databricks` through `PATH`; an empty profile lets the CLI pick its own
 * (`DATABRICKS_CONFIG_PROFILE`, else `DEFAULT`). Neither default names a
 * particular machine or workspace, so a reader of this repository supplies only
 * what actually differs for them.
 */
const DEFAULTS = {
  cliPath: '',
  profile: '',
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
 * The most useful explanation a failed CLI run produced.
 *
 * The Databricks CLI reports many failures as a JSON object on *stdout* with a
 * non-zero exit and an empty stderr, so a stderr-only message would discard the
 * one line that says what to do (`UNAUTHENTICATED … run databricks auth
 * login`). Stderr wins when it has content, then the CLI's own JSON message,
 * then the child-process message.
 * @param {unknown} error - the `execFile` error.
 * @param {string | Buffer | undefined} stdout - captured standard output.
 * @param {string | Buffer | undefined} stderr - captured standard error.
 * @returns {string} the failure detail.
 */
function failureDetail(error, stdout, stderr) {
  const stderrText = String(stderr ?? '').trim()
  if (stderrText !== '') return stderrText
  const stdoutText = String(stdout ?? '').trim()
  if (stdoutText.startsWith('{')) {
    try {
      const parsed = JSON.parse(stdoutText)
      if (typeof parsed?.message === 'string' && parsed.message !== '') return parsed.message
    } catch {
      // Not the CLI's error envelope; fall through to the process message.
    }
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run one executable and resolve its stdout.
 * @param {string} file - executable path or a bare name resolved through `PATH`.
 * @param {string[]} args - command arguments.
 * @param {number} timeoutMs - kill the child after this long.
 * @returns {Promise<string>} standard output.
 */
function execOnce(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(failureDetail(error, stdout, stderr))
        failure.code = error.code
        reject(failure)
        return
      }
      resolve(stdout)
    })
  })
}

/**
 * Run the CLI, honoring the configured path and falling back to `PATH`.
 *
 * A GUI-launched Desktop app inherits a minimal `PATH`, so the absolute path is
 * the reliable choice and the fallback exists for shell-launched profiles that
 * never set one. Failing both produces a message naming the setting to fix,
 * rather than the bare `spawn ENOENT` a reader would have to decode.
 * @param {string} cliPath - configured executable path, possibly empty.
 * @param {string[]} args - command arguments.
 * @param {number} timeoutMs - kill the child after this long.
 * @returns {Promise<string>} standard output.
 */
async function runCli(cliPath, args, timeoutMs) {
  if (cliPath !== '') {
    try {
      return await execOnce(cliPath, args, timeoutMs)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  try {
    return await execOnce('databricks', args, timeoutMs)
  } catch (error) {
    if (error.code === 'ENOENT') {
      const tried = cliPath === '' ? '"databricks" on PATH' : `${cliPath} and "databricks" on PATH`
      throw new Error(`Databricks CLI not found (tried ${tried}); set cliPath to its absolute path`)
    }
    throw error
  }
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
 *
 * `apply` stays pending until the first attempt settles, so a plugin that loads
 * after this one and connects at startup with the same reference sees a token
 * minted now rather than whatever the previous session left behind. A failed
 * first attempt is logged rather than thrown: rejecting activation here would
 * remove the only thing that can repair the credential.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row's config, overriding {@link DEFAULTS}.
 */
export async function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  const log = pickLogger(ctx)
  const label = `databricks-oauth[${options.profile === '' ? 'default' : options.profile}]`

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
    const args = ['auth', 'token', '-o', 'json']
    if (options.profile !== '') args.push('-p', options.profile)
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

  await refresh().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    log.warn?.(`${label}: first mint failed: ${message} (keeping the stored credential as it is)`)
  })

  ctx.interval(tick, options.checkIntervalMs)
}
