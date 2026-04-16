// Build-time generator for /og-image.png (1200x630).
// Run via `npm run build:og` or implicitly during `npm run build`.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
// Static-weight TTFs from the `geist` package (the public/ woff2 is variable-
// weight, which satori's opentype parser can't read).
const FONT_REGULAR = resolve(
  ROOT,
  'node_modules/geist/dist/fonts/geist-sans/Geist-Regular.ttf',
);
const FONT_BOLD = resolve(
  ROOT,
  'node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf',
);
const OUT_PATH = resolve(ROOT, 'public/og-image.png');

// Tokens — kept in sync with src/styles/tokens.css (light variant).
// Hex equivalents of OKLch values used by the live site.
const COLOR = {
  background: '#f9f9f8',     // --background
  foreground: '#1c1c22',     // --foreground
  primary: '#5046e4',        // --primary (oklch 0.546 0.245 262.881)
  primaryFg: '#fbfbfb',      // --primary-foreground
  muted: '#737380',          // --muted-foreground
};

async function main() {
  const [fontRegular, fontBold] = await Promise.all([
    readFile(FONT_REGULAR),
    readFile(FONT_BOLD),
  ]);

  // Satori element tree (h, w, css-subset).
  const node = {
    type: 'div',
    props: {
      style: {
        width: '1200px',
        height: '630px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: COLOR.background,
        // Subtle primary radial tint at top-center (echoes Hero C1 treatment).
        backgroundImage: `radial-gradient(ellipse at 50% 0%, ${COLOR.primary}1f 0%, transparent 55%)`,
        fontFamily: 'Geist',
        position: 'relative',
        padding: '80px',
      },
      children: [
        // Logomark — primary rounded square with bold "B".
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '96px',
              height: '96px',
              borderRadius: '20px',
              backgroundColor: COLOR.primary,
              color: COLOR.primaryFg,
              fontSize: '64px',
              fontWeight: 700,
              marginBottom: '40px',
              letterSpacing: '-0.02em',
            },
            children: 'B',
          },
        },
        // Wordmark.
        {
          type: 'div',
          props: {
            style: {
              fontSize: '108px',
              fontWeight: 700,
              color: COLOR.foreground,
              letterSpacing: '-0.04em',
              lineHeight: 1.05,
              marginBottom: '24px',
            },
            children: 'Blind Bench',
          },
        },
        // Tagline.
        {
          type: 'div',
          props: {
            style: {
              fontSize: '36px',
              fontWeight: 400,
              color: COLOR.muted,
              letterSpacing: '-0.01em',
              textAlign: 'center',
              maxWidth: '900px',
              lineHeight: 1.3,
            },
            children: 'The blind taste test for AI',
          },
        },
      ],
    },
  };

  const svg = await satori(node, {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Geist', data: fontRegular, weight: 400, style: 'normal' },
      { name: 'Geist', data: fontBold, weight: 700, style: 'normal' },
    ],
  });

  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  })
    .render()
    .asPng();

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, png);

  const sizeKb = (png.byteLength / 1024).toFixed(1);
  console.log(`Generated ${OUT_PATH} (${sizeKb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
