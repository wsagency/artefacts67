# Provenance of the vendored WS Agency design kit files

- Kit: https://design.ws.agency/, version **v1.4.2**, web-source commit `acb534558e81dc00e8c0c2b7f4eef28596f16b41` (`/version.json`), fetched 2026-10-12.
- Identity: Original. Files are vendored, never hotlinked. Bytes and sha256 below are computed from the committed files.
- Upstream paths are relative to `https://design.ws.agency/`. Repo paths are relative to the repository root.
- Check the verbatim and renamed rows from the repository root: `grep -E '\| (verbatim|renamed)' assets/ws-design-kit/PROVENANCE.md | awk -F'`' '{print $6 "  " $2}' | sha256sum -c`.

| Repo path | Upstream path | Bytes | sha256 | Licence | Modification |
|---|---|---|---|---|---|
| `assets/ws-design-kit/tokens.css` | `tokens/tokens.css` | 4474 | `2b8b968e9a375bd0424b9fdf05f6df6290afb04e1aca11eb0bf5943d987533b4` | kit MIT (`LICENSE-CODE`) | verbatim |
| `assets/ws-design-kit/footer.css` | `examples/footer.css` | 1656 | `3ad4ec048eff6a28602f963ca97d4cab8081ea88757f004851e3c51c19dcecbc` | kit MIT (`LICENSE-CODE`) | verbatim |
| `assets/ws-design-kit/LICENSE-CODE` | `LICENSE-CODE` | 1239 | `f1a61c0000768d8cde188a5b607c4fa38f2ce092866e56f4a736241122f16fd9` | — | verbatim |
| `assets/ws-design-kit/fonts/manrope/Manrope-wght.woff2` | `assets/fonts/manrope/web/Manrope[wght].woff2` | 53892 | `30b83738add8c9edd9e3450b98036a9a8fb5668d0cbd4eb0ce5fe6761197f21f` | OFL 1.1 | renamed from `Manrope[wght].woff2` |
| `assets/ws-design-kit/fonts/manrope/OFL.txt` | `assets/fonts/manrope/OFL.txt` | 4387 | `58172e0c0fac2cda8a37b348164bb55e44b0e69051e557e92b1d3f6910141f7b` | — | verbatim |
| `assets/ws-design-kit/fonts/ibm-plex-mono/IBMPlexMono-Regular.woff2` | `assets/fonts/ibm-plex-mono/web/IBMPlexMono-Regular.woff2` | 39176 | `13b16cd770a73f60304510221c3e7186d396ba6ca5d64c52b5c6fb983d0e900a` | OFL 1.1 | verbatim |
| `assets/ws-design-kit/fonts/ibm-plex-mono/IBMPlexMono-Medium.woff2` | `assets/fonts/ibm-plex-mono/web/IBMPlexMono-Medium.woff2` | 40080 | `0498bcb48294756b5ac9062290e1639e907b1ec69b5dc2e8cfdec3fab58e0bc8` | OFL 1.1 | verbatim |
| `assets/ws-design-kit/fonts/ibm-plex-mono/IBMPlexMono-SemiBold.woff2` | `assets/fonts/ibm-plex-mono/web/IBMPlexMono-SemiBold.woff2` | 41136 | `5148e1fccb46851e8a7dcc489ff7d3d5e54717ee72e2865c2fa225e3fc4744e8` | OFL 1.1 | verbatim |
| `assets/ws-design-kit/fonts/ibm-plex-mono/IBMPlexMono-Bold.woff2` | `assets/fonts/ibm-plex-mono/web/IBMPlexMono-Bold.woff2` | 40348 | `9f9e5597981645d576b209a25021c5221e8644a4580581f44e8b4ef954d95d03` | OFL 1.1 | verbatim |
| `assets/ws-design-kit/fonts/ibm-plex-mono/OFL.txt` | `assets/fonts/ibm-plex-mono/OFL.txt` | 4456 | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` | — (Reserved Font Name "Plex") | verbatim |
| `assets/ws-design-kit/logos/original/sign-color.svg` | `assets/logos/original/sign-color.svg` | 1133 | `73e94d1706fc61329bfe11d5e00fdc0b522bbddcbf5ddbba0cd5289b4c63fd69` | WS brand artwork | verbatim |
| `assets/ws-design-kit/logos/original/sign-white.svg` | `assets/logos/original/sign-white.svg` | 1133 | `f3e960eafbd9202aacc216dc3a4995fddc14e109d7e6d8ffc5c0f45c28fda72c` | WS brand artwork | verbatim |
| `assets/ws-design-kit/badges/original/open-source-light.svg` | `assets/badges/original/open-source-light.svg` | 40425 | `5f761741a5e70a0bd4b0e6998c015199dda4675614b25528cd7e20ee99385908` | WS brand artwork | verbatim |
| `assets/ws-design-kit/products/artefacts67/original/logo-color.svg` | `assets/products/artefacts67/original/logo-color.svg` | 14303 | `ca472a7b5fc494ce44acb9f85c0460fd79728734112255e7de8fc082ab58a174` | WS Agency product artwork | verbatim |
| `assets/ws-design-kit/products/artefacts67/original/logo-white.svg` | `assets/products/artefacts67/original/logo-white.svg` | 14303 | `1aa5b0d78618a9c5ff58c44baafbadb86ec6ae77193b1317adc00994f58e8018` | WS Agency product artwork | verbatim |
| `assets/ws-design-kit/products/artefacts67/original/favicon.svg` | `assets/products/artefacts67/original/favicon.svg` | 471 | `1e7ea8227d79ba403a43522e2cd5649b581b098e96991ce7842ef511282deebf` | WS Agency product artwork | verbatim |
| `assets/ws-design-kit/fonts.css` | `assets/fonts/fonts.css` (3389 bytes, sha256 `e0e18a501204d43dd233dbc3a2122d77f919ff6bea0d59fa3fb552c5edfa4c23`) | 882 | `cd9a3b5c78f1b7da9819d3bff73e63055f820018f674f06060d2b4b8f1725499` | kit MIT (`LICENSE-CODE`) | derived: 19 → 5 rules, paths rewritten |
| `assets/favicon.ico` | `assets/products/artefacts67/original/favicon-color-16.png` 574 bytes `0c16a920154b3c2a58bbdddcf922a61115208d344092e8aa7cada7256f597a89`; `assets/products/artefacts67/original/favicon-color-32.png` 938 bytes `cd246a8e637a9282dfda0199f577472327360c495e68179f31117665affc98ff`; `assets/products/artefacts67/original/favicon-color-48.png` 1519 bytes `9e4fbf547a49fccdd90fc3d275fcd7aa3342bd34d7933dda3ae4808d0c704046` | 3085 | `01010ea1e4e5e9310bf8c5eca22ee6cbcaca839e16a1247be30d4abbf18f56da` | WS Agency product artwork | derived: PNG-entry ICO of the three PNGs (command below) |

`assets/favicon.ico` is rebuilt deterministically from the three kit PNGs (no dependency, Node only; run from the repository root):

```sh
b=https://design.ws.agency/assets/products/artefacts67/original
for s in 16 32 48; do curl -fsSO "$b/favicon-color-$s.png"; done   # check sha256 against the row above
node -e '
const fs = require("fs"), pngs = process.argv.slice(1).map(f => fs.readFileSync(f));
const head = Buffer.alloc(6 + 16 * pngs.length); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let at = head.length;
pngs.forEach((p, i) => { const e = 6 + 16 * i; head[e] = p.readUInt32BE(16) % 256; head[e + 1] = p.readUInt32BE(20) % 256;
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(p.length, e + 8); head.writeUInt32LE(at, e + 12); at += p.length; });
fs.writeFileSync("assets/favicon.ico", Buffer.concat([head, ...pngs]));' favicon-color-16.png favicon-color-32.png favicon-color-48.png
```

Licences: the CSS files are under the kit's MIT notice (`assets/ws-design-kit/LICENSE-CODE`), which excludes brand artwork, logos, derived logo compositions and font binaries; the fonts are under the SIL Open Font License 1.1 (`assets/ws-design-kit/fonts/*/OFL.txt`; IBM Plex Mono reserves the font name "Plex"); the WS Agency sign, the badge and the Artefacts67 product artwork (including `assets/favicon.ico`) are WS Agency brand artwork, used under the kit's usage rules and `TRADEMARKS.md`.
