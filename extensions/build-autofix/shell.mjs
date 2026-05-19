// Shell execution helpers for build-autofix extension
// Uses execFile where possible, exec only for .cmd scripts on Windows

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const MAX_BUFFER = 10 * 1024 * 1024; // 10MB for large CI logs

// cmd.exe metacharacters that need escaping inside double quotes
const CMD_META = /[&|<>^()%!]/g;

/**
 * Escape a single argument for cmd.exe double-quoted context.
 * Doubles internal quotes and escapes all shell metacharacters with ^.
 */
function escapeCmdArg(arg) {
    const str = String(arg);
    // Double internal quotes, then caret-escape all metacharacters
    const safe = str.replace(/"/g, '""').replace(CMD_META, "^$&");
    return `"${safe}"`;
}

/**
 * Run a CLI command safely. Prefers execFile; falls back to exec for .cmd on Windows.
 * @param {string} bin - Binary name (e.g., "gh", "az", "git")
 * @param {string[]} args - Argument array (never interpolated into shell)
 * @param {object} [opts] - { cwd, timeout }
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export async function run(bin, args, opts = {}) {
    const options = {
        maxBuffer: MAX_BUFFER,
        timeout: opts.timeout || 120_000, // 2 min default
        cwd: opts.cwd || process.cwd(),
        windowsHide: true,
    };

    // On Windows, gh/az/git are often .cmd shims — must use shell
    if (process.platform === "win32") {
        const escaped = args.map(escapeCmdArg);
        // Don't quote the binary name — cmd.exe needs to resolve .cmd/.bat shims via PATHEXT
        const command = `${bin} ${escaped.join(" ")}`;
        return execAsync(command, { ...options, shell: true });
    }

    // Unix: prefer execFile (no shell, no injection risk)
    return execFileAsync(bin, args, options);
}

/**
 * Run and return stdout trimmed, or throw with redacted stderr context.
 */
export async function runText(bin, args, opts = {}) {
    try {
        const { stdout } = await run(bin, args, opts);
        return stdout.trim();
    } catch (e) {
        // Redact secrets from error messages before propagating
        e.message = redactSecrets(e.message);
        if (e.stderr) e.stderr = redactSecrets(e.stderr);
        throw e;
    }
}

/**
 * Run and parse stdout as JSON. Throws descriptive error on parse failure.
 */
export async function runJson(bin, args, opts = {}) {
    const text = await runText(bin, args, opts);
    try {
        return JSON.parse(text);
    } catch {
        const preview = text.length > 200 ? text.slice(0, 200) + "..." : text;
        throw new Error(`${bin} returned non-JSON output: ${redactSecrets(preview)}`);
    }
}

/**
 * Check if a CLI binary is available and optionally authenticated.
 * @returns {{ available: boolean, version?: string, error?: string }}
 */
export async function checkCli(bin, versionArgs = ["--version"]) {
    try {
        const version = await runText(bin, versionArgs, { timeout: 10_000 });
        return { available: true, version };
    } catch (e) {
        return { available: false, error: e.message };
    }
}

/**
 * Redact potential secrets from text (tokens, keys, connection strings).
 */
export function redactSecrets(text) {
    if (!text) return text;
    return text
        // Bearer/token patterns
        .replace(/([Bb]earer\s+)[A-Za-z0-9\-._~+/]+=*/g, "$1[REDACTED]")
        // GitHub tokens
        .replace(/gh[ps]_[A-Za-z0-9]{36,}/g, "[REDACTED_GH_TOKEN]")
        // Azure/generic tokens and keys
        .replace(/[A-Za-z0-9/+]{40,}={0,2}/g, (match) => {
            // Only redact if it looks like a base64 key (not a normal long word)
            if (/[/+=]/.test(match)) return "[REDACTED_KEY]";
            return match;
        })
        // Connection strings
        .replace(/(Password|AccountKey|SharedAccessKey|Secret)=[^;"\s]+/gi, "$1=[REDACTED]")
        // Generic secret patterns
        .replace(/(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[^\s"';]+/gi, "$1=[REDACTED]");
}

/**
 * Truncate text to a max length, adding a truncation marker.
 */
export function truncate(text, maxLen = 5000) {
    if (!text || text.length <= maxLen) return text;
    return text.slice(0, maxLen) + `\n... [truncated, ${text.length - maxLen} chars omitted]`;
}

/**
 * Sleep for ms milliseconds.
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
