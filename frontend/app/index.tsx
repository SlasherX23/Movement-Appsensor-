import { useEffect, useRef, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  Platform,
  ActivityIndicator,
  AppState,
  AppStateStatus,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as ImageManipulator from "expo-image-manipulator";
import * as Speech from "expo-speech";
import * as Haptics from "expo-haptics";
import { LinearGradient } from "expo-linear-gradient";
import Slider from "@react-native-community/slider";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { Buffer } from "buffer";
import jpeg from "jpeg-js";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  cancelAnimation,
  Easing,
} from "react-native-reanimated";

// ---- Design tokens (from /app/design_guidelines.json) ----
const C = {
  surface: "#09090B",
  onSurface: "#FAFAFA",
  surfaceSecondary: "#18181B",
  onSurfaceSecondary: "#E4E4E7",
  surfaceTertiary: "#27272A",
  onSurfaceTertiary: "#D4D4D8",
  brand: "#EF4444",
  brandPrimary: "#DC2626",
  onBrandPrimary: "#FFFFFF",
  brandTertiary: "#450A0A",
  onBrandTertiary: "#FECACA",
  border: "#3F3F46",
  borderStrong: "#52525B",
  success: "#22C55E",
  onSurfaceInverse: "#09090B",
};

const CAPTURE_INTERVAL_MS = 600;
const TTS_COOLDOWN_MS = 4500;
const FRAME_SIZE = 48; // downscale to 48x48 for pixel diff
const ANALYZE_SIZE_W = 384; // snapshot width sent to Claude
const ANALYZE_SIZE_H = 384;
const BACKEND_URL = process.env.EXPO_PUBLIC_BACKEND_URL;

// Map slider (0..100) to diff threshold (higher slider = lower threshold = more sensitive)
function sensitivityToThreshold(s: number): number {
  // s=0 -> 30 (needs big change), s=100 -> 3 (tiny change triggers)
  return 30 - (s / 100) * 27;
}

