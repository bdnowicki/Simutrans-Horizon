# Vendored libraries

Downloaded from the npm registry on 2026-11-22 (three.js on 2026-11-24). Each tarball was checked
against the `dist.integrity` (sha512) of the registry metadata before use. No build step; files are
served from the same origin (CSP `default-src 'self'`).

| Library | Version | Licence | Source | Files |
|---|---|---|---|---|
| htm (+ bundled Preact and hooks) | 3.1.1 | Apache-2.0 (htm), MIT (bundled Preact) | https://registry.npmjs.org/htm/-/htm-3.1.1.tgz | `htm/standalone.module.js` (from `preact/standalone.module.js`), `htm/LICENSE.htm-Apache-2.0`, `htm/LICENSE.preact-MIT` |
| uPlot | 1.6.32 | MIT | https://registry.npmjs.org/uplot/-/uplot-1.6.32.tgz | `uplot/uPlot.iife.min.js`, `uplot/uPlot.min.css`, `uplot/LICENSE` |
| Leaflet | 1.9.4 | BSD-2-Clause | https://registry.npmjs.org/leaflet/-/leaflet-1.9.4.tgz | `leaflet/leaflet.js`, `leaflet/leaflet.css`, `leaflet/images/*`, `leaflet/LICENSE` |
| three.js (3D view only, loaded when the 3D tab opens) | 0.187.0 (released 2026-10-30) | MIT | https://registry.npmjs.org/three/-/three-0.187.0.tgz | `three/three.module.js`, `three/three.core.js` (from `build/`), `three/addons/...` (from `examples/jsm/`: controls `MapControls`, `OrbitControls`; renderers `CSS2DRenderer`; loaders `GLTFLoader`; environments `RoomEnvironment`; utils `BufferGeometryUtils`, `SkeletonUtils`, imported by `GLTFLoader`), `three/LICENSE` |

Preact licence text: the exact Preact version inside htm 3.1.1's bundle is not recorded
(htm's devDependency is `preact ^10.2.0`); `LICENSE.preact-MIT` is taken from npm package
`preact@10.6.4` (integrity verified). The Preact MIT text is the same in all 10.x releases.

three.js tarball: `dist.integrity` sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==,
sha256 `ff540832ded0cfe919764d24a3d88f3e2a05f23303f876423e4f893841e90728`. The addons import the bare
module name `'three'`, which needs an import map; an inline import map is blocked by the CSP, so the one
`from 'three';` of each addon was rewritten to the relative path of `three/three.module.js`
(`'../../three.module.js'`; this also works in module workers). Nothing else was changed:
`three.module.js`, `three.core.js` and `LICENSE` are byte for byte as published. The upstream sha256 of
the rewritten addons:

```
5a686152c498914389d1503b60121f484d06f15cb4f7405c15fb6b8ddcc1bdb6  examples/jsm/controls/MapControls.js
e7fca2fe9e7670a828af9b28084669a5909445b7f36f1f26cee9bf8f2961c32c  examples/jsm/controls/OrbitControls.js
256abfc6ae1aa20eb83c10d7a0e26534527df65872e4d52da6354bee78288c34  examples/jsm/renderers/CSS2DRenderer.js
532ac726e120039acbcd6cf54328c57acbf7b438176afaa6951257126d11bff1  examples/jsm/loaders/GLTFLoader.js
55f466192cc84298755a424c5e040345006b2ee1455589b3b54126c2ea4123f4  examples/jsm/environments/RoomEnvironment.js
7bda2a8ba836b2bcf67cb938d4b9e1bb5d1b1bc616817103ed858c0b58296ce7  examples/jsm/utils/BufferGeometryUtils.js
b1632a703206c3d830de9fcbe515696770d04b71a15ee6b50afa6d2c3298c86f  examples/jsm/utils/SkeletonUtils.js
```

## sha256

Of the files in this directory (LF line endings, as published).

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
8b378ebe60e2fe500158cb0ac71cb5e8b7d92953c2abcc63a0eb90499653b5bc  three/LICENSE
104f56145899722094556490d787aae0617cc2fc3382f31df02d724ea1aee341  three/three.module.js
613e370f76638fdef83926642bf256dc9615684922de1ce1f63a8583e5d78578  three/three.core.js
5fa2dd95d0812ed68dc0e1430a667ceedf115f02bf23c9d916fe9b647c39bceb  three/addons/controls/MapControls.js
ab8eee754d1c92e54353ef104827d63eb716ca5ebe33797702091b48fa847c39  three/addons/controls/OrbitControls.js
582f4da177a6594b64ab464ac66834cf0ecec82d5ff4ccaf39862533ff5181ac  three/addons/renderers/CSS2DRenderer.js
eedeafc3e90a360570045e72005333a2abde65f96bc332be1b05a19d0241460d  three/addons/loaders/GLTFLoader.js
dbc78a606724508ea6ddfb376b63689761cad07c49d879d0fa9c2ddc45c27dbc  three/addons/environments/RoomEnvironment.js
dba1b5dccc418f494eae6f1e731ec82734b2eaf3321b1db04c4321b16c1ea549  three/addons/utils/BufferGeometryUtils.js
28017bf37d0ecb0c4be6048db759ff14df729a562464830b064d4cc239c5af17  three/addons/utils/SkeletonUtils.js
```

## Licence policy

Only MIT, BSD, ISC or Apache-2.0 libraries may be added. The engine is under the
Artistic License 1.0; no GPL or LGPL code.
