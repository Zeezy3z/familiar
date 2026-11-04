// electron-builder `win.signtoolOptions.sign` hook: Azure Artifact Signing (formerly Trusted
// Signing), called once per file electron-builder signs (Familiar.exe, the NSIS installer and
// uninstaller, and every .exe under app.asar.unpacked). Passed only by .github/workflows/installer.yml
// (-c.win.signtoolOptions.sign=./build/sign.cjs); local builds stay unsigned.
//
// claude.exe (claude-agent-sdk-win32-x64) is skipped: it is already signed by Anthropic, PBC, and
// signing it again would replace that signature with ours. installer.yml checks it afterwards.
//
// Needs, from the workflow: an Azure sign-in (azure/login with GitHub OIDC; the TrustedSigning
// module's DefaultAzureCredential picks up the Azure CLI session), the TrustedSigning PowerShell
// module, and FAMILIAR_SIGN_ENDPOINT / FAMILIAR_SIGN_ACCOUNT / FAMILIAR_SIGN_PROFILE.
// FAMILIAR_SIGN_DRY_RUN=1 only logs what would be signed (local check of the file list; the output
// is unsigned, and installer.yml's signature check would fail it).
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const SKIP = /[\\/]claude-agent-sdk-win32-x64[\\/]/i;

module.exports = async function sign(config) {
  const file = config.path;
  if (config.hash && config.hash !== "sha256") return; // one SHA-256 pass (signingHashAlgorithms)
  if (SKIP.test(file)) {
    console.log(`  sign: skip ${path.basename(file)} (keeps its Anthropic signature)`);
    return;
  }
  if (process.env.FAMILIAR_SIGN_DRY_RUN === "1") {
    console.log(`  sign: DRY RUN, would sign ${file}`);
    return;
  }
  const missing = ["FAMILIAR_SIGN_ENDPOINT", "FAMILIAR_SIGN_ACCOUNT", "FAMILIAR_SIGN_PROFILE"].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`sign.cjs: ${missing.join(", ")} not set`);
  console.log(`  sign: ${file}`);
  // Values travel as environment variables, never spliced into the command text.
  execFileSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Invoke-TrustedSigning -Endpoint $env:FAMILIAR_SIGN_ENDPOINT -CodeSigningAccountName $env:FAMILIAR_SIGN_ACCOUNT " +
        "-CertificateProfileName $env:FAMILIAR_SIGN_PROFILE -Files $env:FAMILIAR_SIGN_FILE -FileDigest SHA256 " +
        "-TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest SHA256",
    ],
    { stdio: "inherit", env: { ...process.env, FAMILIAR_SIGN_FILE: file } },
  );
};