export default function Index() {
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [motionDetected, setMotionDetected] = useState(false);
  const [sensitivity, setSensitivity] = useState(60);
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [classification, setClassification] = useState<
    "person" | "pet" | "vehicle" | "other" | null
  >(null);
  const [lastDescription, setLastDescription] = useState<string>("");

  const cameraRef = useRef<CameraView | null>(null);
  const loopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevGrayRef = useRef<Uint8Array | null>(null);
  const lastTTSRef = useRef<number>(0);
  const motionResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);
  const sensitivityRef = useRef(sensitivity);
  const isMonitoringRef = useRef(false);

  // Pulse animation for status alert dot / TTS speaker
  const pulse = useSharedValue(0);
  const ttsPulse = useSharedValue(0);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    isMonitoringRef.current = isMonitoring;
  }, [isMonitoring]);

  // Handle app backgrounding - stop monitoring
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state !== "active" && isMonitoringRef.current) {
        stopMonitoring();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    return () => {
      if (loopRef.current) clearTimeout(loopRef.current);
      if (motionResetRef.current) clearTimeout(motionResetRef.current);
      Speech.stop();
      cancelAnimation(pulse);
      cancelAnimation(ttsPulse);
    };
  }, [pulse, ttsPulse]);

  // Trigger pulsing when motion detected
  useEffect(() => {
    if (motionDetected) {
      pulse.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 500, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 500, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        false
      );
    } else {
      cancelAnimation(pulse);
      pulse.value = withTiming(0, { duration: 200 });
    }
  }, [motionDetected, pulse]);

  useEffect(() => {
    if (ttsSpeaking) {
      ttsPulse.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 350 }),
          withTiming(0, { duration: 350 })
        ),
        -1,
        false
      );
    } else {
      cancelAnimation(ttsPulse);
      ttsPulse.value = withTiming(0, { duration: 200 });
    }
  }, [ttsSpeaking, ttsPulse]);

  const dotStyle = useAnimatedStyle(() => ({
    opacity: 0.4 + pulse.value * 0.6,
    transform: [{ scale: 0.9 + pulse.value * 0.3 }],
  }));

  const reticleStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + pulse.value * 0.5,
  }));

  const ttsIconStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + ttsPulse.value * 0.45,
    transform: [{ scale: 0.95 + ttsPulse.value * 0.15 }],
  }));

  // ---- Frame processing ----
  const processFrame = useCallback(async () => {
    if (!cameraRef.current || busyRef.current) return;
    busyRef.current = true;
    try {
      const pic = await cameraRef.current.takePictureAsync({
        quality: 0.1,
        base64: false,
        skipProcessing: true,
        shutterSound: false,
        exif: false,
      });
      if (!pic?.uri) return;

      const manipulated = await ImageManipulator.manipulateAsync(
        pic.uri,
        [{ resize: { width: FRAME_SIZE, height: FRAME_SIZE } }],
        {
          compress: 0.6,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        }
      );
      if (!manipulated.base64) return;

      const raw = Buffer.from(manipulated.base64, "base64");
      let decoded: { data: Uint8Array; width: number; height: number };
      try {
        decoded = jpeg.decode(raw, { useTArray: true, formatAsRGBA: true });
      } catch {
        return;
      }

      // Convert to grayscale
      const px = decoded.data;
      const size = decoded.width * decoded.height;
      const gray = new Uint8Array(size);
      for (let i = 0, j = 0; i < px.length; i += 4, j += 1) {
        // luminance
        gray[j] = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
      }

      if (prevGrayRef.current && prevGrayRef.current.length === size) {
        const prev = prevGrayRef.current;
        let total = 0;
        let changedPixels = 0;
        for (let i = 0; i < size; i++) {
          const d = Math.abs(gray[i] - prev[i]);
          total += d;
          if (d > 25) changedPixels += 1;
        }
        const avgDiff = total / size;
        const changedRatio = (changedPixels / size) * 100;
        const threshold = sensitivityToThreshold(sensitivityRef.current);
        // Motion if avg brightness diff crosses threshold OR many pixels changed
        const isMotion = avgDiff > threshold || changedRatio > threshold;
        if (isMotion) {
          triggerMotion(pic.uri);
        }
      }
      prevGrayRef.current = gray;
    } catch {
      // swallow errors from transient camera issues
    } finally {
      busyRef.current = false;
    }
  }, []);

  const analyzeAndSpeak = useCallback(async (uri: string) => {
    setAnalyzing(true);
    try {
      const snap = await ImageManipulator.manipulateAsync(
        uri,
        [{ resize: { width: ANALYZE_SIZE_W, height: ANALYZE_SIZE_H } }],
        {
          compress: 0.6,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        }
      );
      if (!snap.base64) throw new Error("no snapshot");

      const resp = await fetch(`${BACKEND_URL}/api/analyze-motion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: snap.base64 }),
      });
      if (!resp.ok) throw new Error(`http ${resp.status}`);
      const data = (await resp.json()) as {
        classification: "person" | "pet" | "vehicle" | "other";
        description: string;
        spoken_alert: string;
      };

      setClassification(data.classification);
      setLastDescription(data.description);

      setTtsSpeaking(true);
      Speech.stop();
      Speech.speak(data.spoken_alert || "Motion detected", {
        rate: 1.0,
        pitch: 1.0,
        onDone: () => setTtsSpeaking(false),
        onStopped: () => setTtsSpeaking(false),
        onError: () => setTtsSpeaking(false),
      });
    } catch {
      // Fallback: generic voice alert
      setClassification("other");
      setLastDescription("Movement observed in the scene.");
      setTtsSpeaking(true);
      Speech.stop();
      Speech.speak("Motion detected", {
        rate: 1.0,
        pitch: 1.0,
        onDone: () => setTtsSpeaking(false),
        onStopped: () => setTtsSpeaking(false),
        onError: () => setTtsSpeaking(false),
      });
    } finally {
      setAnalyzing(false);
    }
  }, []);

  const triggerMotion = useCallback(
    (uri?: string) => {
      setMotionDetected(true);
      if (motionResetRef.current) clearTimeout(motionResetRef.current);
      motionResetRef.current = setTimeout(() => setMotionDetected(false), 2500);

      Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Warning
      ).catch(() => {});

      const now = Date.now();
      if (now - lastTTSRef.current > TTS_COOLDOWN_MS) {
        lastTTSRef.current = now;
        if (uri) {
          // fire-and-forget async analysis + TTS
          analyzeAndSpeak(uri);
        } else {
          setTtsSpeaking(true);
          Speech.stop();
          Speech.speak("Motion detected", {
            rate: 1.0,
            pitch: 1.0,
            onDone: () => setTtsSpeaking(false),
            onStopped: () => setTtsSpeaking(false),
            onError: () => setTtsSpeaking(false),
          });
        }
      }
    },
    [analyzeAndSpeak]
  );

  const runLoop = useCallback(() => {
    if (!isMonitoringRef.current) return;
    processFrame().finally(() => {
      if (!isMonitoringRef.current) return;
      loopRef.current = setTimeout(runLoop, CAPTURE_INTERVAL_MS);
    });
  }, [processFrame]);

  const startMonitoring = useCallback(() => {
    if (!cameraReady) return;
    prevGrayRef.current = null;
    setIsMonitoring(true);
    isMonitoringRef.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    // Give camera a moment to be responsive
    loopRef.current = setTimeout(runLoop, 300);
  }, [cameraReady, runLoop]);

  const stopMonitoring = useCallback(() => {
    setIsMonitoring(false);
    isMonitoringRef.current = false;
    setMotionDetected(false);
    setTtsSpeaking(false);
    setAnalyzing(false);
    setClassification(null);
    setLastDescription("");
    if (loopRef.current) {
      clearTimeout(loopRef.current);
      loopRef.current = null;
    }
    if (motionResetRef.current) {
      clearTimeout(motionResetRef.current);
      motionResetRef.current = null;
    }
    Speech.stop();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    prevGrayRef.current = null;
  }, []);

  // ---- Permission gating ----
  if (!permission) {
    return (
      <View style={styles.loadingContainer} testID="permission-loading">
        <ActivityIndicator color={C.brand} size="large" />
        <Text style={styles.loadingText}>INITIALIZING OPTICS...</Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={styles.permissionContainer} testID="permission-screen">
        <Image
          source={{
            uri: "https://images.unsplash.com/photo-1532190872407-280735d27e08?crop=entropy&cs=srgb&fm=jpg&ixid=M3w3NTY2NzB8MHwxfHNlYXJjaHwxfHxkYXJrJTIwYWJzdHJhY3QlMjB0ZWNoJTIwZ2VvbWV0cmljJTIwYmFja2dyb3VuZHxlbnwwfHx8fDE3ODQwODYyNDN8MA&ixlib=rb-4.1.0&q=85",
          }}
          style={StyleSheet.absoluteFillObject}
          contentFit="cover"
        />
        <LinearGradient
          colors={["rgba(9,9,11,0.35)", "rgba(9,9,11,0.95)"]}
          style={StyleSheet.absoluteFillObject}
          locations={[0, 0.7]}
        />
        <SafeAreaView style={styles.permissionInner} edges={["bottom"]}>
          <View style={styles.permissionBadge}>
            <Ionicons name="videocam-outline" size={16} color={C.brand} />
            <Text style={styles.permissionBadgeText}>MOTIONALERT HUD</Text>
          </View>
          <Text style={styles.permissionTitle}>CAMERA ACCESS REQUIRED</Text>
          <Text style={styles.permissionSubtitle}>
            Grant camera access to activate live motion tracking and voice
            alerts.
          </Text>
          <Pressable
            testID="grant-permission-button"
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && styles.primaryBtnPressed,
            ]}
            onPress={requestPermission}
          >
            <Text style={styles.primaryBtnText}>ENABLE CAMERA</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    );
  }

  // ---- Live feed ----
  return (
    <View style={styles.root} testID="live-feed-screen">
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFillObject}
        facing="back"
        onCameraReady={() => setCameraReady(true)}
      />

      {/* Top scrim */}
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(9,9,11,0.85)", "rgba(9,9,11,0)"]}
        style={[styles.topScrim, { height: 140 + insets.top }]}
      />

      {/* Bottom scrim */}
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(9,9,11,0)", "rgba(9,9,11,0.92)"]}
        style={[styles.bottomScrim, { height: 280 + insets.bottom }]}
      />

      {/* Reticle */}
      <View pointerEvents="none" style={styles.reticleWrap}>
        <Animated.View
          style={[
            styles.reticle,
            motionDetected ? styles.reticleAlert : styles.reticleIdle,
            motionDetected && reticleStyle,
          ]}
        >
          <View
            style={[
              styles.corner,
              styles.cornerTL,
              motionDetected && styles.cornerAlert,
            ]}
          />
          <View
            style={[
              styles.corner,
              styles.cornerTR,
              motionDetected && styles.cornerAlert,
            ]}
          />
          <View
            style={[
              styles.corner,
              styles.cornerBL,
              motionDetected && styles.cornerAlert,
            ]}
          />
          <View
            style={[
              styles.corner,
              styles.cornerBR,
              motionDetected && styles.cornerAlert,
            ]}
          />
          <Text
            style={[
              styles.reticleCross,
              motionDetected && { color: C.brand },
            ]}
          >
            +
          </Text>
        </Animated.View>
      </View>

      {/* Top HUD */}
      <SafeAreaView style={styles.topHud} edges={["top"]} pointerEvents="box-none">
        <View style={styles.topRow}>
          <View style={styles.appTag} testID="app-tag">
            <View style={styles.appTagDot} />
            <Text style={styles.appTagText}>MOTIONALERT</Text>
          </View>
        </View>

        <View style={styles.statusPillWrap} pointerEvents="none">
          <View
            testID="status-pill"
            style={[
              styles.statusPill,
              motionDetected ? styles.statusPillAlert : styles.statusPillIdle,
            ]}
          >
            <Animated.View
              style={[
                styles.statusDot,
                {
                  backgroundColor: motionDetected ? C.brand : C.success,
                },
                motionDetected && dotStyle,
              ]}
            />
            <Text
              style={[
                styles.statusText,
                { color: motionDetected ? C.onBrandTertiary : C.onSurface },
              ]}
              testID="status-text"
            >
              {isMonitoring
                ? motionDetected
                  ? "MOTION DETECTED"
                  : "MONITORING"
                : "STANDBY"}
            </Text>
          </View>

          {classification && (
            <View
              testID="classification-badge"
              style={[
                styles.classBadge,
                {
                  backgroundColor:
                    classification === "person"
                      ? "rgba(239,68,68,0.18)"
                      : "rgba(24,24,27,0.85)",
                  borderColor:
                    classification === "person" ? C.brandPrimary : C.border,
                },
              ]}
            >
              <Ionicons
                name={
                  classification === "person"
                    ? "person"
                    : classification === "pet"
                      ? "paw"
                      : classification === "vehicle"
                        ? "car"
                        : "help-circle"
                }
                size={12}
                color={C.onSurface}
              />
              <Text style={styles.classBadgeText}>
                {classification.toUpperCase()}
              </Text>
              {analyzing && (
                <ActivityIndicator
                  size="small"
                  color={C.onSurface}
                  style={{ marginLeft: 4 }}
                />
              )}
            </View>
          )}
          {!classification && analyzing && (
            <View
              testID="analyzing-badge"
              style={[
                styles.classBadge,
                { backgroundColor: "rgba(24,24,27,0.85)", borderColor: C.border },
              ]}
            >
              <ActivityIndicator size="small" color={C.brand} />
              <Text style={styles.classBadgeText}>ANALYZING…</Text>
            </View>
          )}
        </View>
      </SafeAreaView>

      {/* Bottom control panel */}
      <SafeAreaView
        style={styles.bottomHud}
        edges={["bottom"]}
        pointerEvents="box-none"
      >
        <View style={styles.controlPanel} testID="control-panel">
          <View style={styles.sensitivityRow}>
            <Text style={styles.sectionLabel}>SENSITIVITY</Text>
            <Text style={styles.sensitivityValue} testID="sensitivity-value">
              {Math.round(sensitivity)}%
            </Text>
          </View>
          <Slider
            testID="sensitivity-slider"
            style={styles.slider}
            minimumValue={0}
            maximumValue={100}
            value={sensitivity}
            step={1}
            onValueChange={(v) => setSensitivity(v)}
            onSlidingStart={() => {
              Haptics.selectionAsync().catch(() => {});
            }}
            minimumTrackTintColor={C.brand}
            maximumTrackTintColor={C.borderStrong}
            thumbTintColor={C.onSurface}
          />

          <View style={styles.actionsRow}>
            <View style={styles.ttsIndicator} testID="tts-indicator">
              <Animated.View style={[styles.ttsIconWrap, ttsIconStyle]}>
                <Ionicons
                  name={ttsSpeaking ? "volume-high" : "volume-medium-outline"}
                  size={20}
                  color={ttsSpeaking ? C.brand : C.onSurfaceSecondary}
                />
              </Animated.View>
              <Text style={styles.ttsLabel}>
                {ttsSpeaking ? "ALERTING" : "VOICE READY"}
              </Text>
            </View>

            <Pressable
              testID="toggle-monitor-button"
              accessibilityRole="button"
              onPress={isMonitoring ? stopMonitoring : startMonitoring}
              disabled={!cameraReady}
              style={({ pressed }) => [
                styles.toggleBtn,
                isMonitoring ? styles.toggleBtnStop : styles.toggleBtnStart,
                !cameraReady && styles.toggleBtnDisabled,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Ionicons
                name={isMonitoring ? "stop" : "play"}
                size={18}
                color={isMonitoring ? C.onBrandPrimary : C.onSurfaceInverse}
              />
              <Text
                style={[
                  styles.toggleBtnText,
                  {
                    color: isMonitoring ? C.onBrandPrimary : C.onSurfaceInverse,
                  },
                ]}
              >
                {isMonitoring ? "STOP" : "START"}
              </Text>
            </Pressable>
          </View>

          <Text style={styles.hint} testID="hint-text">
            {isMonitoring
              ? lastDescription
                ? `"${lastDescription}"`
                : "Point camera at area. Voice alert plays through connected earphones or speaker."
              : "Tap START to begin real-time AI-powered motion tracking."}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const C_onSurfaceInverse = "#09090B";

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.surface,
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: C.surface,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  loadingText: {
    color: C.onSurfaceSecondary,
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: "600",
  },
  // Permission screen
  permissionContainer: {
    flex: 1,
    backgroundColor: C.surface,
  },
  permissionInner: {
    flex: 1,
    justifyContent: "flex-end",
    paddingHorizontal: 24,
    paddingBottom: 32,
    gap: 16,
  },
  permissionBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: "rgba(24,24,27,0.85)",
    borderColor: C.border,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    gap: 6,
  },
  permissionBadgeText: {
    color: C.onSurface,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: "700",
  },
  permissionTitle: {
    color: C.onSurface,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: 1,
    lineHeight: 32,
  },
  permissionSubtitle: {
    color: C.onSurfaceSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 8,
  },
  primaryBtn: {
    backgroundColor: C.brandPrimary,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnPressed: {
    backgroundColor: C.brand,
  },
  primaryBtnText: {
    color: C.onBrandPrimary,
    fontWeight: "800",
    letterSpacing: 2,
    fontSize: 14,
  },

  // Scrims
  topScrim: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  bottomScrim: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },

  // Top HUD
  topHud: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  appTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "rgba(24,24,27,0.75)",
    borderColor: C.border,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
  },
  appTagDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.brand,
  },
  appTagText: {
    color: C.onSurface,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "700",
  },
  statusPillWrap: {
    alignItems: "center",
    marginTop: 16,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  statusPillIdle: {
    backgroundColor: "rgba(24,24,27,0.55)",
    borderColor: C.border,
  },
  statusPillAlert: {
    backgroundColor: C.brandTertiary,
    borderColor: C.brandPrimary,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    letterSpacing: 2.5,
    fontWeight: "800",
  },
  classBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: "center",
  },
  classBadgeText: {
    color: C.onSurface,
    fontSize: 10,
    letterSpacing: 2,
    fontWeight: "800",
  },

  // Reticle
  reticleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  reticle: {
    width: 180,
    height: 180,
    alignItems: "center",
    justifyContent: "center",
  },
  reticleIdle: {
    opacity: 0.45,
  },
  reticleAlert: {},
  reticleCross: {
    color: C.onSurface,
    fontSize: 26,
    fontWeight: "300",
  },
  corner: {
    position: "absolute",
    width: 22,
    height: 22,
    borderColor: C.onSurface,
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 2,
    borderLeftWidth: 2,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 2,
    borderRightWidth: 2,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2,
    borderRightWidth: 2,
  },
  cornerAlert: {
    borderColor: C.brand,
  },

  // Bottom HUD
  bottomHud: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  controlPanel: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 16,
    borderRadius: 20,
    backgroundColor: "rgba(24,24,27,0.9)",
    borderColor: C.border,
    borderWidth: 1,
    gap: 12,
  },
  sensitivityRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionLabel: {
    color: C.onSurfaceSecondary,
    fontSize: 11,
    letterSpacing: 2.5,
    fontWeight: "700",
  },
  sensitivityValue: {
    color: C.onSurface,
    fontSize: 16,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },
  slider: {
    width: "100%",
    height: Platform.select({ ios: 30, android: 40 }),
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
    gap: 12,
  },
  ttsIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  ttsIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.surfaceTertiary,
    alignItems: "center",
    justifyContent: "center",
    borderColor: C.border,
    borderWidth: 1,
  },
  ttsLabel: {
    color: C.onSurfaceSecondary,
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: "700",
  },
  toggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 12,
    minWidth: 140,
    justifyContent: "center",
  },
  toggleBtnStart: {
    backgroundColor: C.onSurface,
  },
  toggleBtnStop: {
    backgroundColor: C.brandPrimary,
  },
  toggleBtnDisabled: {
    opacity: 0.5,
  },
  toggleBtnText: {
    fontWeight: "800",
    letterSpacing: 2,
    fontSize: 14,
  },
  hint: {
    color: C.onSurfaceTertiary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.3,
    textAlign: "center",
    marginTop: 4,
  },
});

// helper reference (keeps type happy)
void C_onSurfaceInverse;
