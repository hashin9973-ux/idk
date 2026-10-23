# ChatGPT Assistant Overlay

A small Windows desktop shell around the actual ChatGPT website. It is not a separate chatbot and does not require an OpenAI API key. Your ChatGPT account signs in inside the app's own persistent Chromium session.

## Features in the first app slice

- Frameless, always-on-top floating window.
- Embedded ChatGPT website using Electron's `WebContentsView`.
- Collapse to a compact orb; click the orb to restore the chat.
- Drag the title area to reposition the expanded window. Drag the rim around the orb to reposition the collapsed assistant.
- Global toggle: `Ctrl+Shift+Space` (macOS equivalent is registered by Electron).
- Reload ChatGPT, open ChatGPT in the system browser, and quit controls.
- Persistent ChatGPT login session and remembered expanded-window position.
- Isolated local UI and remote web content: no Node integration or app preload in the ChatGPT page.

## Run for development

Requirements: Windows 10/11, Node.js 22+, npm, and an internet connection.

From the repository root:

```powershell
npm install
npm start
```

The first launch opens `https://chatgpt.com/`. Sign in normally. The login is stored in this app's separate persistent session; it does not automatically reuse cookies from Chrome or Edge.

## Build a Windows installer

```powershell
npm run dist:win
```

The installer output is written to `dist/`. To create an unpacked Windows app directory for local testing, run `npm run dist:win:dir`.

## Notes

- ChatGPT is a remote website. Its login and DOM behavior may change, and embedding it in a desktop window is not an officially supported ChatGPT desktop API.
- Links to non-OpenAI sites open in the system browser; known ChatGPT/OpenAI sign-in pages stay inside the isolated app session.
- The overlay does not yet expose local file/process control. This iteration deliberately focuses on the compact assistant UI and reliable ChatGPT session first.
- The ChatGPT website is not modified by the app; at narrow window sizes it relies on ChatGPT's responsive layout.
