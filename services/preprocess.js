import path from 'path';
import sharp from 'sharp';

export async function preprocessChartImage(inputPath) {
  const outputBase = inputPath.replace(path.extname(inputPath), '');
  const analysisPath = `${outputBase}-analysis.jpg`;
  const ocrPath = `${outputBase}-ocr.png`;

  const image = sharp(inputPath, {
    failOn: 'none',
    limitInputPixels: 28_000_000,
  }).rotate();

  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) {
    throw Object.assign(new Error('Uploaded image could not be read.'), { statusCode: 400 });
  }

  await sharp(inputPath, { failOn: 'none', limitInputPixels: 28_000_000 })
    .rotate()
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .modulate({ brightness: 1.03, saturation: 1.08 })
    .sharpen({ sigma: 0.8, m1: 0.8, m2: 1.8 })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(analysisPath);

  await sharp(inputPath, { failOn: 'none', limitInputPixels: 28_000_000 })
    .rotate()
    .resize({ width: 2200, height: 2200, fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .normalize()
    .linear(1.22, -14)
    .sharpen()
    .png({ compressionLevel: 9, palette: true })
    .toFile(ocrPath);

  return {
    analysisPath,
    ocrPath,
    mimeType: 'image/jpeg',
    metadata: {
      width: metadata.width,
      height: metadata.height,
      format: metadata.format,
    },
  };
}
