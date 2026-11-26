# Scene libraries for the browser harnesses

Copies of the scripts the XR scenes load from CDNs, so the Playwright
harnesses run offline and in CI (S15, #87). Nothing here ships in the VSIX:
the `files` allowlist does not include `test/`, and generated scenes still
load the CDN URLs. The Code-XR IDE also answers those URLs from this folder in
its scene view (`apps/ide/src/main/analysis/sceneLibraries.ts`, #16), so its
map must follow any version bump here too, and IDE packaging (#20) ships it.

`test/helpers/harnessBrowser.cjs` routes each CDN URL to the file below and
aborts every other external request, so a harness never touches the network.

| File | Package (npm) | Served for | License |
|---|---|---|---|
| `aframe-1.7.1.min.js` | `aframe@1.7.1` `dist/aframe-v1.7.1.min.js` | `aframe.io/releases/1.7.1/aframe(.min).js` | MIT |
| `aframe-babia-components-1.3.4.min.js` | `aframe-babia-components@1.3.4` `dist/` | `unpkg.com/aframe-babia-components@1.3.4/...` | GPL-3.0 |
| `aframe-extras-7.5.4.min.js` | `aframe-extras@7.5.4` `dist/` | `cdn.jsdelivr.net/gh/{c-frame,donmccurdy}/aframe-extras@...7.5.4/...` | MIT |
| `aframe-environment-component-1.5.0.min.js` | `aframe-environment-component@1.5.0` `dist/` | `unpkg.com/aframe-environment-component@1.5.0/...` | MIT |
| `aframe-geometry-merger-component-2.0.1.min.js` | `aframe-geometry-merger-component@2.0.1` `dist/` | `unpkg.com/aframe-geometry-merger-component@2.0.1/...` | MIT |
| `fonts/Roboto-msdf.json`, `fonts/Roboto-msdf.png` | A-Frame's hosted default text font (not on npm) | `cdn.aframe.io/fonts/Roboto-msdf.{json,png}` (used by the IDE scene view; the harnesses still abort it) | Roboto: Apache-2.0; A-Frame: MIT |
| `html2canvas-1.4.1.min.js` | `html2canvas@1.4.1` `dist/` | `cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/...` | MIT |

The license texts are in `licenses/`. To bump a version, take the file from
the npm tarball (`npm pack <name>@<version>`), rename it as above, and update
the map in `harnessBrowser.cjs` together with the scene templates.
