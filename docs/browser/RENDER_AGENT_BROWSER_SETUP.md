# Render Agent Browser runtime

The Agent Browser needs a real Chromium executable and `puppeteer-core` on the **Node web service**. The browser runtime is installed during the Render build; it is not installed on the user's phone.

## Runtime versions

- Node.js: `22.22.0` (pinned by `.node-version` and `package.json`)
- `puppeteer-core`: `25.11.0`
- `@sparticuz/chromium`: `153.0.0`

The gateway driver uses the Chromium package's own launch arguments and headless mode when that binary is selected.

## Render build command

Keep the service's existing build steps, but ensure the browser runtime install happens after the normal project dependency install and before the service starts:

```sh
npm install && npm run install:browser-runtime
```

If the current build command also runs a frontend build, retain that step, for example:

```sh
npm install && npm run install:browser-runtime && npm run build
```

Do not put the browser installation in the Start Command: it belongs in the build phase so every deployment prepares the runtime once.

## Start command

Keep the gateway's existing start command. For this repository the direct gateway command is:

```sh
npm run dev:gateway
```

## Verification

After Render finishes a successful deploy:

1. Open MMM's Agent Browser capability panel. It should report a real engine, not `unconfigured`.
2. Run a harmless task against `https://example.com`: extract the page title and main heading.
3. Confirm the task completes and has real step/evidence records.
4. Run `npm run test:browser` and `npm run test:browser:engine` in a gateway environment with the installed runtime. The engine test must report PASS, not SKIP.

The package installation requires outbound access to the npm registry during Render builds. Chromium is extracted to the runtime's temporary directory by `@sparticuz/chromium`; the binary is recreated as needed after restarts.
