# Releasing

## Build

```powershell
npm run tauri build
```

Produces `src-tauri\target\release\bundle\nsis\Brett-Net_x.y.z_x64-setup.exe`.

The version comes from `src-tauri\tauri.conf.json`; keep `package.json` and
`src-tauri\Cargo.toml` in step with it.

Hand that one file to anyone. It installs per-user with no admin rights — see
[INSTALL.md](INSTALL.md), including the SmartScreen warning to expect.

---

## The updater is wired but dormant

The app already ships with the updater plugin and the **public** signing key
compiled in, and it checks
`https://github.com/agbrettpittman/Brett-Net/releases/latest/download/latest.json`
on every launch. That URL 404s today, and the check fails silently.

This means already-installed copies can start receiving updates *without being
reinstalled*. The day a release publishes a valid `latest.json`, every existing
install begins offering it.

### Turning it on

1. **Find the private key.** It was generated to
   `%USERPROFILE%\.tauri\brett-net.key`.

   > It currently has **no passphrase**. Before using it for a real release,
   > regenerate it with one (`npx tauri signer generate -w <path>`) and replace
   > `plugins.updater.pubkey` in `tauri.conf.json` with the new public key.
   > Store the private key and its passphrase in a password manager. Losing
   > either means no installed copy can ever be updated again.

2. **Set `"createUpdaterArtifacts": true`** in `tauri.conf.json` under `bundle`.

3. **Build with the key in the environment:**

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\brett-net.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<passphrase, or omit if none>"
   npm run tauri build
   ```

   This additionally emits a `.sig` file next to the installer.

4. **Publish a GitHub release** containing the installer, its `.sig`, and a
   `latest.json`:

   ```json
   {
     "version": "0.2.0",
     "notes": "First line shows in the update banner.",
     "pub_date": "2026-08-12T00:00:00Z",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the .sig file>",
         "url": "https://github.com/agbrettpittman/Brett-Net/releases/download/v0.2.0/Brett-Net_0.2.0_x64-setup.exe"
       }
     }
   }
   ```

   The release must be the *latest* one for the `releases/latest/download/`
   URL to resolve.

Nothing else changes. `UpdateBanner` already handles the rest.

### Turning it off

Remove `plugins.updater.endpoints` from `tauri.conf.json`. Note that only stops
*future* builds from checking — copies already installed keep using the endpoint
they were built with.

---

## Code signing

The SmartScreen warning is only fixed by signing the installer with an OV
code-signing certificate (roughly $200–400/year) or Azure Trusted Signing. That
is a separate decision from the updater, which uses its own minisign key and
works fine unsigned.
