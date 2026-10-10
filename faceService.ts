/**
 * Self-hosted face verification.
 *
 * Uses @vladmandic/face-api running on the tfjs-node backend. Fully
 * open-source (MIT), runs entirely on our own server, no per-request cost,
 * no biometric data ever leaves our infrastructure.
 *
 * This performs 1:1 VERIFICATION only: the driver claims an employee code,
 * we load THAT employee's stored 128-d face descriptor and compare it
 * against the live selfie. We never run a 1:N search across all drivers.
 *
 * Model files (ssd_mobilenetv1, face_landmark_68, face_recognition) are
 * downloaded once into MODELS_DIR by `npm run models:download` (see
 * scripts/download-face-models.mjs). They are NOT bundled in source control.
 */
import path from 'path';
import fs from 'fs';
// @tensorflow/tfjs-node MUST be imported before @vladmandic/face-api so the
// native 'tensorflow' backend registers itself (see face-api NodeJS docs).
import '@tensorflow/tfjs-node';
import canvas from 'canvas';
import * as faceapi from '@vladmandic/face-api';

const MODELS_DIR = process.env.FACE_MODELS_DIR || path.join(process.cwd(), 'face-models');

let modelsLoaded = false;

export async function loadFaceModels(): Promise<void> {
  if (modelsLoaded) return;

  if (!fs.existsSync(MODELS_DIR)) {
    throw new Error(
      `Face model directory not found at ${MODELS_DIR}. Run "npm run models:download" before starting the server.`
    );
  }

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODELS_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODELS_DIR);

  modelsLoaded = true;
  console.log('Face verification models loaded from', MODELS_DIR);
}

export function areFaceModelsLoaded(): boolean {
  return modelsLoaded;
}

function parseDataUrlToBuffer(dataUrl: string): Buffer {
  const commaIdx = dataUrl.indexOf(',');
  const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

export interface FaceDetectionResult {
  ok: boolean;
  reason?: 'NO_FACE' | 'MULTIPLE_FACES' | 'LOW_QUALITY';
  descriptor?: Float32Array;
  landmarks?: faceapi.FaceLandmarks68;
  detectionScore?: number;
}

/**
 * Detects exactly one face in the image and returns its 128-d descriptor
 * plus landmarks (used separately for liveness/head-pose checks).
 */
export async function detectFace(imageBase64OrDataUrl: string): Promise<FaceDetectionResult> {
  if (!modelsLoaded) {
    await loadFaceModels();
  }

  const buffer = parseDataUrlToBuffer(imageBase64OrDataUrl);
  const img = await canvas.loadImage(buffer);
  const c = canvas.createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img as any, 0, 0, img.width, img.height);

  const detections = await faceapi
    .detectAllFaces(c as any, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.6 }))
    .withFaceLandmarks()
    .withFaceDescriptors();

  if (detections.length === 0) {
    return { ok: false, reason: 'NO_FACE' };
  }
  if (detections.length > 1) {
    return { ok: false, reason: 'MULTIPLE_FACES' };
  }

  const d = detections[0];
  return {
    ok: true,
    descriptor: d.descriptor,
    landmarks: d.landmarks,
    detectionScore: d.detection.score,
  };
}

/**
 * Euclidean distance between two 128-d descriptors (face-api standard metric).
 * Lower = more similar. face-api's own reference threshold is ~0.6 for
 * "same person" on unconstrained photos; we expose a configurable threshold
 * via company_settings instead of hard-coding it.
 */
export function euclideanDistance(a: Float32Array | number[], b: Float32Array | number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Converts a raw euclidean distance into an intuitive 0..1 "similarity"
 * score for storage/display purposes only. Matching decisions should use
 * the raw distance vs. the configured max-distance threshold, not this
 * derived score.
 */
export function distanceToSimilarity(distance: number): number {
  return Math.max(0, Math.min(1, 1 - distance / 1.2));
}

export interface VerifyResult {
  matched: boolean;
  distance: number;
  similarity: number;
}

/**
 * 1:1 verification: compare a live descriptor against ONE stored descriptor.
 * `maxDistance` comes from company_settings (derived from faceMatchThreshold).
 */
export function verifyDescriptor(
  liveDescriptor: Float32Array,
  storedDescriptor: number[],
  maxDistance: number
): VerifyResult {
  const distance = euclideanDistance(liveDescriptor, storedDescriptor);
  return {
    matched: distance <= maxDistance,
    distance,
    similarity: distanceToSimilarity(distance),
  };
}

// ── Liveness: simple head-turn challenge-response ───────────────────────
// No paid liveness API. The driver is asked to turn their head left or
// right; we compare the horizontal position of the nose relative to the
// midpoint of the eyes between a "center" reference frame and the
// "challenge" frame. A photo held up to the camera cannot reproduce this
// relative movement without the attacker physically tilting the photo,
// which materially raises the bar versus a static photo alone.
//
// LIMITATION (documented per spec, not glossed over): this is NOT
// equivalent to commercial bank-grade liveness detection (no depth sensing,
// no texture/moire analysis, no 3D reconstruction). It stops the most
// common/cheap spoof (holding up a printed or phone photo without moving
// it) but a sufficiently motivated attacker with video of the driver could
// still attempt to defeat it. If higher assurance is required later, the
// recommended upgrade path is a commercial liveness API (see README cost
// comparison) — this can be added later without changing the schema.
export function estimateHeadYawRatio(landmarks: faceapi.FaceLandmarks68): number {
  const leftEye = landmarks.getLeftEye();
  const rightEye = landmarks.getRightEye();
  const nose = landmarks.getNose();

  const eyeMidX = (avgX(leftEye) + avgX(rightEye)) / 2;
  const eyeSpan = Math.abs(avgX(rightEye) - avgX(leftEye)) || 1;
  const noseX = avgX(nose);

  // Positive = nose shifted toward the right eye (person turned head to
  // their own left, our right on screen), negative = the opposite.
  return (noseX - eyeMidX) / eyeSpan;
}

function avgX(points: { x: number; y: number }[]): number {
  return points.reduce((sum, p) => sum + p.x, 0) / points.length;
}

/**
 * Given a "center" yaw ratio and a "challenge" yaw ratio, decide whether
 * the driver actually turned their head in the requested direction.
 */
export function checkLivenessTurn(
  centerYaw: number,
  challengeYaw: number,
  direction: 'LEFT' | 'RIGHT',
  minShift = 0.12
): boolean {
  const shift = challengeYaw - centerYaw;
  return direction === 'LEFT' ? shift <= -minShift : shift >= minShift;
}
