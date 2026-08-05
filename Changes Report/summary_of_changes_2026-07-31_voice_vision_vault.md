# Changes Report: 2026-07-31

## Live Vision, TTS, & Meeting Vault Additions

### 1. `ui/index.html` Additions
- **Language Selector**: Added a `#global-lang-select` dropdown to the top right of the application header, populated with `English` and `Finnish` options. This allows real-time toggle of TTS speech models and LLM response language.
- **Live Vision Module**: Added a `#live-vision-container` holding an HTML5 `<video id="webcam-feed">` and `<canvas id="webcam-canvas">`. This is visually styled as a glassmorphic floating module.
- **Action Buttons**: Injected "💾 Save to Vault" and "🎙️ Go Live" buttons next to the chat submit button.

### 2. `ui/src/style.css` Styles
- Created styles for `.live-vision-container` focusing on z-index depth, backdrop filtering, and floating coordinates.
- Added `.capsule-secondary-btn` and `.pulse-glow-btn` styling to handle visual states when Live mode is recording.

### 3. `ui/src/main.ts` Logic
- **WebRTC Implementation**: Implemented `navigator.mediaDevices.getUserMedia` to spawn the webcam feed dynamically when the user toggles "Go Live".
- **Speech Recognition (STT)**: Initialized `webkitSpeechRecognition` to continuously parse room audio. Bound `lang` dynamically to the Language Selector's state. When transcription finishes, triggers a canvas draw (`captureWebcamFrame()`) to pull a Base64 JPEG frame.
- **Speech Synthesis (TTS)**: Wrote `speakResponseOutLoud` function that utilizes `window.speechSynthesis`. Binds utterance language based on user selection, strips markdown out of the AI response for cleaner dictation, and automatically pauses/resumes Speech Recognition to avoid echoing itself.
- **Meeting Vault Integration**: Built a click handler for "Save to Vault" that scrapes the DOM's `chatStream.innerText`, builds a Blob mimicking a `.txt` file, and posts it to the existing backend endpoint `http://localhost:8000/api/documents/upload` via `FormData`. The Python backend parses the Blob, vectorizes it, embeds it via SQLite-vec, and immediately makes it available as RAG context for future manager agents.

### 4. Chat Input UX Fix
- Added a keydown event listener to the main chat input textarea. Pressing Enter now submits the prompt instantly (preventing the default newline behavior), while pressing Shift+Enter allows for native multi-line breaks, mirroring standard modern chat application UX (e.g. ChatGPT, Slack).

