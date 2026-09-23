# Technical Documentation Report: Vite Proxy & Dual Event Chat Submission Fix

**Date:** 2026-07-30  
**Project:** The Company AI OS  
**Author:** AI System Architect  

---

## Executive Summary

To ensure seamless, Hermes-style interactive chat between the user and the Manager Agent in the browser interface, a refactoring was completed to resolve cross-origin hostname mismatches and ensure robust submit/click event handling in the UI.

---

## Architectural & Configuration Changes

1. **Vite Dev Server Backend Proxy Configuration**:
   - Updated `ui/vite.config.ts` to proxy all `/api` REST endpoints and `/ws` WebSocket connections directly to `http://127.0.0.1:8000`.
   - Eliminates CORS issues, cross-origin header blocking, and Windows 11 IPv6 `localhost` (`::1`) vs IPv4 loopback (`127.0.0.1`) resolution failures.

2. **Dynamic API & WebSocket Routing**:
   - Updated `ui/src/socket.ts` to construct relative WebSocket connections (`ws://${window.location.host}/ws`) routed via Vite proxy.
   - Updated `executeChatPrompt` in `ui/src/main.ts` with auto-fallback to explicit IPv4 loopback `http://127.0.0.1:8000/api/chat`.

3. **Dual Event Listener Binding**:
   - Bound explicit event listeners to both `chatForm.submit` and `sendBtn.click` in `ui/src/main.ts` to ensure messages dispatch regardless of whether the user presses Enter or clicks the Send button.

---

## Detailed Breakdown of Technical Changes

### `ui/vite.config.ts`
```typescript
import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        secure: false
      },
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true
      }
    }
  }
})
```

### `ui/src/socket.ts`
- Dynamically derives `wsUrl` from `window.location.host` with fallback to `ws://127.0.0.1:8000/ws` for `file://` scheme access.

### `ui/src/main.ts`
- Updated `executeChatPrompt` to attempt relative `/api/chat` first, with immediate fallback to `http://127.0.0.1:8000/api/chat`.
- Created unified `handleChatSubmission(e: Event)` and attached it to both `chatForm` submit and `sendBtn` click events.

---

## Verification & Status

- **Build Verification:** Verified clean production bundle build with `vite build` (845ms).
- **Backend Verification:** Confirmed `/api/chat` returning 200 OK responses.
- **Status:** Deployed and operational.
