import Busboy from 'busboy';
import sharp from 'sharp';
import path from 'node:path';
import { Readable } from 'node:stream';

export const runtime = 'nodejs';

export async function GET() {
  const candidates = ['jpeg', 'png', 'webp', 'tiff'];
  const supported = candidates.filter(f => sharp.format[f]?.output);
  return Response.json({ supported });
}

const ALLOWED = ['jpeg', 'jpg', 'png', 'webp', 'tiff'];
const normalize = f => (String(f || '').toLowerCase() === 'jpg' ? 'jpeg' : String(f || '').toLowerCase());
const SUPPORTED_OUTPUTS = new Set(Object.values(sharp.format).filter(f => f.output).map(f => f.id));

const ACCEPTED_INPUT_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
  'image/heif',
]);

function mimeFor(fmt) {
  return fmt === 'tiff' ? 'image/tiff' : `image/${fmt}`;
}

export async function POST(req) {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return new Response('Use multipart/form-data with a "file" field.', { status: 400 });
  }

  const url = new URL(req.url);
  const requested = (url.searchParams.get('format') || 'webp').toLowerCase();
  const format = normalize(requested);
  const quality = Number(url.searchParams.get('quality')) || 80;
  const w = Number(url.searchParams.get('w')) || undefined;
  const h = Number(url.searchParams.get('h')) || undefined;

  if (!ALLOWED.includes(requested) || !SUPPORTED_OUTPUTS.has(format)) {
    const supported = [...SUPPORTED_OUTPUTS].map(id => (id === 'jpeg' ? 'jpeg/jpg' : id)).join(', ');
    return new Response(`Unsupported output format "${requested}". Supported: ${supported}`, { status: 400 });
  }

  return await new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: { 'content-type': contentType },
      limits: { files: 1 },
    });

    let responded = false;

    bb.on('file', (_field, file, info) => {
      if (responded) {
        file.resume();
        return;
      }

      const srcMime = (info.mimeType || '').toLowerCase();
      if (!ACCEPTED_INPUT_MIME.has(srcMime)) {
        file.resume();
        return reject(new Error(`Unsupported input "${srcMime || 'unknown'}" (allowed: JPEG, PNG, WebP, TIFF)`));
      }

      let s = sharp({ failOn: 'none' }).toFormat(format, { quality });
      if (w || h) s = s.resize(w, h, { fit: 'cover', withoutEnlargement: false });

      const outExt = format === 'jpeg' ? '.jpg' : `.${format}`;
      const base = path.basename(info.filename || 'image', path.extname(info.filename || ''));
      const headers = {
        'content-type': mimeFor(format),
        'content-disposition': `attachment; filename="${base}${outExt}"`,
      };

      file.on('error', reject);
      s.on('error', reject);

      const body = Readable.toWeb(s);
      file.pipe(s);

      responded = true;
      resolve(new Response(body, { headers }));
    });

    bb.on('filesLimit', () => reject(new Error('Send exactly one file per request')));
    bb.on('error', reject);
    bb.on('finish', () => { if (!responded) reject(new Error('No file received')); });

    Readable.fromWeb(req.body).pipe(bb);
  }).catch(err => new Response(`Conversion failed: ${err.message}`, { status: 400 }));
}
