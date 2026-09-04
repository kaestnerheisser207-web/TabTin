/**
 * Meeting system-audio Spike for macOS/Electron.
 *
 * Runs in an isolated Electron process, captures the primary display with the
 * desktopCapturer loopback contract, and measures real PCM samples while
 * macOS plays a built-in sound from a separate process. It does not persist
 * captured audio.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { STEALTH_ARGS } from '@muse/anti-detect';

const SAMPLE_DURATION_MS = 6_000;
const SYSTEM_SOUND_PATH = '/System/Library/Sounds/Glass.aiff';
const CAPTURE_PARTITION = process.env.MEETING_SPIKE_PARTITION?.trim() || '';
const PARALLEL_CAPTURE = process.env.MEETING_SPIKE_PARALLEL === '1';
const SYSTEM_PICKER_OPTION = process.env.MEETING_SPIKE_SYSTEM_PICKER?.trim();
const CAPTURE_URL = process.env.MEETING_SPIKE_URL?.trim() || '';
const LOAD_APP_PRELOAD = process.env.MEETING_SPIKE_PRELOAD === '1';
const PREFLIGHT_DISPLAY = process.env.MEETING_SPIKE_PREFLIGHT_DISPLAY === '1';
const POLICY_MODE = process.env.MEETING_SPIKE_POLICY?.trim() || 'permissive';
const APPLY_APP_FLAGS = process.env.MEETING_SPIKE_APP_FLAGS === '1';
const VIDEO_SOURCE_MODE =
  process.env.MEETING_SPIKE_VIDEO_SOURCE?.trim() || 'screen';

if (APPLY_APP_FLAGS) {
  const excluded = new Set([
    '--test-type',
    '--mute-audio',
    '--hide-scrollbars',
    '--lang',
    '--accept-lang',
    '--disable-threaded-animation',
    '--disable-threaded-scrolling',
    '--start-maximized',
    '--disable-logging',
    '--ignore-gpu-blocklist',
  ]);
  const enableFeatures = ['VaapiVideoDecoder'];
  const disableFeatures = ['UseChromeOSDirectVideoDecoder'];
  for (const flag of STEALTH_ARGS) {
    if (excluded.has(flag.split('=')[0])) continue;
    if (flag.startsWith('--enable-features=')) {
      enableFeatures.push(...flag.slice('--enable-features='.length).split(','));
      continue;
    }
    if (flag.startsWith('--disable-features=')) {
      disableFeatures.push(...flag.slice('--disable-features='.length).split(','));
      continue;
    }
    const separator = flag.indexOf('=');
    if (separator > 0) {
      app.commandLine.appendSwitch(
        flag.slice(2, separator),
        flag.slice(separator + 1),
      );
    } else {
      app.commandLine.appendSwitch(flag.replace(/^--/, ''));
    }
  }
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-features', enableFeatures.join(','));
  app.commandLine.appendSwitch('disable-features', disableFeatures.join(','));
}

const stopChildren = (children) => {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Best-effort cleanup only.
    }
  }
};

const playKnownSystemSound = () => {
  const children = [];
  const timer = setInterval(() => {
    children.push(
      spawn('/usr/bin/afplay', ['-v', '0.08', SYSTEM_SOUND_PATH], {
        stdio: 'ignore',
      }),
    );
  }, 700);

  return () => {
    clearInterval(timer);
    stopChildren(children);
  };
};

const installCapturePolicy = (captureSession) => {
  const normalizeOrigin = (candidate) => {
    const value = candidate?.trim();
    if (!value) return null;
    try {
      const url = new URL(value);
      return url.origin && url.origin !== 'null' ? url.origin : null;
    } catch {
      return null;
    }
  };
  const isTrustedOrigin = (candidate) => {
    const origin = normalizeOrigin(candidate);
    if (!origin) return false;
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
    );
  };
  captureSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin, details) => {
      const origin =
        normalizeOrigin(requestingOrigin) ??
        normalizeOrigin(details?.requestingUrl) ??
        normalizeOrigin(webContents?.getURL());
      const granted =
        POLICY_MODE === 'permissive' || isTrustedOrigin(origin);
      process.stderr.write(
        `[spike] permission-check ${JSON.stringify({ permission, requestingOrigin, requestingUrl: details?.requestingUrl, webContentsUrl: webContents?.getURL(), origin, granted })}\n`,
      );
      return granted;
    },
  );
  captureSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const origin =
        normalizeOrigin(details?.securityOrigin) ??
        normalizeOrigin(details?.requestingUrl) ??
        normalizeOrigin(webContents?.getURL());
      const granted =
        POLICY_MODE === 'permissive' || isTrustedOrigin(origin);
      process.stderr.write(
        `[spike] permission-request ${JSON.stringify({ permission, securityOrigin: details?.securityOrigin, requestingUrl: details?.requestingUrl, webContentsUrl: webContents?.getURL(), origin, granted })}\n`,
      );
      callback(granted);
    },
  );
  const handler = (request, callback) => {
    process.stderr.write(
      `[spike] display-request ${JSON.stringify({ securityOrigin: request.securityOrigin, videoRequested: request.videoRequested, audioRequested: request.audioRequested, hasFrame: Boolean(request.frame) })}\n`,
    );
    if (POLICY_MODE === 'formal' && !isTrustedOrigin(request.securityOrigin)) {
      callback({});
      return;
    }
    if (VIDEO_SOURCE_MODE === 'frame' && request.frame) {
      callback({ video: request.frame, audio: 'loopback' });
      return;
    }
    void desktopCapturer
      .getSources({
        types: ['screen'],
        fetchWindowIcons: false,
        thumbnailSize: { width: 0, height: 0 },
      })
      .then((sources) => {
        const source = sources.find((item) => item.display_id) ?? sources[0];
        if (!source) {
          callback({});
          return;
        }
        callback({ video: source, audio: 'loopback' });
      })
      .catch(() => callback({}));
  };
  if (SYSTEM_PICKER_OPTION === 'true' || SYSTEM_PICKER_OPTION === 'false') {
    captureSession.setDisplayMediaRequestHandler(handler, {
      useSystemPicker: SYSTEM_PICKER_OPTION === 'true',
    });
  } else {
    captureSession.setDisplayMediaRequestHandler(handler);
  }
};

const rendererProbe = async (durationMs, parallelCapture, preflightDisplay) => {
  const measure = async (stream, label) => {
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      return {
        label,
        audioTrackCount: 0,
        nonSilentFrames: 0,
        maxRms: 0,
      };
    }

    const context = new AudioContext();
    const source = context.createMediaStreamSource(
      new MediaStream([audioTrack]),
    );
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const samples = new Float32Array(analyser.fftSize);
    let maxRms = 0;
    let nonSilentFrames = 0;
    let measuredFrames = 0;

    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      const rms = Math.sqrt(sum / samples.length);
      maxRms = Math.max(maxRms, rms);
      if (rms >= 0.001) nonSilentFrames += 1;
      measuredFrames += 1;
    }, 50);

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    clearInterval(timer);
    source.disconnect();
    await context.close();

    return {
      label,
      audioTrackCount: stream.getAudioTracks().length,
      trackState: audioTrack.readyState,
      trackMuted: audioTrack.muted,
      settings: audioTrack.getSettings(),
      measuredFrames,
      nonSilentFrames,
      maxRms,
    };
  };

  const openDisplay = () => navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: {
        width: { ideal: 320 },
        height: { ideal: 180 },
        frameRate: { ideal: 1 },
      },
    });
  const openMicrophone = () => navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  let displayStream;
  let microphoneStream = null;
  let microphoneError = null;
  if (preflightDisplay) {
    const preflightStream = await openDisplay();
    preflightStream.getTracks().forEach((track) => track.stop());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (parallelCapture) {
    const [displayResult, microphoneResult] = await Promise.allSettled([
        openDisplay(),
        openMicrophone(),
      ]);
    if (displayResult.status === 'rejected') {
      throw displayResult.reason;
    }
    displayStream = displayResult.value;
    if (microphoneResult.status === 'fulfilled') {
      microphoneStream = microphoneResult.value;
    } else {
      const error = microphoneResult.reason;
      microphoneError = {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    displayStream = await openDisplay();
    try {
      microphoneStream = await openMicrophone();
    } catch (error) {
      microphoneError = {
        name: error instanceof Error ? error.name : 'UnknownError',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const [systemAudio, microphone] = await Promise.all([
    measure(displayStream, 'system'),
    microphoneStream
      ? measure(microphoneStream, 'microphone')
      : Promise.resolve({
          label: 'microphone',
          audioTrackCount: 0,
          nonSilentFrames: 0,
          maxRms: 0,
          error: microphoneError,
        }),
  ]);

  displayStream.getTracks().forEach((track) => track.stop());
  microphoneStream?.getTracks().forEach((track) => track.stop());

  return {
    systemAudio,
    microphone,
    simultaneousTracks:
      systemAudio.audioTrackCount > 0 && microphone.audioTrackCount > 0,
  };
};

const main = async () => {
  await app.whenReady();
  const captureSession = CAPTURE_PARTITION
    ? session.fromPartition(CAPTURE_PARTITION)
    : session.defaultSession;
  installCapturePolicy(captureSession);

  const window = new BrowserWindow({
    show: false,
    width: 480,
    height: 320,
    webPreferences: {
      ...(CAPTURE_PARTITION ? { partition: CAPTURE_PARTITION } : {}),
      ...(LOAD_APP_PRELOAD
        ? { preload: path.join(process.cwd(), 'out/preload/index.cjs') }
        : {}),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  if (CAPTURE_URL) {
    await window.loadURL(CAPTURE_URL);
  } else {
    await window.loadFile(
      path.join(scriptDir, 'meeting-system-audio-spike.html'),
    );
  }

  const stopSound = playKnownSystemSound();
  try {
    const result = await window.webContents.executeJavaScript(
      `(${rendererProbe.toString()})(${SAMPLE_DURATION_MS}, ${JSON.stringify(PARALLEL_CAPTURE)}, ${JSON.stringify(PREFLIGHT_DISPLAY)})`,
      true,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          platform: process.platform,
          osVersion: process.getSystemVersion(),
          electronVersion: process.versions.electron,
          partition: CAPTURE_PARTITION || 'defaultSession',
          captureStart: PARALLEL_CAPTURE ? 'parallel' : 'system-first',
          systemPickerOption: SYSTEM_PICKER_OPTION || 'omitted',
          policyMode: POLICY_MODE,
          appFlags: APPLY_APP_FLAGS,
          videoSourceMode: VIDEO_SOURCE_MODE,
          captureUrl: CAPTURE_URL || 'file://spike',
          preload: LOAD_APP_PRELOAD ? 'app' : 'none',
          preflightDisplay: PREFLIGHT_DISPLAY,
          sampleDurationMs: SAMPLE_DURATION_MS,
          ...result,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    stopSound();
    window.destroy();
    app.quit();
  }
};

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  app.exit(1);
});
