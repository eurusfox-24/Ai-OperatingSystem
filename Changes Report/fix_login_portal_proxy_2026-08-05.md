# Technical Report: Login Portal Proxy Fix
**Date:** 2026-08-05

## Summary of Architectural Changes
- Refactored the UI application to utilize relative paths for all API and WebSocket interactions. This ensures they correctly route through the Vite development proxy (`vite.config.ts`) rather than making fragile cross-port requests to hardcoded localhost endpoints.

## Detailed Breakdown of Technical Changes
- **`ui/src/main.ts`**: Replaced all hardcoded instances of `http://localhost:8000/api` with relative paths (`/api`). This resolved issues where the frontend (running on e.g., port 3000) was failing to complete the `fetch` to the backend's `/api/auth/login` endpoint due to localhost resolution mismatch (IPv4 vs IPv6) or CORS/mixed-port blocks.
- **`ui/src/socket.ts`**: Updated the WebSocket connection URL to use ``${protocol}//${window.location.host}/ws`` instead of hardcoding `window.location.hostname:8000`. This ensures WebSocket traffic respects the Vite proxy routing for the `/ws` endpoint.
