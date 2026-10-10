#!/usr/bin/env node
/**
 * Downloads the open-source, MIT-licensed face-api.js model weights used
 * for face detection, landmarks, and recognition. One-time step — run
 * this on the server (or during the Docker build) before starting the app.
 *
 * Usage: node scripts/download-face-models.mjs
 */
import fs from 'fs';
import path from 'path';
import https from 'https';

const MODELS_DIR = process.env.FACE_MODELS_DIR || path.join(process.cwd(), 'face-models');
const BASE_URL =
  'https://raw.githubusercontent.com/vladmandic/face-api/master/model';

const FILES = [
  'ssd_mobilenetv1_model-weights_manifest.json',
  'ssd_mobilenetv1_model.bin',
  'face_landmark_68_model-weights_manifest.json',
  'face_landmark_68_model.bin',
  'face_recognition_model-weights_manifest.json',
  'face_recognition_model.bin',
];

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return download(res.headers.location, destPath).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(destPath);
          return reject(new Error(`Failed to download ${url}: HTTP ${res.statusCode}`));
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      })
      .on('error', (err) => {
        file.close();
        if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        reject(err);
      });
  });
}

async function main() {
  if (!fs.existsSync(MODELS_DIR)) {
    fs.mkdirSync(MODELS_DIR, { recursive: true });
  }

  console.log(`Downloading face verification models into ${MODELS_DIR} ...`);
  for (const file of FILES) {
    const dest = path.join(MODELS_DIR, file);
    if (fs.existsSync(dest)) {
      console.log(`  [skip] ${file} already exists`);
      continue;
    }
    console.log(`  [get]  ${file}`);
    await download(`${BASE_URL}/${file}`, dest);
  }
  console.log('Done. Face models ready.');
}

main().catch((err) => {
  console.error('Model download failed:', err);
  process.exit(1);
});
