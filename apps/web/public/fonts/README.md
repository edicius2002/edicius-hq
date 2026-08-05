# Fonts

Edicius HQ uses **Berkeley Mono** (commercial license).

## Setup

1. Obtain a license from [Berkeley Graphics](https://berkeleygraphics.com/).
2. Copy the licensed files into this folder using these names when available:

- `BerkeleyMono-Regular.woff2` (or `.otf`)
- `BerkeleyMono-Medium.woff2` (or `.otf`)
- `BerkeleyMono-Bold.woff2` (or `.otf`)

3. Restart `npm run dev` / rebuild.

Binary font files in this directory are gitignored so unlicensed assets are not committed. If your license allows redistribution inside this private repo, you may force-add specific files intentionally.

Until files are present, the app falls back to locally installed Berkeley Mono (if any) and then system monospace stacks.
