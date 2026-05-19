// Platform detection — auto-detect GitHub vs Azure DevOps from git remote URL

import { runText } from "./shell.mjs";

/**
 * Detect the platform from git remote URLs in the current working directory.
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @returns {Promise<{ platform: "github"|"ado"|"unknown", remote?: string, owner?: string, repo?: string, org?: string, project?: string }>}
 */
export async function detectPlatform(cwd) {
    try {
        const remoteOutput = await runText("git", ["remote", "-v"], { cwd });
        const lines = remoteOutput.split("\n").filter((l) => l.includes("(fetch)"));

        for (const line of lines) {
            const url = line.split(/\s+/)[1];
            if (!url) continue;

            // GitHub: https://github.com/owner/repo.git or git@github.com:owner/repo.git
            const ghHttps = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
            if (ghHttps) {
                return {
                    platform: "github",
                    remote: url,
                    owner: ghHttps[1],
                    repo: ghHttps[2].replace(/\.git$/, ""),
                };
            }

            // ADO: https://dev.azure.com/org/project/_git/repo
            const adoNew = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/.]+)/);
            if (adoNew) {
                return {
                    platform: "ado",
                    remote: url,
                    org: adoNew[1],
                    project: adoNew[2],
                    repo: adoNew[3].replace(/\.git$/, ""),
                };
            }

            // ADO legacy: https://org.visualstudio.com/project/_git/repo
            const adoLegacy = url.match(/([^/.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/.]+)/);
            if (adoLegacy) {
                return {
                    platform: "ado",
                    remote: url,
                    org: adoLegacy[1],
                    project: adoLegacy[2],
                    repo: adoLegacy[3].replace(/\.git$/, ""),
                };
            }

            // ADO SSH: git@ssh.dev.azure.com:v3/org/project/repo
            const adoSsh = url.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/.]+)/);
            if (adoSsh) {
                return {
                    platform: "ado",
                    remote: url,
                    org: adoSsh[1],
                    project: adoSsh[2],
                    repo: adoSsh[3].replace(/\.git$/, ""),
                };
            }
        }

        return { platform: "unknown" };
    } catch {
        return { platform: "unknown" };
    }
}

/**
 * Get the current git branch name. Throws if in detached HEAD state.
 */
export async function getCurrentBranch(cwd) {
    try {
        const branch = await runText("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
        if (branch === "HEAD") {
            throw new Error("Detached HEAD state — checkout a branch before using build tools.");
        }
        return branch;
    } catch (e) {
        if (e.message?.includes("Detached HEAD")) throw e;
        return null;
    }
}
