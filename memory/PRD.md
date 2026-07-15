# MotionAlert - Product Requirements Document

## Overview
Real-time camera-based motion detection app for Expo (iOS/Android). Detects any change in the visual scene and announces "Motion detected" via TTS voice notification through connected earphones or the device speaker.

## Users
Anyone who wants an ad-hoc security/motion-alert utility - travelers, parents, room monitors.

## Core Features (MVP)
1. **Camera Permission Handling** - request/deny states with tactical themed empty state
2. **Full-Screen Live Feed** - rear camera preview under a HUD overlay
3. **Motion Detection Engine** (client-side, offline)
   - Frame sampling every ~600ms
   - Downscale each frame to 48x48 JPEG (via `expo-image-manipulator`)
   - Decode with `jpeg-js`, convert to grayscale
   - Compute mean absolute per-pixel difference vs previous frame
   - Threshold derived from sensitivity slider (0-100 -> 30..3)
4. **Sensitivity Slider** (0-100%) - default 60%, live-adjustable
5. **Voice Notification (TTS)** - `expo-speech.speak("Motion detected")` throttled to once every 4s
6. **HUD Elements**
   - Status pill: STANDBY / MONITORING / MOTION DETECTED (pulsing red dot)
   - Reticle crosshairs + corner brackets (turn red on motion)
   - TTS indicator icon (animated on speak)
   - Start / Stop toggle button
7. **Haptics** - selection on slider, medium on start, light on stop, warning on motion
8. **App Backgrounding** - monitoring auto-stops when app goes background

## Non-Goals (MVP)
- No history/event log
- No cloud sync
- No account / auth
- No recording / photos of events

## Tech Stack
- Frontend: Expo SDK 54, expo-router, expo-camera, expo-image-manipulator, expo-speech, expo-haptics, expo-linear-gradient, @react-native-community/slider, react-native-reanimated, jpeg-js
- Backend: FastAPI (default template, no persistence needed)
- Storage: none required for MVP

## Design
Dark-first tactical utility HUD. Obsidian base (#09090B) with Signal Red (#EF4444) accent. See `/app/design_guidelines.json`.
