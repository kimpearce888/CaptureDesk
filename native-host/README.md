# CaptureDesk Native Host (`capturedesk-native-host`)

An optional companion to the CaptureDesk Chrome extension. When installed and
registered, the extension can hand finished recordings to this host, which
writes them **directly** into your local CaptureDesk Recordings folder
(`<Videos>/CaptureDesk`) — bypassing the browser's Downloads pipeline. Without
the host, the extension gracefully falls back to saving via Chrome Downloads
under `Downloads/CaptureDesk/`.

The host speaks Chrome's standard native-messaging protocol
(32-bit length-prefixed JSON frames over stdio):

| Message (extension → host)            | Reply (host → extension)       |
|---------------------------------------|--------------------------------|
| `{type:"ping"}`                       | `{type:"pong", host, version, dir}` |
| `{type:"begin", fileName, size}`      | `{type:"begin-ok", path}`      |
| `{type:"chunk", data:<base64>}`       | `{type:"chunk-ok", written}`   |
| `{type:"end"}`                        | `{type:"end-ok", path, size}`  |
| `{type:"abort"}`                      | `{type:"abort-ok"}`            |

## Requirements

- Node.js 18+ (`node` on PATH)

## Install (Windows)

1. Install Node.js 18+.
2. Run `install-windows.bat`.
3. Open the generated `com.capturedesk.host.json.generated`, replace
   `REPLACE_WITH_EXTENSION_ID` with your CaptureDesk extension ID, and save it
   as `com.capturedesk.host.json`.
4. Re-run `install-windows.bat` to register the corrected manifest.

## Install (Linux / macOS)

```bash
./install-linux.sh <your-extension-id>
```

## Manual registration

Point the registry key (Windows) or a symlink (Linux/macOS) at the manifest:

- Windows: `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.capturedesk.host`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/com.capturedesk.host`

The manifest's `allowed_origins` must list your installed extension's ID:
`chrome-extension://<EXTENSION_ID>/`.

## Privacy

The host only writes files into the CaptureDesk Recordings folder. It performs
no network I/O and stores no metadata.
