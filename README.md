# ChatGPT Assistant Overlay

A small Windows desktop assistant that wraps the real ChatGPT web experience in a floating, always-on-top window. Collapse it into a draggable orb when you need screen space; click the orb to return to the conversation.

This project is now a **desktop app**, not a browser extension. It does not use a separate chatbot backend or require an OpenAI API key.

## MVP features

- Always-on-top frameless window with a compact custom title bar.
- Actual ChatGPT site embedded with Electron `WebContentsView`.
- Persistent in-app session for ChatGPT sign-in.
- Collapsible floating orb, draggable in both expanded and collapsed states.
- Global shortcut: `Ctrl+Shift+Space` to collapse/expand the assistant.
- Reload ChatGPT, open it in the system browser, or quit.
- Remember the expanded window's position and size.
- Remote ChatGPT content has no Node integration; the local overlay uses a narrow, context-isolated preload API.
- Windows NSIS installer build and Windows CI packaging check.

## Run locally

Requirements: Windows 10/11, Node.js 22+ (Node 24 recommended), npm, and internet access.

From the repository root:

```powershell
npm install
npm start
```

The first launch opens `https://chatgpt.com/`. Sign in normally. Authentication is stored in this app's own persistent Chromium session; it does not automatically reuse Chrome or Edge cookies.

## Build an installer

```powershell
npm run dist:win
```

The NSIS installer is emitted under `dist/`. For an unpacked directory for testing, run:

```powershell
npm run dist:win:dir
```

## How it behaves

The overlay starts in the lower-right area of the primary screen. Drag the title bar to reposition the expanded window. Use the horizontal-line button to collapse it into the orb; drag the orb by its outer rim, then click it to restore the chat. The global shortcut toggles between those states.

## Current limitation

ChatGPT is a remote website, not a supported embedded-app API. Its login checks or website behavior may change; embedded sign-in may require opening ChatGPT in the system browser if the site refuses to work inside the app. The application keeps the chat experience itself inside the overlay when the site permits it.

The overlay currently provides compact ChatGPT access only. It does not yet control local files, terminals, or other Windows applications.

## Repositories

- Desktop app: https://github.com/hashin9973-ux/idk
- Test and release validation environment: https://github.com/hashin9973-ux/qdqwg
