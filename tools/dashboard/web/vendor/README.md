# Vendored libraries

Downloaded from the npm registry on 2026-11-22. Each tarball was checked against the
`dist.integrity` (sha512) of the registry metadata before use. No build step; files are
served from the same origin (CSP `default-src 'self'`).

| Library | Version | Licence | Source | Files |
|---|---|---|---|---|
| htm (+ bundled Preact and hooks) | 3.1.1 | Apache-2.0 (htm), MIT (bundled Preact) | https://registry.npmjs.org/htm/-/htm-3.1.1.tgz | `htm/standalone.module.js` (from `preact/standalone.module.js`), `htm/LICENSE.htm-Apache-2.0`, `htm/LICENSE.preact-MIT` |
| uPlot | 1.6.32 | MIT | https://registry.npmjs.org/uplot/-/uplot-1.6.32.tgz | `uplot/uPlot.iife.min.js`, `uplot/uPlot.min.css`, `uplot/LICENSE` |
| Leaflet | 1.9.4 | BSD-2-Clause | https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz | `leaflet/leaflet.js`, `leaflet/leaflet.css`, `leaflet/images/*`, `leaflet/LICENSE` |

Preact licence text: the exact Preact version inside htm 3.1.1's bundle is not recorded
(htm's devDependency is `preact ^10.2.0`); `LICENSE.preact-MIT` is taken from npm package
`preact@10.6.4` (integrity verified). The Preact MIT text is the same in all 10.x releases.

## sha256

```
740725f7252e750af735d0028cc534970772f513331e9f68150fede8fb3ce00f  htm/LICENSE.htm-Apache-2.0
b3ca27c284ef966111e4e2275e3b15efe46775089c6516045a30646829710a1c  htm/LICENSE.preact-MIT
72284e8e9079c87817145df1110f74e8a2aa040b2fc384922e18dfcb46fc1fd7  htm/standalone.module.js
8f989229699b4fe2f1a0432d0e9edc338a8a911e250e2d1b01ecd770a5f5b1bd  uplot/LICENSE
19c8d4c6ad88929a79f4ae49d6f7161566dfd0ba3d15cc495e974f787eb78f1f  uplot/uPlot.iife.min.js
df630c6a8d6f8eeaff264b50f73ce5b114f646ffd9a0bb74f049b0a00135fa04  uplot/uPlot.min.css
53e8dc25862014e4324741ca18fbe3611e11d42ef69f59f86ea8c5389647d4cb  leaflet/LICENSE
db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a  leaflet/leaflet.js
a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6  leaflet/leaflet.css
066daca850d8ffbef007af00b06eac0015728dee279c51f3cb6c716df7c42edf  leaflet/images/layers-2x.png
1dbbe9d028e292f36fcba8f8b3a28d5e8932754fc2215b9ac69e4cdecf5107c6  leaflet/images/layers.png
00179c4c1ee830d3a108412ae0d294f55776cfeb085c60129a39aa6fc4ae2528  leaflet/images/marker-icon-2x.png
574c3a5cca85f4114085b6841596d62f00d7c892c7b03f28cbfa301deb1dc437  leaflet/images/marker-icon.png
264f5c640339f042dd729062cfc04c17f8ea0f29882b538e3848ed8f10edb4da  leaflet/images/marker-shadow.png
```

## Licence policy

Only MIT, BSD, ISC or Apache-2.0 libraries may be added. The engine is under the
Artistic License 1.0; no GPL or LGPL code.
